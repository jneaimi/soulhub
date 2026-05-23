#!/usr/bin/env node
/**
 * Unit tests for post-merge repair strategies.
 *
 * Runs with plain node (no test framework). Each test creates a tmp git repo,
 * exercises one strategy, and asserts outcome. Happy + sad paths included.
 *
 * Run: node tests/orchestration/post-merge-strategies.test.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);

// ─── Test framework ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
	const start = Date.now();
	try {
		await fn();
		const dur = Date.now() - start;
		results.push({ name, outcome: 'PASS', dur });
		console.log(`  ✓ ${name} (${dur}ms)`);
		passed++;
	} catch (err) {
		const dur = Date.now() - start;
		results.push({ name, outcome: 'FAIL', dur, err: err.message });
		console.log(`  ✗ ${name} (${dur}ms)`);
		console.log(`    ${err.message}`);
		if (err.stack) console.log(`    ${err.stack.split('\n').slice(1, 4).join('\n    ')}`);
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

// ─── Helpers ───────────────────────────────────────────────────────────────

async function makeRepo(opts = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'soul-hub-test-'));
	await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
	await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
	await exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
	await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
	if (opts.pkg) await writeFile(join(dir, 'package.json'), JSON.stringify(opts.pkg, null, 2));
	await writeFile(join(dir, '.gitignore'), 'node_modules\n.svelte-kit\ndist\n');
	await exec('git', ['add', '-A'], { cwd: dir });
	await exec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
	return dir;
}

async function headHash(cwd) {
	const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
	return stdout.trim();
}

// Dynamic import of the strategies module
const stratsMod = await import('../../src/lib/orchestration/post-merge-strategies.ts').catch(
	async () => {
		// Fallback: import the built JS if TS import fails
		return await import('../../build/server/chunks/_server.ts-DgWmAA5A.js').catch(() => null);
	},
);

if (!stratsMod || !stratsMod.__test__) {
	console.error('Could not import strategies. Run `npm run build` first.');
	process.exit(2);
}

const { cleanRebuild, reinstallDeps, formatterAutofix, cleanMergeArtifacts, isLockfileOnlyFix } =
	stratsMod.__test__;

const { extractCitedFiles } = stratsMod;

// ─── Tests ─────────────────────────────────────────────────────────────────

console.log('\n▶ extractCitedFiles');

await test('happy: extracts TS path with [slug] and +server.ts', () => {
	const out = 'src/routes/api/qr/[slug]/+server.ts(86,22): error TS2345';
	const files = extractCitedFiles(out);
	assertEq(files.length, 1, 'one file matched');
	assertEq(files[0], 'src/routes/api/qr/[slug]/+server.ts', 'correct path');
});

await test('happy: extracts multiple cited files', () => {
	const out = `src/a.ts:1:1 error\nsrc/b.svelte:2:2 error\nlib/c.py:3:3 error`;
	const files = extractCitedFiles(out);
	assertEq(files.length, 3, 'three files');
});

await test('sad: skips node_modules paths', () => {
	const out = 'node_modules/foo/index.ts(1,1): error';
	const files = extractCitedFiles(out);
	assertEq(files.length, 0, 'no files after filter');
});

await test('sad: returns empty on no match', () => {
	assertEq(extractCitedFiles('').length, 0);
	assertEq(extractCitedFiles('some random output').length, 0);
});

console.log('\n▶ canHandle predicates');

await test('reinstallDeps.canHandle: matches Cannot find module', () => {
	assert(
		reinstallDeps.canHandle({
			stepId: 'typecheck',
			stepName: 'Type check',
			output: "Cannot find module '@sveltejs/adapter-node'",
			citedFiles: [],
		}),
		'should handle',
	);
});

await test('reinstallDeps.canHandle: ignores unrelated errors', () => {
	assert(
		!reinstallDeps.canHandle({
			stepId: 'typecheck',
			stepName: 'Type check',
			output: 'TS2345: Buffer not assignable to BodyInit',
			citedFiles: ['src/foo.ts'],
		}),
		'should not handle',
	);
});

await test('cleanRebuild.canHandle: matches build step', () => {
	assert(
		cleanRebuild.canHandle({
			stepId: 'build',
			stepName: 'Build',
			output: 'some build error',
			citedFiles: [],
		}),
	);
});

await test('formatterAutofix.canHandle: requires lint step + cited files', () => {
	assert(
		formatterAutofix.canHandle({
			stepId: 'lint',
			stepName: 'Lint',
			output: 'error in src/foo.ts',
			citedFiles: ['src/foo.ts'],
		}),
	);
	assert(
		!formatterAutofix.canHandle({
			stepId: 'lint',
			stepName: 'Lint',
			output: 'no files cited',
			citedFiles: [],
		}),
		'empty cited files should skip',
	);
});

console.log('\n▶ reinstallDeps security gate');

await test('sad: refuses to install package NOT in package.json', async () => {
	const dir = await makeRepo({
		pkg: { name: 'test', dependencies: { express: '1.0.0' } },
	});
	try {
		const action = await reinstallDeps.attempt(
			{ runId: 't', projectPath: dir, log: () => {} },
			{
				stepId: 'typecheck',
				stepName: 'Type check',
				output: "Cannot find module 'evil-typo-package'",
				citedFiles: [],
			},
		);
		assertEq(action.took, 'no-action', 'should refuse unknown package');
		assert(action.notes.includes('not declared'), 'notes mention not-declared');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('sad: refuses when error message has no module name', async () => {
	const dir = await makeRepo({ pkg: { name: 'test' } });
	try {
		const action = await reinstallDeps.attempt(
			{ runId: 't', projectPath: dir, log: () => {} },
			{ stepId: 'typecheck', stepName: 'Type check', output: 'random error', citedFiles: [] },
		);
		assertEq(action.took, 'no-action');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

console.log('\n▶ cleanRebuild safety');

await test('happy: wipes only allow-listed cache dirs', async () => {
	const dir = await makeRepo();
	try {
		// Create allow-listed and non-allowlisted dirs
		await mkdir(join(dir, '.svelte-kit'), { recursive: true });
		await mkdir(join(dir, 'dist'), { recursive: true });
		await mkdir(join(dir, 'src'), { recursive: true });
		await writeFile(join(dir, 'src/keep.ts'), 'export {}');

		const action = await cleanRebuild.attempt(
			{ runId: 't', projectPath: dir, log: () => {} },
			{ stepId: 'build', stepName: 'Build', output: '', citedFiles: [] },
		);
		assertEq(action.took, 'applied');
		assert(!existsSync(join(dir, '.svelte-kit')), '.svelte-kit wiped');
		assert(!existsSync(join(dir, 'dist')), 'dist wiped');
		assert(existsSync(join(dir, 'src/keep.ts')), 'src untouched');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('sad: no-action when no caches exist', async () => {
	const dir = await makeRepo();
	try {
		const action = await cleanRebuild.attempt(
			{ runId: 't', projectPath: dir, log: () => {} },
			{ stepId: 'build', stepName: 'Build', output: '', citedFiles: [] },
		);
		assertEq(action.took, 'no-action');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

console.log('\n▶ cleanMergeArtifacts');

await test('happy: removes stale MERGE_HEAD', async () => {
	const dir = await makeRepo();
	try {
		await writeFile(join(dir, '.git/MERGE_HEAD'), 'stale');
		const action = await cleanMergeArtifacts.attempt(
			{ runId: 't', projectPath: dir, log: () => {} },
			{ stepId: 'build', stepName: 'Build', output: '', citedFiles: [] },
		);
		assertEq(action.took, 'applied');
		assert(!existsSync(join(dir, '.git/MERGE_HEAD')), 'MERGE_HEAD removed');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('sad: no-action on clean tree', async () => {
	const dir = await makeRepo();
	try {
		const action = await cleanMergeArtifacts.attempt(
			{ runId: 't', projectPath: dir, log: () => {} },
			{ stepId: 'build', stepName: 'Build', output: '', citedFiles: [] },
		);
		assertEq(action.took, 'no-action');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

console.log('\n▶ isLockfileOnlyFix');

await test('happy: detects lockfile-only commit', async () => {
	const dir = await makeRepo();
	try {
		await writeFile(join(dir, 'package-lock.json'), '{}');
		await exec('git', ['add', 'package-lock.json'], { cwd: dir });
		await exec('git', ['commit', '-q', '-m', 'lockfile only'], { cwd: dir });
		const head = await headHash(dir);
		assertEq(await isLockfileOnlyFix(dir, head), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('sad: returns false for source-code commit', async () => {
	const dir = await makeRepo();
	try {
		await writeFile(join(dir, 'foo.ts'), 'export const x = 1');
		await exec('git', ['add', 'foo.ts'], { cwd: dir });
		await exec('git', ['commit', '-q', '-m', 'source'], { cwd: dir });
		const head = await headHash(dir);
		assertEq(await isLockfileOnlyFix(dir, head), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

await test('sad: returns false for mixed commit', async () => {
	const dir = await makeRepo();
	try {
		await writeFile(join(dir, 'foo.ts'), 'export const x = 1');
		await writeFile(join(dir, 'package-lock.json'), '{}');
		await exec('git', ['add', '-A'], { cwd: dir });
		await exec('git', ['commit', '-q', '-m', 'mixed'], { cwd: dir });
		const head = await headHash(dir);
		assertEq(await isLockfileOnlyFix(dir, head), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
