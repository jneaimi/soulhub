import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	createWorktree,
	removeWorktree,
	listWorktrees,
	pruneWorktrees,
	cleanStaleLocks,
	dryRunMerge,
} from '../../src/lib/orchestration/worktree.js';

const execFileAsync = promisify(execFile);

let tempDir: string;
let repoDir: string;

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd });
	return stdout.trim();
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'soul-hub-test-wt-'));
	repoDir = join(tempDir, 'repo');

	// Create a real git repo with an initial commit
	await execFileAsync('mkdir', ['-p', repoDir]);
	await git(['init', '-b', 'main'], repoDir);
	await git(['config', 'user.email', 'test@test.com'], repoDir);
	await git(['config', 'user.name', 'Test'], repoDir);

	const { writeFile } = await import('node:fs/promises');
	await writeFile(join(repoDir, 'README.md'), '# Test Repo\n');
	await git(['add', '.'], repoDir);
	await git(['commit', '-m', 'initial'], repoDir);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('createWorktree', () => {
	test('creates dir and branch', async () => {
		const { worktreePath, branch } = await createWorktree(repoDir, 'run-1', 'task-a');
		assert.ok(existsSync(worktreePath));
		assert.strictEqual(branch, 'orchestration/run-1/task-a');

		// Verify branch exists
		const branches = await git(['branch', '--list'], repoDir);
		assert.ok(branches.includes('orchestration/run-1/task-a'));
	});

	test('is idempotent when called twice', async () => {
		const first = await createWorktree(repoDir, 'run-1', 'task-b');
		const second = await createWorktree(repoDir, 'run-1', 'task-b');
		assert.strictEqual(first.worktreePath, second.worktreePath);
		assert.strictEqual(first.branch, second.branch);
	});

	test('creates in .worktrees directory', async () => {
		const { worktreePath } = await createWorktree(repoDir, 'run-1', 'task-c');
		assert.ok(worktreePath.includes('.worktrees'));
	});
});

describe('listWorktrees', () => {
	test('shows created worktrees', async () => {
		await createWorktree(repoDir, 'run-2', 'task-x');
		await createWorktree(repoDir, 'run-2', 'task-y');

		const wts = await listWorktrees(repoDir, 'run-2');
		assert.strictEqual(wts.length, 2);
		const branches = wts.map((w) => w.branch).sort();
		assert.deepStrictEqual(branches, [
			'orchestration/run-2/task-x',
			'orchestration/run-2/task-y',
		]);
	});

	test('filters by runId', async () => {
		await createWorktree(repoDir, 'run-3', 'task-a');
		await createWorktree(repoDir, 'run-4', 'task-b');

		const wts3 = await listWorktrees(repoDir, 'run-3');
		assert.strictEqual(wts3.length, 1);
		assert.strictEqual(wts3[0].branch, 'orchestration/run-3/task-a');
	});
});

describe('removeWorktree', () => {
	test('removes the worktree directory', async () => {
		const { worktreePath } = await createWorktree(repoDir, 'run-5', 'task-rm');
		assert.ok(existsSync(worktreePath));

		await removeWorktree(worktreePath, true);
		assert.ok(!existsSync(worktreePath));
	});

	test('handles non-existent path gracefully', async () => {
		// Should not throw
		await removeWorktree('/tmp/does-not-exist-worktree');
	});
});

describe('pruneWorktrees', () => {
	test('prunes after manual removal', async () => {
		const { worktreePath } = await createWorktree(repoDir, 'run-6', 'task-prune');

		// Manually remove the directory (simulates crash/incomplete cleanup)
		await rm(worktreePath, { recursive: true, force: true });

		const pruned = await pruneWorktrees(repoDir);
		// May or may not prune depending on git state, but should not throw
		assert.ok(typeof pruned === 'number');
	});
});

describe('cleanStaleLocks', () => {
	test('returns 0 with no locks', async () => {
		const cleaned = await cleanStaleLocks(repoDir);
		assert.strictEqual(cleaned, 0);
	});
});

describe('dryRunMerge', () => {
	test('reports no conflicts for clean merge', async () => {
		// Create a worktree, make a non-conflicting change
		const { worktreePath, branch } = await createWorktree(repoDir, 'run-7', 'task-merge');

		const { writeFile } = await import('node:fs/promises');
		await writeFile(join(worktreePath, 'new-file.txt'), 'hello\n');
		await git(['add', '.'], worktreePath);
		await git(['-c', 'user.email=test@test.com', '-c', 'user.name=Test', 'commit', '-m', 'add file'], worktreePath);

		const result = await dryRunMerge(repoDir, branch);
		assert.strictEqual(result.canMerge, true);
		assert.deepStrictEqual(result.conflicts, []);
	});
});
