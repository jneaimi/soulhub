import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, unlink, stat, readFile, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
	path: string;
	branch: string;
	isLocked: boolean;
}

const ID_RE = /^[\w-]+$/;

function validateId(id: string): void {
	if (!ID_RE.test(id)) {
		throw new Error(`Invalid ID: ${id}`);
	}
}

// ── Git mutex ────────────────────────────────────────────────────
// Serializes git operations that touch shared state (.git/config.lock, packed-refs)

let gitMutexPromise: Promise<void> = Promise.resolve();

function withGitMutex<T>(fn: () => Promise<T>): Promise<T> {
	const prev = gitMutexPromise;
	let resolve: () => void;
	gitMutexPromise = new Promise<void>((r) => { resolve = r; });

	return prev.then(fn).finally(() => resolve!());
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

// ── Worktree lifecycle ───────────────────────────────────────────

export async function createWorktree(
	projectPath: string,
	runId: string,
	taskId: string,
): Promise<{ worktreePath: string; branch: string }> {
	validateId(runId);
	validateId(taskId);

	const worktreeDir = join(projectPath, '.worktrees');
	await mkdir(worktreeDir, { recursive: true });

	// Ensure .worktrees is in .gitignore so worktree dirs are never committed
	try {
		const gitignorePath = join(projectPath, '.gitignore');
		const content = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf-8') : '';
		if (!content.includes('.worktrees')) {
			await appendFile(gitignorePath, '\n.worktrees/\n');
		}
	} catch { /* best effort */ }

	const worktreePath = join(worktreeDir, `${runId}-${taskId}`);
	const branch = `orchestration/${runId}/${taskId}`;

	return withGitMutex(async () => {
		// Ensure main branch has at least one commit (worktrees need a base)
		try {
			await git(['rev-parse', 'HEAD'], projectPath);
		} catch {
			// No commits yet — create an initial commit so worktree branches have a base
			await git(['add', '-A'], projectPath);
			await git(['commit', '--allow-empty', '-m', 'initial commit'], projectPath);
		}

		// Check if branch already exists
		try {
			await git(['rev-parse', '--verify', branch], projectPath);
			// Branch exists — check if worktree already exists too
			if (existsSync(worktreePath)) {
				return { worktreePath, branch };
			}
			// Branch exists but worktree doesn't — create worktree on existing branch
			await git(['worktree', 'add', '--lock', worktreePath, branch], projectPath);
		} catch {
			// Branch doesn't exist — create new worktree with new branch from HEAD
			await git(['worktree', 'add', '--lock', '-b', branch, worktreePath, 'HEAD'], projectPath);
		}

		return { worktreePath, branch };
	});
}

export async function removeWorktree(worktreePath: string, force = false): Promise<void> {
	if (!existsSync(worktreePath)) return;

	const projectPath = dirname(dirname(worktreePath)); // .worktrees is 1 level up from project

	return withGitMutex(async () => {
		try {
			// Unlock first if locked
			await git(['worktree', 'unlock', worktreePath], projectPath).catch(() => {});
			const args = ['worktree', 'remove'];
			if (force) args.push('--force');
			args.push(worktreePath);
			await git(args, projectPath);
		} catch (err) {
			// If git worktree remove fails and force is requested, fall back to prune
			if (force) {
				await rm(worktreePath, { recursive: true, force: true });
				await git(['worktree', 'prune'], projectPath);
			} else {
				throw err;
			}
		}
	});
}

export async function listWorktrees(projectPath: string, runId: string): Promise<WorktreeInfo[]> {
	validateId(runId);

	const { stdout } = await git(['worktree', 'list', '--porcelain'], projectPath);
	const worktrees: WorktreeInfo[] = [];
	const prefix = `orchestration/${runId}/`;

	let currentPath = '';
	let currentBranch = '';
	let currentLocked = false;

	for (const line of stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			if (currentPath && currentBranch.includes(prefix)) {
				worktrees.push({ path: currentPath, branch: currentBranch, isLocked: currentLocked });
			}
			currentPath = line.slice('worktree '.length);
			currentBranch = '';
			currentLocked = false;
		} else if (line.startsWith('branch refs/heads/')) {
			currentBranch = line.slice('branch refs/heads/'.length);
		} else if (line === 'locked') {
			currentLocked = true;
		}
	}
	// Flush last entry
	if (currentPath && currentBranch.includes(prefix)) {
		worktrees.push({ path: currentPath, branch: currentBranch, isLocked: currentLocked });
	}

	return worktrees;
}

