import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '$lib/config.js';
import { loadRun, saveRun, regenerateBoard } from './board.js';
import { dryRunMerge } from './worktree.js';
import { emitRunEvent } from './events.js';
import { runPostMergePipeline } from './post-merge-pipeline.js';
import type { OrchestrationRun, TaskNode } from './types.js';

const execFileAsync = promisify(execFile);

const AI_MERGE_TIMEOUT_MS = 10 * 60 * 1000;

export interface MergeResult {
	success: boolean;
	merged: string[];
	conflicts: string[];
	buildPassed: boolean;
	error?: string;
}

export interface MergeScanResult {
	taskId: string;
	taskName: string;
	branch: string;
	hasConflicts: boolean;
	conflictFiles: string[];
}

/**
 * Run the scan-first merge process:
 * 1. Dry-run scan ALL branches with merge-tree (no side effects)
 * 2. Merge clean branches directly
 * 3. For conflicted branches, use git merge --no-commit + AI resolution
 * 4. Post-merge validation
 */
export async function runSmartMerge(runId: string): Promise<MergeResult> {
	const run = await loadRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);

	run.status = 'merging';
	run.mergeLog = [];
	await saveRun(run);

	const merged: string[] = [];
	const conflicts: string[] = [];
	const completedTasks = topoSort(run);

	// Enable git rerere so conflict resolutions are remembered
	try {
		await execFileAsync('git', ['config', 'rerere.enabled', 'true'], { cwd: run.projectPath });
	} catch { /* best effort */ }

	// Register semantic/lockfile merge drivers for this repo (idempotent, per-repo only)
	const driverNotes = await ensureMergeDrivers(run.projectPath);
	if (driverNotes.length) {
		run.mergeLog.push(...driverNotes);
		await saveRun(run);
	}

	// ── Phase 1: Scan all branches for conflicts (dry-run, no working tree changes) ──
	emitMergeProgress(runId, 'scanning', 'Scanning branches for conflicts...', 0, completedTasks.length);

	const scanResults: MergeScanResult[] = [];

	// Fetch the already-merged branch set once — avoids O(N) git invocations below
	const mergedSet = await listMergedBranches(run.projectPath);

	for (const task of completedTasks) {
		const worker = run.workers[task.id];
		if (!worker || worker.status !== 'done' || !worker.branch) continue;

		if (mergedSet.has(worker.branch)) {
			merged.push(task.id);
			run.mergeLog.push(`${worker.branch}: already merged (skipped)`);
			continue;
		}

		const dryRun = await dryRunMerge(run.projectPath, worker.branch);
		scanResults.push({
			taskId: task.id,
			taskName: task.name,
			branch: worker.branch,
			hasConflicts: !dryRun.canMerge,
			conflictFiles: dryRun.conflicts,
		});
	}

	const cleanBranches = scanResults.filter((s) => !s.hasConflicts);
	const conflictBranches = scanResults.filter((s) => s.hasConflicts);

	run.mergeLog.push(`Scan complete: ${cleanBranches.length} clean, ${conflictBranches.length} with conflicts`);
	await saveRun(run);

	emitMergeProgress(runId, 'scan_complete', `${cleanBranches.length} clean, ${conflictBranches.length} conflicted`, 0, scanResults.length, scanResults);

	// ── Phase 2: Merge clean branches (fast, no AI needed) ──
	let mergeIndex = 0;

	for (const scan of cleanBranches) {
		mergeIndex++;
		emitMergeProgress(runId, 'merging_clean', `Merging ${scan.taskName}...`, mergeIndex, scanResults.length);

		try {
			await execFileAsync(
				'git', ['merge', '--no-ff', scan.branch, '-m', `merge: ${scan.branch}`],
				{ cwd: run.projectPath },
			);
			merged.push(scan.taskId);
			run.mergeLog.push(`Merged ${scan.branch} (clean)`);
		} catch (err) {
			// Unexpected conflict (race or rerere changed state) — treat as conflict
			await execFileAsync('git', ['merge', '--abort'], { cwd: run.projectPath }).catch(() => {});
			conflictBranches.push(scan);
			run.mergeLog.push(`${scan.branch}: unexpected conflict during merge`);
		}

		await saveRun(run);
	}

	// ── Phase 3: Resolve conflicted branches with AI ──
	for (const scan of conflictBranches) {
		mergeIndex++;
		emitMergeProgress(runId, 'resolving_conflict', `AI resolving ${scan.taskName}...`, mergeIndex, scanResults.length);
		run.mergeLog.push(`Resolving conflicts for ${scan.branch} (${scan.conflictFiles.length} files)...`);
		await saveRun(run);

		let resolved = false;
		try {
			resolved = await resolveConflictWithAI(run, scan.taskId, scan.branch, scan.conflictFiles);
		} catch (err) {
			run.mergeLog.push(`AI merge error for ${scan.branch}: ${err}`);
			await execFileAsync('git', ['merge', '--abort'], { cwd: run.projectPath }).catch(() => {});
		}

		if (resolved) {
			merged.push(scan.taskId);
			run.mergeLog.push(`AI resolved ${scan.branch}`);
		} else {
			conflicts.push(scan.taskId);
			run.mergeLog.push(`${scan.branch}: AI could not resolve — manual intervention needed`);
			await execFileAsync('git', ['merge', '--abort'], { cwd: run.projectPath }).catch(() => {});
		}

		await saveRun(run);
	}

	// ── Phase 4: Post-merge developer checklist ──
	// Runs the full "what a senior dev does after a merge" pipeline:
	// install → typecheck → lint → test → build, with AI fix-specialist retry
	// for blocking failures.
	let buildPassed = false;
	if (merged.length > 0) {
		emitMergeProgress(runId, 'validating', 'Running post-merge checklist...', scanResults.length, scanResults.length);

		const pipeline = await runPostMergePipeline(runId, run.projectPath, (line) => {
			run.mergeLog.push(line);
		});
		run.postMergeSteps = pipeline.results;
		buildPassed = pipeline.allPassed;
		await saveRun(run);
	}

	// Merge succeeds if all branches merged — build failure is a warning, not a blocker
	run.status = conflicts.length === 0 && merged.length > 0 ? 'done' : 'failed';
	run.completedAt = new Date().toISOString();
	await saveRun(run);
	await regenerateBoard(runId);

	emitMergeProgress(runId, 'complete', run.status === 'done' ? 'Merge complete' : 'Merge finished with issues', scanResults.length, scanResults.length);

	return { success: conflicts.length === 0, merged, conflicts, buildPassed };
}

