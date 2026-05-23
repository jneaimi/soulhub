#!/usr/bin/env node
/**
 * Phase D tests — pre-merge worker validation.
 *
 * Tests validate happy + sad paths for skipRepair mode and the validator's
 * integration with the pipeline. Uses real filesystem + git sandboxes.
 *
 * Run: npx tsx tests/orchestration/worker-validator.test.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);

let passed = 0;
let failed = 0;

async function test(name, fn) {
	const start = Date.now();
	try {
		await fn();
		console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
		passed++;
	} catch (err) {
		console.log(`  ✗ ${name} (${Date.now() - start}ms)`);
		console.log(`    ${err.message}`);
		if (err.stack) console.log(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}`);
		failed++;
	}
}

function assert(cond, msg) {
	if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(actual, expected, msg) {
	if (actual !== expected) {
		throw new Error(`${msg || 'assertEq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

// Simulate a minimal Node project with a cited script
async function makeNodeRepo({ packageJson, files = {} }) {
	const dir = await mkdtemp(join(tmpdir(), 'worker-validate-'));
	await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
	await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
	await exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
	await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
	await writeFile(join(dir, 'package.json'), JSON.stringify(packageJson, null, 2));
	await writeFile(join(dir, '.gitignore'), 'node_modules\n');
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path);
		await mkdir(join(full, '..'), { recursive: true }).catch(() => {});
		await writeFile(full, content);
	}
	await exec('git', ['add', '-A'], { cwd: dir });
	await exec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
	return dir;
}

const pipeline = await import('../../src/lib/orchestration/post-merge-pipeline.ts');
const { runPostMergePipeline } = pipeline;

console.log('\n▶ skipRepair mode');

await test('happy: passing project → allPassed true, no cascade invoked', async () => {
	const dir = await makeNodeRepo({
		packageJson: {
			name: 'ok',
			scripts: { build: 'echo ok' },
		},
	});
	try {
		const { allPassed, results } = await runPostMergePipeline(
			'test-run',
			dir,
			() => {},
			{ skipRepair: true },
		);
		assertEq(allPassed, true, 'should pass');
		const build = results.find((r) => r.id === 'build');
		assertEq(build?.status, 'passed', 'build passed');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('sad: failing blocking step → allPassed false, NO fixCommit, NO repairAttempts', async () => {
	const dir = await makeNodeRepo({
		packageJson: {
			name: 'fail',
			scripts: { build: 'exit 1' },
		},
	});
	try {
		const { allPassed, results } = await runPostMergePipeline(
			'test-run',
			dir,
			() => {},
			{ skipRepair: true },
		);
		assertEq(allPassed, false, 'should fail');
		const build = results.find((r) => r.id === 'build');
		assertEq(build?.status, 'failed', 'build failed');
		assertEq(build?.fixCommit, undefined, 'no fix commit written');
		assertEq(build?.repairAttempts, undefined, 'cascade NOT invoked');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('happy: skipRepair does NOT create commits or modify tracked files', async () => {
	const dir = await makeNodeRepo({
		packageJson: {
			name: 'fail',
			scripts: { build: 'exit 1' },
		},
	});
	try {
		const headBefore = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
		await runPostMergePipeline('test-run', dir, () => {}, { skipRepair: true });
		const headAfter = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
		assertEq(headAfter, headBefore, 'HEAD should not move — no fix commits written');
		// Tracked files must be untouched. Install may create untracked files
		// (package-lock.json etc) which is normal and not a mutation concern.
		const { stdout: modified } = await exec('git', ['diff', '--name-only'], { cwd: dir });
		assertEq(modified.trim(), '', 'no tracked files modified by validation');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('sad: advisory failure (lint) is non-fatal and reported', async () => {
	const dir = await makeNodeRepo({
		packageJson: {
			name: 'advisory',
			scripts: { lint: 'exit 1', build: 'echo ok' },
		},
	});
	try {
		const { allPassed, results } = await runPostMergePipeline(
			'test-run',
			dir,
			() => {},
			{ skipRepair: true },
		);
		const lint = results.find((r) => r.id === 'lint');
		const build = results.find((r) => r.id === 'build');
		assertEq(lint?.status, 'failed', 'lint failed');
		assertEq(build?.status, 'passed', 'build still runs and passes');
		// allPassed treats advisory failures as non-blocking
		assertEq(allPassed, true, 'advisory failure does not block overall pass');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('happy: skipped steps do not affect allPassed', async () => {
	const dir = await makeNodeRepo({
		packageJson: {
			name: 'minimal',
			// No build script, no tsconfig → most steps skip
			scripts: {},
		},
	});
	try {
		const { allPassed, results } = await runPostMergePipeline(
			'test-run',
			dir,
			() => {},
			{ skipRepair: true },
		);
		// Install will run (needs no lockfile), typecheck/lint/test/build should skip
		assertEq(allPassed, true, 'skips should not fail the pipeline');
		const skipped = results.filter((r) => r.status === 'skipped').map((r) => r.id);
		assert(skipped.includes('typecheck'), 'typecheck skipped (no tsconfig)');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
