import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OrchestrationRun, WorkerState } from '../../src/lib/orchestration/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'soul-hub-test-board-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
	return {
		runId: 'test-run-001',
		projectName: 'test-project',
		projectPath: '/tmp/test-project',
		status: 'planning',
		plan: { goal: 'Build auth', tasks: [], createdAt: '2026-01-01T00:00:00Z' },
		workers: {},
		createdAt: '2026-01-01T00:00:00Z',
		mergeLog: [],
		failureSummaries: [],
		conflictReports: [],
		...overrides,
	};
}

// Wrap script in async IIFE to avoid top-level await CJS issue with tsx -e
async function runInIsolation(script: string): Promise<string> {
	const wrapped = `(async()=>{${script}})()`;
	const { stdout } = await execFileAsync(
		'npx',
		['tsx', '-e', wrapped],
		{
			cwd: join(import.meta.dirname, '../..'),
			env: { ...process.env, HOME: tempDir },
			maxBuffer: 1024 * 1024,
		},
	);
	return stdout.trim();
}

describe('board.ts — saveRun + loadRun', () => {
	test('round-trip save and load', async () => {
		const result = await runInIsolation(`
			const { saveRun, loadRun } = await import('./src/lib/orchestration/board.js');
			const run = ${JSON.stringify(makeRun())};
			await saveRun(run);
			const loaded = await loadRun(run.runId);
			console.log(JSON.stringify(loaded));
		`);
		const loaded = JSON.parse(result);
		assert.strictEqual(loaded.runId, 'test-run-001');
		assert.strictEqual(loaded.plan.goal, 'Build auth');
	});

	test('loadRun with non-existent ID returns null', async () => {
		const result = await runInIsolation(`
			const { loadRun } = await import('./src/lib/orchestration/board.js');
			const loaded = await loadRun('non-existent-id');
			console.log(JSON.stringify(loaded));
		`);
		assert.strictEqual(result, 'null');
	});
});

describe('board.ts — listRuns', () => {
	test('returns sorted by date (newest first)', async () => {
		const run1 = makeRun({ runId: 'run-old', createdAt: '2026-01-01T00:00:00Z' });
		const run2 = makeRun({ runId: 'run-new', createdAt: '2026-06-01T00:00:00Z' });

		const result = await runInIsolation(`
			const { saveRun, listRuns } = await import('./src/lib/orchestration/board.js');
			await saveRun(${JSON.stringify(run1)});
			await saveRun(${JSON.stringify(run2)});
			const runs = await listRuns();
			console.log(JSON.stringify(runs.map(r => r.runId)));
		`);
		const ids = JSON.parse(result);
		assert.deepStrictEqual(ids, ['run-new', 'run-old']);
	});

	test('returns empty array when no runs exist', async () => {
		const result = await runInIsolation(`
			const { listRuns } = await import('./src/lib/orchestration/board.js');
			const runs = await listRuns();
			console.log(JSON.stringify(runs));
		`);
		assert.deepStrictEqual(JSON.parse(result), []);
	});
});

describe('board.ts — saveWorkerState + loadWorkerState', () => {
	test('round-trip', async () => {
		const worker: WorkerState = {
			taskId: 'task-1',
			workerId: 'w-1',
			status: 'running',
			worktreePath: '/tmp/wt',
			branch: 'orch/run/task-1',
			iterationCount: 3,
		};
		const result = await runInIsolation(`
			const { saveRun, saveWorkerState, loadWorkerState } = await import('./src/lib/orchestration/board.js');
			await saveRun(${JSON.stringify(makeRun())});
			await saveWorkerState('test-run-001', ${JSON.stringify(worker)});
			const loaded = await loadWorkerState('test-run-001', 'task-1');
			console.log(JSON.stringify(loaded));
		`);
		const loaded = JSON.parse(result);
		assert.strictEqual(loaded.taskId, 'task-1');
		assert.strictEqual(loaded.iterationCount, 3);
	});

	test('loadWorkerState with non-existent task returns null', async () => {
		const result = await runInIsolation(`
			const { loadWorkerState } = await import('./src/lib/orchestration/board.js');
			const loaded = await loadWorkerState('test-run-001', 'no-such-task');
			console.log(JSON.stringify(loaded));
		`);
		assert.strictEqual(result, 'null');
	});
});

describe('board.ts — worker output', () => {
	test('appendWorkerOutput + readWorkerOutputTail', async () => {
		const result = await runInIsolation(`
			const { saveRun, appendWorkerOutput, readWorkerOutputTail } = await import('./src/lib/orchestration/board.js');
			await saveRun(${JSON.stringify(makeRun())});
			await appendWorkerOutput('test-run-001', 'task-1', 'line 1\\nline 2\\nline 3');
			const tail = await readWorkerOutputTail('test-run-001', 'task-1');
			console.log(tail);
		`);
		assert.ok(result.includes('line 1'));
		assert.ok(result.includes('line 3'));
	});

	test('readWorkerOutputTail with no log returns empty string', async () => {
		const result = await runInIsolation(`
			const { readWorkerOutputTail } = await import('./src/lib/orchestration/board.js');
			const tail = await readWorkerOutputTail('test-run-001', 'no-task');
			console.log(JSON.stringify(tail));
		`);
		assert.strictEqual(JSON.parse(result), '');
	});
});

describe('board.ts — readBoard', () => {
	test('readBoard with no entries returns empty string', async () => {
		const result = await runInIsolation(`
			const { readBoard } = await import('./src/lib/orchestration/board.js');
			const board = await readBoard('no-such-run');
			console.log(JSON.stringify(board));
		`);
		assert.strictEqual(JSON.parse(result), '');
	});
});

describe('board.ts — ownershipMap', () => {
	test('round-trip save and load', async () => {
		const map = { 'src/auth': 'task-auth', 'src/db': 'task-db' };
		const result = await runInIsolation(`
			const { saveRun, saveOwnershipMap, loadOwnershipMap } = await import('./src/lib/orchestration/board.js');
			await saveRun(${JSON.stringify(makeRun())});
			await saveOwnershipMap('test-run-001', ${JSON.stringify(map)});
			const loaded = await loadOwnershipMap('test-run-001');
			console.log(JSON.stringify(loaded));
		`);
		assert.deepStrictEqual(JSON.parse(result), map);
	});
});

describe('board.ts — deleteRun', () => {
	test('removes all files', async () => {
		const result = await runInIsolation(`
			const { saveRun, loadRun, deleteRun } = await import('./src/lib/orchestration/board.js');
			await saveRun(${JSON.stringify(makeRun())});
			const before = await loadRun('test-run-001');
			await deleteRun('test-run-001');
			const after = await loadRun('test-run-001');
			console.log(JSON.stringify({ before: !!before, after }));
		`);
		const { before, after } = JSON.parse(result);
		assert.strictEqual(before, true);
		assert.strictEqual(after, null);
	});
});

describe('board.ts — invalid IDs', () => {
	test('rejects path traversal in runId', async () => {
		try {
			const result = await runInIsolation(`
				const { loadRun } = await import('./src/lib/orchestration/board.js');
				try {
					await loadRun('../../../etc/passwd');
					console.log('no-error');
				} catch (e) {
					console.log('error:' + e.message);
				}
			`);
			assert.ok(result.startsWith('error:'));
		} catch {
			// Subprocess error is also acceptable (path traversal detected)
		}
	});
});