/**
 * Resolve merge conflicts using AI.
 * Uses git merge --no-commit so conflict markers stay live in the working tree.
 * AI reads the markers, resolves, stages, and commits.
 */
async function resolveConflictWithAI(
	run: OrchestrationRun,
	taskId: string,
	branch: string,
	knownConflictFiles: string[],
): Promise<boolean> {
	const projectPath = run.projectPath;

	// Start the merge with --no-commit — conflict markers live in working tree
	try {
		await execFileAsync(
			'git', ['merge', '--no-ff', '--no-commit', branch],
			{ cwd: projectPath },
		);
		// Merge succeeded (rerere may have auto-resolved) — just commit
		await execFileAsync(
			'git', ['commit', '-m', `merge: ${branch}`],
			{ cwd: projectPath },
		);
		return true;
	} catch {
		// Expected: conflict markers are now in the working tree (no abort needed)
	}

	// Get actual conflicted files from working tree
	let conflictedFiles: string[];
	try {
		const { stdout } = await execFileAsync(
			'git', ['diff', '--name-only', '--diff-filter=U'],
			{ cwd: projectPath },
		);
		conflictedFiles = stdout.trim().split('\n').filter((f) => f.trim());
	} catch {
		conflictedFiles = knownConflictFiles;
	}

	if (conflictedFiles.length === 0) {
		// All conflicts auto-resolved (rerere) — commit
		try {
			await execFileAsync('git', ['add', '-A'], { cwd: projectPath });
			await execFileAsync(
				'git', ['commit', '-m', `merge: ${branch} (auto-resolved)`],
				{ cwd: projectPath },
			);
			return true;
		} catch {
			return false;
		}
	}

	const task = run.plan.tasks.find((t) => t.id === taskId);
	const taskDesc = task ? `Task "${task.name}": ${task.description}` : `Task: ${taskId}`;

	const mergePrompt = `You are a GIT MERGE SPECIALIST. Your job is to resolve merge conflicts.

SITUATION:
- Branch "${branch}" is being merged into the current branch
- ${taskDesc}
- ${conflictedFiles.length} file(s) have conflicts: ${conflictedFiles.join(', ')}
- The merge is already in progress (--no-commit). Conflict markers are LIVE in the working tree.

INSTRUCTIONS:
1. For each conflicted file, read it to see the conflict markers (<<<<<<, =======, >>>>>>>)
2. Resolve each conflict by keeping BOTH sets of changes where possible:
   - For type definitions: include types from both branches
   - For imports: include all imports
   - For functions: keep both functions (they likely do different things)
   - For package.json: merge dependencies (take higher semver on conflicts)
   - For config files: deep merge, keep all settings
3. After resolving all conflicts, run: git add -A
4. Then run: git commit -m "merge: resolve conflicts for ${branch}"
5. Do NOT run npm install or build — that happens after all merges

CONFLICT RESOLUTION RULES:
- NEVER delete code from either side unless it's truly duplicate
- When in doubt, keep both versions
- For package-lock.json: just delete it (will be regenerated)
- For CLAUDE.md: keep the HEAD version (discard worker's generated version)
- Resolve ALL conflicts in ALL files before committing

FILES WITH CONFLICTS:
${conflictedFiles.map((f) => `- ${f}`).join('\n')}`;

	// Headless one-shot: claude -p exits after the agent's final response.
	// No PTY, no ANSI parsing, no stall-detection race — the process terminates
	// when the agent is done, which fires the promise naturally.
	const claudeBinary = config.resolved.claudeBinary;
	try {
		await execFileAsync(
			claudeBinary,
			[
				'--print',
				'--dangerously-skip-permissions',
				'--strict-mcp-config',
				'--mcp-config', '{"mcpServers":{}}',
				'--no-session-persistence',
				'--output-format', 'text',
				mergePrompt,
			],
			{
				cwd: projectPath,
				timeout: AI_MERGE_TIMEOUT_MS,
				maxBuffer: 50 * 1024 * 1024,
			},
		);
	} catch (err) {
		// Even when claude exits non-zero, the agent may have committed mid-run.
		// Source of truth is the working-tree state below — don't short-circuit here.
		const e = err as { message?: string };
		run.mergeLog.push(`claude -p exited with error for ${branch}: ${(e.message || String(err)).slice(0, 200)}`);
	}

	// Authoritative check: are conflict markers gone, and is the merge committed?
	try {
		const { stdout: remaining } = await execFileAsync(
			'git', ['diff', '--name-only', '--diff-filter=U'],
			{ cwd: projectPath },
		);
		if (remaining.trim() !== '') return false;

		// Conflicts resolved in the working tree — if the merge is still mid-flight
		// (MERGE_HEAD present), the AI forgot to commit. Finish it ourselves so we
		// don't leak an uncommitted merge into Phase 4.
		const mergeHeadExists = existsSync(join(projectPath, '.git', 'MERGE_HEAD'));
		if (mergeHeadExists) {
			await execFileAsync('git', ['add', '-A'], { cwd: projectPath });
			await execFileAsync(
				'git', ['commit', '-m', `merge: resolve conflicts for ${branch}`],
				{ cwd: projectPath },
			);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Emit a merge progress event via SSE so the UI can show live phases.
 */
function emitMergeProgress(
	runId: string,
	phase: string,
	message: string,
	current: number,
	total: number,
	scanResults?: MergeScanResult[],
): void {
	emitRunEvent(runId, 'merge_progress', { phase, message, current, total, scanResults });
}

/**
 * Topological sort of completed tasks — leaves (no deps) first, roots last.
 */
function topoSort(run: OrchestrationRun): TaskNode[] {
	const tasks = run.plan.tasks.filter((t) => {
		const w = run.workers[t.id];
		return w && w.status === 'done';
	});

	const visited = new Set<string>();
	const sorted: TaskNode[] = [];
	const byId = new Map(tasks.map((t) => [t.id, t]));

	function visit(task: TaskNode): void {
		if (visited.has(task.id)) return;
		visited.add(task.id);
		for (const depId of task.dependsOn) {
			const dep = byId.get(depId);
			if (dep) visit(dep);
		}
		sorted.push(task);
	}

	for (const t of tasks) visit(t);
	return sorted;
}

/**
 * List branches already merged into HEAD as a Set.
 * Returns empty Set on any failure — caller treats unknown as "not merged".
 */
async function listMergedBranches(projectPath: string): Promise<Set<string>> {
	try {
		const { stdout } = await execFileAsync('git', ['branch', '--merged'], { cwd: projectPath });
		return new Set(
			stdout.split('\n').map((l) => l.replace(/^\*?\s*/, '').trim()).filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

/**
 * Ensure mergiraf (semantic merge) and lockfile merge drivers are registered
 * for the target repo. Idempotent — safe to run on every merge.
 * Returns log lines describing what changed (empty if nothing to do).
 */
async function ensureMergeDrivers(projectPath: string): Promise<string[]> {
	const logs: string[] = [];

	const mergirafInstalled = await commandExists('mergiraf');
	if (mergirafInstalled) {
		await setGitMergeDriver(
			projectPath,
			'mergiraf',
			'mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L',
		);
	}

	const npmInstalled = await commandExists('npm');

	const lines: string[] = [];
	if (mergirafInstalled) {
		// Languages mergiraf supports safely in this codebase shape
		lines.push(
			'*.ts merge=mergiraf',
			'*.tsx merge=mergiraf',
			'*.js merge=mergiraf',
			'*.jsx merge=mergiraf',
			'*.svelte merge=mergiraf',
			'*.json merge=mergiraf',
			'*.md merge=mergiraf',
		);
	}
	if (npmInstalled) {
		// On lockfile conflict: drop whatever was there and regenerate from the
		// merged package.json. The post-merge pipeline will also do a clean
		// install, so this is defense-in-depth during the conflict phase itself.
		await setGitMergeDriver(
			projectPath,
			'npm-lockfile',
			'rm -f %A && npm install --package-lock-only --silent || true',
		);
		lines.push('package-lock.json merge=npm-lockfile');
	}

	if (lines.length === 0) return logs;

	const attrsPath = join(projectPath, '.gitattributes');
	let existing = '';
	try { existing = await readFile(attrsPath, 'utf-8'); } catch { /* absent */ }

	const missing = lines.filter((line) => !existing.split('\n').some((l) => l.trim() === line));
	if (missing.length === 0) return logs;

	const marker = '# soul-hub orchestration merge drivers';
	const block = `\n${marker}\n${missing.join('\n')}\n`;
	await writeFile(attrsPath, existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + block);

	// Commit the change immediately — otherwise it sits dirty in the working
	// tree and gets swept into later AI fix commits, polluting their diffs.
	try {
		await execFileAsync('git', ['add', '.gitattributes'], { cwd: projectPath });
		await execFileAsync(
			'git',
			['commit', '-m', 'chore: register merge drivers for parallel orchestration run'],
			{ cwd: projectPath },
		);
		logs.push(`Registered ${missing.length} merge driver pattern(s) in .gitattributes (committed)`);
	} catch {
		// If nothing staged (existing file already had these), no-op
		logs.push(`Registered ${missing.length} merge driver pattern(s) in .gitattributes`);
	}
	return logs;
}

async function setGitMergeDriver(projectPath: string, name: string, driver: string): Promise<void> {
	try {
		await execFileAsync(
			'git', ['config', `merge.${name}.name`, `soul-hub ${name} driver`],
			{ cwd: projectPath },
		);
		await execFileAsync(
			'git', ['config', `merge.${name}.driver`, driver],
			{ cwd: projectPath },
		);
	} catch { /* best effort */ }
}

async function commandExists(cmd: string): Promise<boolean> {
	try {
		await execFileAsync('which', [cmd]);
		return true;
	} catch {
		return false;
	}
}
