import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	checkIterationLimit,
	getReflectionPrompt,
	validateFileOwnership,
	canSpawnWorker,
	MAX_ITERATIONS,
	MAX_WORKERS,
} from '../../src/lib/orchestration/guards.js';
import type { WorkerState } from '../../src/lib/orchestration/types.js';

function makeWorker(overrides: Partial<WorkerState> & { maxIterations?: number } = {}): WorkerState & { maxIterations: number } {
	return {
		taskId: 'task-1',
		workerId: 'w-1',
		status: 'running',
		worktreePath: '/tmp/wt',
		branch: 'orch/run-1/task-1',
		iterationCount: 0,
		maxIterations: MAX_ITERATIONS,
		...overrides,
	};
}

describe('checkIterationLimit', () => {
	test('returns false when under limit', () => {
		const w = makeWorker({ iterationCount: 3, maxIterations: 8 });
		assert.strictEqual(checkIterationLimit(w), false);
	});

	test('returns true when at limit', () => {
		const w = makeWorker({ iterationCount: 8, maxIterations: 8 });
		assert.strictEqual(checkIterationLimit(w), true);
	});

	test('returns true when over limit', () => {
		const w = makeWorker({ iterationCount: 10, maxIterations: 8 });
		assert.strictEqual(checkIterationLimit(w), true);
	});

	test('returns false with 0 iterations', () => {
		const w = makeWorker({ iterationCount: 0 });
		assert.strictEqual(checkIterationLimit(w), false);
	});

	test('respects MAX_ITERATIONS cap', () => {
		const w = makeWorker({ iterationCount: MAX_ITERATIONS, maxIterations: 100 });
		assert.strictEqual(checkIterationLimit(w), true);
	});
});

describe('getReflectionPrompt', () => {
	test('contains iteration count', () => {
		const prompt = getReflectionPrompt('Auth API', 6, 8);
		assert.ok(prompt.includes('6/8'));
		assert.ok(prompt.includes('Auth API'));
	});

	test('contains remaining iterations', () => {
		const prompt = getReflectionPrompt('DB Schema', 5, 8);
		assert.ok(prompt.includes('3'));
	});
});

describe('validateFileOwnership', () => {
	const ownershipMap: Record<string, string> = {
		'src/auth': 'task-auth',
		'src/db/schema.ts': 'task-db',
	};

	test('allows owned file (exact match)', () => {
		const result = validateFileOwnership(ownershipMap, 'src/db/schema.ts', 'task-db');
		assert.deepStrictEqual(result, { allowed: true });
	});

	test('allows owned directory (prefix match)', () => {
		const result = validateFileOwnership(ownershipMap, 'src/auth/login.ts', 'task-auth');
		assert.deepStrictEqual(result, { allowed: true });
	});

	test('rejects file owned by another task', () => {
		const result = validateFileOwnership(ownershipMap, 'src/auth/login.ts', 'task-db');
		assert.strictEqual(result.allowed, false);
		assert.strictEqual(result.owner, 'task-auth');
	});

	test('allows unclaimed file', () => {
		const result = validateFileOwnership(ownershipMap, 'src/utils/helpers.ts', 'task-auth');
		assert.deepStrictEqual(result, { allowed: true });
	});

	test('allows file with empty ownership map', () => {
		const result = validateFileOwnership({}, 'src/anything.ts', 'task-1');
		assert.deepStrictEqual(result, { allowed: true });
	});

	test('normalizes backslashes', () => {
		const result = validateFileOwnership(ownershipMap, 'src\\auth\\login.ts', 'task-auth');
		assert.deepStrictEqual(result, { allowed: true });
	});
});

describe('canSpawnWorker', () => {
	test('returns true when under limit', () => {
		assert.strictEqual(canSpawnWorker(2), true);
	});

	test('returns false at limit', () => {
		assert.strictEqual(canSpawnWorker(MAX_WORKERS), false);
	});

	test('returns false over limit', () => {
		assert.strictEqual(canSpawnWorker(MAX_WORKERS + 1), false);
	});

	test('respects custom max', () => {
		assert.strictEqual(canSpawnWorker(2, 2), false);
		assert.strictEqual(canSpawnWorker(1, 2), true);
	});

	test('returns true with 0 workers', () => {
		assert.strictEqual(canSpawnWorker(0), true);
	});
});