export async function pruneWorktrees(projectPath: string): Promise<number> {
	return withGitMutex(async () => {
		const { stderr } = await git(['worktree', 'prune', '--verbose'], projectPath);
		const pruned = (stderr.match(/Removing/g) || []).length;
		return pruned;
	});
}

// ── Merge operations ─────────────────────────────────────────────

export async function dryRunMerge(
	projectPath: string,
	branch: string,
	targetBranch?: string,
): Promise<{ conflicts: string[]; canMerge: boolean }> {
	const target = targetBranch || 'HEAD';

	try {
		// Use merge-tree for a true dry run (no index changes)
		const { stdout } = await git(['merge-tree', '--write-tree', '--no-messages', target, branch], projectPath);
		// If it succeeds with exit 0, no conflicts
		return { conflicts: [], canMerge: true };
	} catch (err: unknown) {
		const error = err as { stdout?: string; stderr?: string };
		// merge-tree exits non-zero on conflicts, listing conflicted files
		const conflicts: string[] = [];
		if (error.stdout) {
			for (const line of error.stdout.split('\n')) {
				// Conflicted files appear after the tree hash
				if (line.trim() && !line.match(/^[0-9a-f]{40,}/)) {
					conflicts.push(line.trim());
				}
			}
		}
		return { conflicts, canMerge: conflicts.length === 0 };
	}
}

export async function mergeBranch(
	projectPath: string,
	branch: string,
	targetBranch?: string,
): Promise<{ success: boolean; conflicts: string[]; message: string }> {
	return withGitMutex(async () => {
		if (targetBranch) {
			await git(['checkout', targetBranch], projectPath);
		}

		try {
			const { stdout } = await git(['merge', '--no-ff', branch, '-m', `merge: ${branch}`], projectPath);
			return { success: true, conflicts: [], message: stdout.trim() };
		} catch (err: unknown) {
			const error = err as { stdout?: string; stderr?: string };
			// Merge conflict — abort and report
			const conflictOutput = (error.stdout || '') + (error.stderr || '');
			const conflicts: string[] = [];

			for (const line of conflictOutput.split('\n')) {
				const match = line.match(/CONFLICT.*?:\s*(.+)/);
				if (match) conflicts.push(match[1].trim());
			}

			// Abort the failed merge
			await git(['merge', '--abort'], projectPath).catch(() => {});

			return {
				success: false,
				conflicts,
				message: conflictOutput.trim(),
			};
		}
	});
}

export async function deleteBranch(projectPath: string, branch: string): Promise<void> {
	return withGitMutex(async () => {
		await git(['branch', '-d', branch], projectPath);
	});
}

// ── Orphan detection ─────────────────────────────────────────────

/**
 * Detect orphaned worktrees — worktrees that exist on disk but aren't
 * referenced by any active (running/approved/planning/merging) run.
 */
