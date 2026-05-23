import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let tempDir: string;
let repoDir: string;

// These tests run conductor functions via subprocess with:
// - HOME set to tempDir (so board.ts writes to tempDir/.soul-hub/orchestration)
// - A real git repo at repoDir
// - The $lib loader registered so conductor.ts can import $lib/pty/manager.js

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd });
	return stdout.trim();
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'soul-hub-test-cond-'));
	repoDir = join(tempDir, 'repo');
	await execFileAsync('mkdir', ['-p', repoDir]);
	await git(['init', '-b', 'main'], repoDir);
	await git(['config', 'user.email', 'test@test.com'], repoDir);
	await git(['config', 'user.name', 'Test'], repoDir);
	await writeFile(join(repoDir, 'README.md'), '# Test\n');
	await git(['add', '.'], repoDir);
	await git(['commit', '-m', 'initial'], repoDir);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

async function runConductorScript(script: string): Promise<string> {
	const wrapped = `(async()=>{${script}})()`;
	const { stdout } = await execFileAsync(
		'npx',
		['tsx', '--import', './tests/orchestration/register.mjs', '-e', wrapped],
		{
			cwd: join(import.meta.dirname, '../..'),
			env: { ...process.env, HOME: tempDir },
			maxBuffer: 2 * 1024 * 1024,
		},
	);
	// conductor.ts log() writes to stdout — take only the last non-empty line
	const lines = stdout.trim().split('\n').filter(Boolean);
	return lines[lines.length - 1] ?? '';
}

describe('conductor — createRun', () => {
	test('returns run with status planning', async () => {
		const result = await runConductorScript(`
			const { createRun } = await import('./src/lib/orchestration/conductor.js');
			const run = await createRun('test-project', '${repoDir}', 'Build auth system');
			console.log(JSON.stringify({ status: run.status, goal: run.plan.goal, hasRunId: !!run.runId }));
		`);
		const data = JSON.parse(result);
		assert.strictEqual(data.status, 'planning');
		assert.strictEqual(data.goal, 'Build auth system');
		assert.strictEqual(data.hasRunId, true);
	});

	test('throws with non-existent project path', async () => {
		const result = await runConductorScript(`
			const { createRun } = await import('./src/lib/orchestration/conductor.js');
			try {
				await createRun('test', '/tmp/no-such-dir-xyz', 'goal');
				console.log('no-error');
			} catch (e) {
				console.log('error:' + e.message);
			}
		`);
		assert.ok(result.startsWith('error:'));
	});
});

describe('conductor — setPlan', () => {
	test('updates run with plan', async () => {
		const plan = {
			goal: 'Build auth',
			tasks: [
				{
					id: 'task-1',
					name: 'Auth API',
					description: 'Build auth endpoints',
					prompt: 'Build the auth API',
					provider: 'claude-code',
					dependsOn: [],
					fileOwnership: ['src/auth'],
					maxIterations: 8,
				},
			],
			createdAt: '2026-01-01T00:00:00Z',
		};

		const result = await runConductorScript(`
			const { createRun, setPlan } = await import('./src/lib/orchestration/conductor.js');
			const run = await createRun('test', '${repoDir}', 'Build auth');
			const updated = await setPlan(run.runId, ${JSON.stringify(plan)});
			console.log(JSON.stringify({ tasks: updated.plan.tasks.length }));
		`);
		assert.deepStrictEqual(JSON.parse(result), { tasks: 1 });
	});

	test('throws on non-existent run', async () => {
		const result = await runConductorScript(`
			const { setPlan } = await import('./src/lib/orchestration/conductor.js');
			try {
				await setPlan('no-such-run', { goal: 'x', tasks: [], createdAt: '' });
				console.log('no-error');
			} catch (e) {
				console.log('error:' + e.message);
			}
		`);
		assert.ok(result.startsWith('error:'));
	});

	test('detects circular dependencies', async () => {
		const plan = {
			goal: 'cycle',
			tasks: [
				{ id: 'a', name: 'A', description: '', prompt: '', provider: 'shell', dependsOn: ['b'], fileOwnership: [], maxIterations: 8 },
				{ id: 'b', name: 'B', description: '', prompt: '', provider: 'shell', dependsOn: ['a'], fileOwnership: [], maxIterations: 8 },
			],
			createdAt: '',
		};

		const result = await runConductorScript(`
			const { createRun, setPlan } = await import('./src/lib/orchestration/conductor.js');
			const run = await createRun('test', '${repoDir}', 'cycle');
			try {
				await setPlan(run.runId, ${JSON.stringify(plan)});
				console.log('no-error');
			} catch (e) {
				console.log('error:' + e.message);
			}
		`);
		assert.ok(result.includes('Circular'));
	});
});

describe('conductor — getRunState', () => {
	test('returns current state', async () => {
		const result = await runConductorScript(`
			const { createRun, getRunState } = await import('./src/lib/orchestration/conductor.js');
			const run = await createRun('test', '${repoDir}', 'state test');
			const state = await getRunState(run.runId);
			console.log(JSON.stringify({ exists: !!state, status: state?.status }));
		`);
		assert.deepStrictEqual(JSON.parse(result), { exists: true, status: 'planning' });
	});
});

describe('conductor — cancelRun', () => {
	test('cancels a planning run', async () => {
		const result = await runConductorScript(`
			const { createRun, cancelRun, getRunState } = await import('./src/lib/orchestration/conductor.js');
			const run = await createRun('test', '${repoDir}', 'cancel test');
			await cancelRun(run.runId);
			const state = await getRunState(run.runId);
			console.log(JSON.stringify({ status: state?.status }));
		`);
		assert.deepStrictEqual(JSON.parse(result), { status: 'cancelled' });
	});

	test('is idempotent on already-cancelled run', async () => {
		const result = await runConductorScript(`
			const { createRun, cancelRun, getRunState } = await import('./src/lib/orchestration/conductor.js');
			const run = await createRun('test', '${repoDir}', 'cancel twice');
			await cancelRun(run.runId);
			await cancelRun(run.runId);
			const state = await getRunState(run.runId);
			console.log(JSON.stringify({ status: state?.status }));
		`);
		assert.deepStrictEqual(JSON.parse(result), { status: 'cancelled' });
	});
});

describe('conductor — approveAndStart', () => {
	test('throws with no plan tasks', async () => {
		const result = await runConductorScript(`
			const { createRun, approveAndStart } = await import('./src/lib/orchestration/conductor.js');
			const run = await createRun('test', '${repoDir}', 'empty plan');
			try {
				await approveAndStart(run.runId);
				console.log('no-error');
			} catch (e) {
				console.log('error:' + e.message);
			}
		`);
		assert.ok(result.includes('error:'));
		assert.ok(result.includes('no tasks'));
	});
});

describe('conductor — interveneAsync', () => {
	test('returns false on non-existent run', async () => {
		const result = await runConductorScript(`
			const { interveneAsync } = await import('./src/lib/orchestration/conductor.js');
			const ok = await interveneAsync('no-run', 'no-task', 'hello');
			console.log(JSON.stringify(ok));
		`);
		assert.strictEqual(result, 'false');
	});
});

describe('conductor — killWorkerAsync', () => {
	test('returns false on non-existent run', async () => {
		const result = await runConductorScript(`
			const { killWorkerAsync } = await import('./src/lib/orchestration/conductor.js');
			const ok = await killWorkerAsync('no-run', 'no-task');
			console.log(JSON.stringify(ok));
		`);
		assert.strictEqual(result, 'false');
	});
});