export async function detectOrphanWorktrees(
	projectPath: string,
	activeRunIds: Set<string>,
): Promise<WorktreeInfo[]> {
	const { stdout } = await git(['worktree', 'list', '--porcelain'], projectPath);
	const orphans: WorktreeInfo[] = [];

	let currentPath = '';
	let currentBranch = '';
	let currentLocked = false;

	const flush = () => {
		if (!currentPath || !currentBranch.startsWith('orchestration/')) return;
		const parts = currentBranch.split('/');
		if (parts.length < 2) return;
		const runId = parts[1];
		if (!activeRunIds.has(runId)) {
			orphans.push({ path: currentPath, branch: currentBranch, isLocked: currentLocked });
		}
	};

	for (const line of stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			flush();
			currentPath = line.slice('worktree '.length);
			currentBranch = '';
			currentLocked = false;
		} else if (line.startsWith('branch refs/heads/')) {
			currentBranch = line.slice('branch refs/heads/'.length);
		} else if (line === 'locked') {
			currentLocked = true;
		}
	}
	flush();

	return orphans;
}

/**
 * Clean up orphaned worktrees. Per orphan: unlock → remove → prune → delete branch.
 */
export async function cleanupOrphanWorktrees(
	projectPath: string,
	orphans: WorktreeInfo[],
): Promise<{ cleaned: number; errors: string[] }> {
	let cleaned = 0;
	const errors: string[] = [];

	for (const orphan of orphans) {
		await git(['worktree', 'unlock', orphan.path], projectPath).catch(() => {});

		if (existsSync(orphan.path)) {
			try {
				await git(['worktree', 'remove', '--force', orphan.path], projectPath);
			} catch {
				try {
					await rm(orphan.path, { recursive: true, force: true });
				} catch (err) {
					errors.push(`Failed to remove worktree ${orphan.path}: ${err}`);
				}
			}
		}

		await git(['worktree', 'prune'], projectPath).catch(() => {});

		try {
			await git(['branch', '-D', orphan.branch], projectPath);
			cleaned++;
		} catch (err) {
			if (String(err).includes('not found')) {
				cleaned++;
			} else {
				errors.push(`Failed to delete branch ${orphan.branch}: ${err}`);
			}
		}
	}

	return { cleaned, errors };
}

// ── Lock cleanup ─────────────────────────────────────────────────

export async function cleanStaleLocks(projectPath: string): Promise<number> {
	const lockFile = join(projectPath, '.git', 'index.lock');
	let cleaned = 0;

	if (existsSync(lockFile)) {
		try {
			const s = await stat(lockFile);
			const ageMs = Date.now() - s.mtimeMs;
			// Only remove if older than 30 seconds
			if (ageMs > 30_000) {
				await unlink(lockFile);
				cleaned++;
				console.log(`[orchestration] Removed stale index.lock (age: ${Math.round(ageMs / 1000)}s)`);
			}
		} catch { /* already removed or permission denied */ }
	}

	return cleaned;
}

// ── Dependency installation ──────────────────────────────────────

export async function installDeps(worktreePath: string): Promise<void> {
	const hasPnpmLock = existsSync(join(worktreePath, 'pnpm-lock.yaml'));

	if (hasPnpmLock) {
		try {
			await execFileAsync('pnpm', ['install', '--frozen-lockfile'], {
				cwd: worktreePath,
				maxBuffer: 10 * 1024 * 1024,
			});
			return;
		} catch {
			// pnpm not available — try CoW copy
			const srcModules = join(dirname(dirname(worktreePath)), 'node_modules');
			const dstModules = join(worktreePath, 'node_modules');
			if (existsSync(srcModules) && !existsSync(dstModules) && process.platform === 'darwin') {
				await execFileAsync('cp', ['-Rc', srcModules, dstModules]);
				return;
			}
		}
	}

	// Fallback: npm
	const hasPackageLock = existsSync(join(worktreePath, 'package-lock.json'));
	if (hasPackageLock) {
		await execFileAsync('npm', ['ci', '--prefer-offline'], {
			cwd: worktreePath,
			maxBuffer: 10 * 1024 * 1024,
		});
	} else if (existsSync(join(worktreePath, 'package.json'))) {
		await execFileAsync('npm', ['install'], {
			cwd: worktreePath,
			maxBuffer: 10 * 1024 * 1024,
		});
	}
}
