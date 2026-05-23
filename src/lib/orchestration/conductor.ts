import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnSession, isAlive as isPtyAlive, writeInput as writePtyInput } from '$lib/pty/manager.js';
import type {
	OrchestrationRun,
	OrchestrationPlan,
	WorkerState,
	TaskNode,
	FailureSummary,
	ConflictReport,
} from './types.js';
import { getProvider } from './providers/index.js';
import { config } from '$lib/config.js';
import { sendViaChannel } from '$lib/channels/registry.js';
import { validateWorker } from './worker-validator.js';
import {
	saveRun,
	loadRun,
	listRuns,
	savePlan,
	saveWorkerState,
	appendWorkerOutput,
	saveOwnershipMap,
	regenerateBoard,
} from './board.js';
import {
	createWorktree,
	removeWorktree,
	listWorktrees,
	dryRunMerge,
	mergeBranch,
	deleteBranch,
	pruneWorktrees,
	installDeps,
} from './worktree.js';
import {
	canSpawnWorker,
} from './guards.js';
import { emitRunEvent, appendOutput, cleanupRunEmitter, cleanupOutputBuffers } from './events.js';

const execFileAsync = promisify(execFile);

// Serializes dispatchReadyWorkers calls so simultaneous worker exits
// cannot race on the run state / worktree creation.
let dispatchLock: Promise<void> = Promise.resolve();

function withDispatchLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = dispatchLock;
	let resolve: () => void;
	dispatchLock = new Promise<void>((r) => {
		resolve = r;
	});
	return prev.then(fn).finally(() => resolve!());
}

async function verifyWorktree(worktreePath: string): Promise<void> {
	const { stdout } = await execFileAsync('git', ['rev-parse', '--git-dir'], {
		cwd: worktreePath,
	});
	if (!stdout.trim()) {
		throw new Error(`Worktree verification failed for ${worktreePath}`);
	}
}

function generateRunId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 6);
	return `run-${ts}-${rand}`;
}

function now(): string {
	return new Date().toISOString();
}

function log(runId: string, msg: string): void {
	console.log(`[orchestration:${runId}] ${msg}`);
}

/**
 * Send an orchestration event notification via the configured channel
 * (Telegram). Previously injected text into the PM's PTY; now routed
 * out-of-band so the PM conversation stays clean.
 */
async function notifyPm(runId: string, message: string): Promise<void> {
	try {
		await sendViaChannel(
			undefined,
			config.channels || {},
			`[Orchestration ${runId.slice(0, 16)}] ${message}`,
		);
	} catch {
		/* best effort */
	}
}

// ── Run lifecycle ────────────────────────────────────────────────

export async function createRun(
	projectName: string,
	projectPath: string,
	goal: string,
): Promise<OrchestrationRun> {
	if (!existsSync(projectPath)) {
		throw new Error(`Project path does not exist: ${projectPath}`);
	}

	const run: OrchestrationRun = {
		runId: generateRunId(),
		projectName,
		projectPath,
		status: 'planning',
		plan: { goal, tasks: [], createdAt: now() },
		workers: {},
		createdAt: now(),
		mergeLog: [],
		failureSummaries: [],
		conflictReports: [],
	};

	await saveRun(run);
	log(run.runId, `created — goal: "${goal}"`);
	return run;
}

// ── Plan Generation (PM step) ───────────────────────────────────

/**
 * Spawn the PM session as a headless PTY for plan generation.
 * The PM is a full interactive Claude Code session that creates tasks
 * via the Task CRUD API (curl calls). No output parsing needed.
 *
 * Returns the PTY session ID so the frontend can:
 *   1. Stream output via existing /api/pty reconnect
 *   2. Send input via /api/pty input action
 *   3. Poll for task list via GET /api/orchestration/{runId}/tasks
 */
export async function generatePlan(runId: string): Promise<{ sessionId: string }> {
	const run = await loadRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);
	// Allow PM spawn in planning (normal) and running/failed (advisor mode)
	const allowedStatuses = ['planning', 'running', 'failed'];
	if (!allowedStatuses.includes(run.status)) throw new Error(`Cannot spawn PM in status: ${run.status}`);

	const projectPath = run.projectPath;
	const goal = run.plan.goal;

	const port = config.server?.port || 5173;
	const apiBase = `http://localhost:${port}/api/orchestration/${runId}`;

	// Build existing tasks context
	const existingTasks = run.plan.tasks;
	let existingTasksContext = '';
	if (existingTasks.length > 0) {
		existingTasksContext = `
## EXISTING PLAN (${existingTasks.length} tasks already created)

The following tasks already exist. Do NOT create them again. You can update or delete them if needed.

${existingTasks.map((t, i) => `${i + 1}. **${t.name}** (id: \`${t.id}\`)
   - ${t.description}
   - Priority: ${t.priority} | Complexity: ${t.estimatedComplexity}
   - Owns: ${t.fileOwnership.join(', ')}
   - Depends on: ${t.dependsOn.length > 0 ? t.dependsOn.join(', ') : 'none'}`).join('\n')}

To adjust, use the UPDATE or DELETE endpoints. Do NOT try to create tasks with IDs that already exist.
`;
	}

	// Build failure context — current run failures + selected cross-run failures
	let failureContext = '';
	const currentFailures = run.failureSummaries || [];
	if (currentFailures.length > 0) {
		failureContext += `\n## Previous Failures in This Run\n`;
		for (const f of currentFailures.slice(-5)) {
			failureContext += `- "${f.taskName}" failed: ${f.error} (used ${f.iterationsUsed} iterations)\n  Last output: ${f.lastOutput.slice(0, 200)}\n`;
		}
	}

	try {
		const allRuns = await listRuns(20);
		const otherFailed = allRuns
			.filter(
				(r) =>
					r.projectName === run.projectName &&
					r.runId !== run.runId &&
					r.status === 'failed' &&
					(r.failureSummaries?.length || 0) > 0,
			)
			.slice(0, 3);

		if (otherFailed.length > 0) {
			failureContext += `\n## Failures From Other Runs on This Project\n`;
			for (const r of otherFailed) {
				for (const f of (r.failureSummaries || []).slice(-2)) {
					failureContext += `- Run ${r.runId.slice(0, 16)}: "${f.taskName}" failed — ${f.error}\n`;
				}
			}
		}
	} catch { /* non-fatal */ }

	// Build different prompts for planning vs execution/failed states
	const isAdvisorMode = run.status === 'running' || run.status === 'failed';

	let workerStatusSummary = '';
	if (isAdvisorMode) {
		const entries = Object.entries(run.workers)
			.filter(([id]) => id !== '_pm')
			.map(([, w]) => `- ${run.plan.tasks.find(t => t.id === w.taskId)?.name ?? w.taskId}: ${w.status}${w.error ? ` (${w.error})` : ''}`);
		workerStatusSummary = `\n## Current Worker Status\n${entries.join('\n')}\n`;
	}

	const pmPrompt = isAdvisorMode
		? `You are a Project Manager ADVISOR for an active orchestration run.

GOAL: ${goal}
STATUS: ${run.status}
${workerStatusSummary}
${failureContext}
You are here to help the user understand what happened and advise on next steps.
You will receive [ORCHESTRATION EVENT] notifications as workers complete or fail.

Available tools:
- Check worker status: curl -s http://localhost:${port}/api/orchestration/${runId}
- Check conflicts: curl -s http://localhost:${port}/api/orchestration/${runId}/conflicts
- List tasks: curl -s ${apiBase}/tasks

You CANNOT modify the plan while the run is active. You CAN:
- Explain what workers did or why they failed
- Suggest whether to retry, replan, or merge
- Answer questions about the codebase and task progress
- Help the user decide on merge strategy`
		: `You are a Project Manager for a multi-agent coding orchestration system.

GOAL: ${goal}
${existingTasksContext}
You have API tools to manage the task plan. Use curl to call them from your Bash tool:

## Create a task
curl -s -X POST ${apiBase}/tasks \\
  -H 'Content-Type: application/json' \\
  -d '{ "id": "short-kebab-id", "name": "Task Name", "description": "...", "prompt": "Full detailed prompt...", "provider": "claude-code", "dependsOn": [], "priority": "medium", "estimatedComplexity": "medium", "acceptanceCriteria": ["..."], "risks": ["..."], "fileOwnership": ["src/..."], "maxIterations": 8 }'

## List current tasks
curl -s ${apiBase}/tasks

## Update a task
curl -s -X PUT ${apiBase}/tasks/TASK_ID \\
  -H 'Content-Type: application/json' \\
  -d '{ "description": "Updated..." }'

## Delete a task
curl -s -X DELETE ${apiBase}/tasks/TASK_ID

## Validate the plan
curl -s -X POST ${apiBase}/tasks/validate

## Cross-Run Awareness
Other orchestration runs may exist on this project (active, completed, or failed).
Check them BEFORE creating tasks to avoid file ownership overlap.

# Brief list of all other runs and their tasks for this project
curl -s "http://localhost:${port}/api/orchestration/cross-run?project=${encodeURIComponent(run.projectName)}&exclude=${runId}"

# Full details of a specific task from another run
curl -s "http://localhost:${port}/api/orchestration/cross-run/{otherRunId}/{taskId}"

CROSS-RUN RULES:
- Check cross-run tasks BEFORE creating your tasks
- Do NOT claim files owned by tasks in ACTIVE (running/planning) runs — validation will block this
- If a COMPLETED run already built what you need, create an enhancement task instead:
  Set "enhances": "runId/taskId" to reference the completed work
- If a run FAILED on something, learn from it — fetch the task details to see what went wrong
- Platform files (package.json, tsconfig.json, .env, etc.) are shared — avoid claiming them
${failureContext}
${existingTasks.length > 0 ? `CURRENT STATE: ${existingTasks.length} tasks exist. Review them, ask the user what to adjust, or validate the plan.` : `PLANNING PROTOCOL:
1. Read the codebase: CLAUDE.md, package.json, src/ structure, existing files
2. Search the vault for prior context: curl -s "http://localhost:2400/api/vault/notes?q=${encodeURIComponent(goal)}&limit=5"
3. Check cross-run tasks for this project
4. Run: find src -type f | sort (see all existing source files)
5. Design a FOUNDATION-FIRST plan:

   TASK 0 (Foundation) — runs ALONE before all others:
   - Creates ALL shared types (src/lib/types.ts)
   - Creates ALL database schema and initialization (src/lib/server/db.ts)
   - Creates ALL repository/data-access files (src/lib/server/repositories/)
   - Installs ALL npm dependencies (owns package.json)
   - Creates seed data, config files, .gitignore updates
   - This task has NO dependencies

   TASKS 1-N — run in PARALLEL after foundation completes:
   - Each owns its own route directory (src/routes/...)
   - Each owns its own component files (src/lib/components/...)
   - They IMPORT from foundation files but NEVER modify them
   - They NEVER touch package.json, types.ts, db.ts, or any file owned by foundation

6. Generate a FILE OWNERSHIP MATRIX before creating any tasks:

   | File/Directory | Owner Task | Other Tasks |
   |----------------|-----------|-------------|
   | src/lib/types.ts | foundation | READ-ONLY for all |
   | src/lib/server/db.ts | foundation | READ-ONLY for all |
   | src/lib/server/repositories/ | foundation | READ-ONLY for all |
   | package.json | foundation | NEVER TOUCH |
   | src/routes/admin/ | admin-ui | none |
   | src/routes/card/ | public-card | none |
   | src/lib/components/Card.svelte | public-card | none |

   RULES for the matrix:
   - Every file ANY task touches MUST appear in the matrix
   - Each file has EXACTLY ONE write owner
   - Foundation task owns ALL shared/imported files
   - NO two tasks may write to the same file
   - If you cannot avoid overlap, serialize the tasks (dependsOn)

6. Create tasks using the API — foundation first, then parallel tasks
7. Each task prompt MUST include:
   - "FILES YOU OWN (write): [list]"
   - "FILES YOU MAY READ (import only, do NOT modify): [list from foundation]"
   - "FILES YOU MUST NOT TOUCH: everything else"
8. Validate the plan`}

CRITICAL RULES:
- The foundation task MUST own: package.json, all type files, all db/schema files, all config files
- Parallel tasks MUST NOT modify any file owned by the foundation task
- If two tasks need to write to the same file, they MUST be serialized (one depends on the other)
- Each task prompt must be a self-contained blueprint — the worker has NO other context
- DO NOT ask the user questions — make decisions autonomously
- Create ALL tasks in a SINGLE session, then validate
- Available providers: "claude-code" (default), "codex", "shell"`;

	log(runId, 'spawning PM session for plan generation...');

	// Choose the right prompt based on context:
	// 1. Running/failed → advisor mode (monitor workers, explain failures)
	// 2. Planning with existing tasks → review mode (list tasks, ask what to change)
	// 3. Planning with no tasks → full planning prompt
	const hasExistingTasks = run.plan.tasks.length > 0;

	let sessionPrompt: string;
	if (isAdvisorMode) {
		// pmPrompt is already the advisor prompt (set by the ternary above)
		sessionPrompt = pmPrompt;
	} else if (hasExistingTasks) {
		sessionPrompt = `You are a Project Manager reviewing an existing orchestration plan.

GOAL: ${goal}

First, list the current tasks by running:
curl -s ${apiBase}/tasks

Then present the plan summary to the user and ask:
"What would you like to change? You can add, update, or delete tasks."

API tools available:
- List tasks: curl -s ${apiBase}/tasks
- Create task: curl -s -X POST ${apiBase}/tasks -H 'Content-Type: application/json' -d '{...}'
- Update task: curl -s -X PUT ${apiBase}/tasks/TASK_ID -H 'Content-Type: application/json' -d '{...}'
- Delete task: curl -s -X DELETE ${apiBase}/tasks/TASK_ID
- Validate: curl -s -X POST ${apiBase}/tasks/validate

RULES:
- Wait for the user to tell you what to change before making modifications
- After changes, call validate to check the plan
- Each task must own specific files/directories — no overlap`;
	} else {
		sessionPrompt = pmPrompt;
	}

	const session = spawnSession({
		prompt: sessionPrompt,
		cwd: projectPath,
		shell: false,
	});

	// Track PM session
	run.workers['_pm'] = {
		taskId: '_pm',
		workerId: session.id,
		status: 'running',
		worktreePath: projectPath,
		branch: '',
		iterationCount: 0,
		startedAt: now(),
	};
	await saveRun(run);

	// Listen for PM exit — don't mark as done, keep available for reopening.
	session.emitter.on('exit', async () => {
		const latestRun = await loadRun(runId);
		if (latestRun?.workers['_pm'] && latestRun.workers['_pm'].status === 'running') {
			// PM exited on its own (Claude Code session ended) — mark as failed
			// so the UI shows "Open PM Session" button for re-engagement
			latestRun.workers['_pm'].status = 'failed';
			latestRun.workers['_pm'].completedAt = now();
			latestRun.workers['_pm'].error = 'PM session ended — click "Open PM Session" to reopen';
			await saveRun(latestRun);
		}
	});

	log(runId, `PM session spawned: ${session.id}`);
	return { sessionId: session.id };
}

export async function setPlan(runId: string, plan: OrchestrationPlan): Promise<OrchestrationRun> {
	const run = await loadRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);
	if (run.status !== 'planning') throw new Error(`Cannot set plan in status: ${run.status}`);

	// Validate: no duplicate task IDs
	const ids = new Set<string>();
	for (const task of plan.tasks) {
		if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
		ids.add(task.id);
	}

	// Validate: all dependsOn references exist
	for (const task of plan.tasks) {
		for (const dep of task.dependsOn) {
			if (!ids.has(dep)) throw new Error(`Task "${task.id}" depends on unknown task: ${dep}`);
		}
	}

	// Validate: detect circular dependencies
	detectCycles(plan.tasks);

	run.plan = plan;
	await saveRun(run);
	await savePlan(run);
	log(runId, `plan set — ${plan.tasks.length} tasks`);
	return run;
}

function detectCycles(tasks: TaskNode[]): void {
	const taskMap = new Map(tasks.map((t) => [t.id, t]));
	const visited = new Set<string>();
	const stack = new Set<string>();

	function dfs(id: string): void {
		if (stack.has(id)) {
			throw new Error(`Circular dependency detected involving task: ${id}`);
		}
		if (visited.has(id)) return;

		stack.add(id);
		const task = taskMap.get(id);
		if (task) {
			for (const dep of task.dependsOn) {
				dfs(dep);
			}
		}
		stack.delete(id);
		visited.add(id);
	}

	for (const task of tasks) {
		dfs(task.id);
	}
}

export async function approveAndStart(runId: string): Promise<OrchestrationRun> {
	const run = await loadRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);
	if (run.status !== 'planning') throw new Error(`Cannot approve in status: ${run.status}`);
	if (run.plan.tasks.length === 0) throw new Error('Cannot approve a plan with no tasks');

	// Build ownership map from plan
	const ownershipMap: Record<string, string> = {};
	for (const task of run.plan.tasks) {
		for (const path of task.fileOwnership) {
			ownershipMap[path] = task.id;
		}
	}
	await saveOwnershipMap(runId, ownershipMap);

	run.status = 'running';
	run.startedAt = now();
	await saveRun(run);
	await regenerateBoard(runId);

	log(runId, 'approved and started');

	// Auto-dispatch ready workers (serialized)
	await withDispatchLock(() => dispatchReadyWorkersInner(runId));

	// Notify PM that plan was approved and workers are dispatching
	notifyPm(
		runId,
		'Plan APPROVED. Workers are being dispatched. You will receive notifications as workers complete or fail. Stay available to advise the user.',
	).catch(() => {});

	return (await loadRun(runId))!;
}

export function dispatchReadyWorkers(runId: string): Promise<string[]> {
	return withDispatchLock(() => dispatchReadyWorkersInner(runId));
}

async function propagateBlockedDependents(
	latestRun: OrchestrationRun,
	failedTask: TaskNode,
	failedStatus: 'failed' | 'killed' | 'stuck',
): Promise<void> {
	const runId = latestRun.runId;
	for (const t of latestRun.plan.tasks) {
		if (t.dependsOn.includes(failedTask.id) && !latestRun.workers[t.id]) {
			const blocked: WorkerState = {
				taskId: t.id,
				workerId: '',
				status: 'blocked',
				worktreePath: '',
				branch: '',
				iterationCount: 0,
				error: `Blocked: dependency "${failedTask.name}" ${failedStatus}`,
			};
			latestRun.workers[t.id] = blocked;
			await saveWorkerState(runId, blocked);
			emitRunEvent(runId, 'worker_dispatched', { taskId: t.id, workerId: '' });
			emitRunEvent(runId, 'worker_exit', { taskId: t.id, exitCode: -1 });
		}
	}
}

async function dispatchReadyWorkersInner(runId: string): Promise<string[]> {
	const run = await loadRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);
	if (run.status !== 'running') return [];

	// Load ownership map once per dispatch pass
	const ownershipMap: Record<string, string> = {};
	for (const task of run.plan.tasks) {
		for (const path of task.fileOwnership) {
			ownershipMap[path] = task.id;
		}
	}

	const dispatched: string[] = [];
	const activeWorkerCount = Object.values(run.workers).filter(
		(w) => w.status === 'running',
	).length;

	for (const task of run.plan.tasks) {
		// Skip if already has a worker
		if (run.workers[task.id]) continue;

		// Check if all dependencies are done
		const depsReady = task.dependsOn.every((depId) => {
			const depWorker = run.workers[depId];
			return depWorker && depWorker.status === 'done';
		});
		if (!depsReady) continue;

		// Check concurrency limit
		if (!canSpawnWorker(activeWorkerCount + dispatched.length)) break;

		try {
			const { worktreePath, branch } = await createWorktree(
				run.projectPath,
				runId,
				task.id,
			);

			// Verify worktree is a real git working tree
			await verifyWorktree(worktreePath);

			// Resolve provider for this task (falls back to claude-code if unavailable)
			const provider = await getProvider(task.provider);

			// Provider-specific setup (CLAUDE.md for claude-code, nothing for others)
			await provider.setup(worktreePath, task, ownershipMap, run.projectPath);

			// Install deps in worktree (best effort)
			try { await installDeps(worktreePath); } catch (err) {
				log(runId, `deps install failed for ${task.id}: ${err}`);
			}

			const SPAWN_TIMEOUT_MS = 120_000; // 2 minutes
			const session = await Promise.race([
				provider.spawn(worktreePath, task, run.projectPath),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`Spawn timeout after ${SPAWN_TIMEOUT_MS / 1000}s`)),
						SPAWN_TIMEOUT_MS,
					),
				),
			]);

			const worker: WorkerState = {
				taskId: task.id,
				workerId: session.id,
				status: 'running',
				worktreePath,
				branch,
				iterationCount: 0,
				startedAt: now(),
				providerType: provider.id,
			};

			run.workers[task.id] = worker;

			// Wire output listener with completion detection
			let lastOutputTime = Date.now();
			let completionDetected = false;
			let stallCheckTimer: ReturnType<typeof setInterval> | null = null;
			const workerSpawnTime = Date.now();
			// Minimum runtime before completion detection kicks in (ignore startup noise)
			const MIN_RUNTIME_MS = 60_000; // 1 minute
			// Buffer recent output to detect Claude Code completion patterns
			let recentOutput = '';

			session.emitter.on('output', (data: string) => {
				appendWorkerOutput(runId, task.id, data).catch((err) =>
					log(runId, `output write failed: ${err}`),
				);
				appendOutput(runId, task.id, data);
				emitRunEvent(runId, 'worker_output', { taskId: task.id, data });
				lastOutputTime = Date.now();
				worker.lastOutputSummary = data.slice(-200);

				// Detect Claude Code completion — only after minimum runtime
				// to avoid matching startup messages (e.g. "Resume this session")
				if (!completionDetected && session.interactive && (Date.now() - workerSpawnTime) > MIN_RUNTIME_MS) {
					recentOutput = (recentOutput + data).slice(-2000);
					// Strip ANSI codes for pattern matching
					const clean = recentOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
					// Match Claude Code's completion summary: cooking verb + "for" + duration
					// e.g. "Worked for 3m 12s", "Crunched for 45s"
					const hasCompletion = /(?:Worked|Crunched|Baked|Churned|Whisked|Toasted|Simmered|Brewed|Grilled|Roasted|Steamed|Fried|Braised|Poached|Seared|Charred) for \d/.test(clean);
					if (hasCompletion) {
						completionDetected = true;
						log(runId, `completion detected for ${task.id} — sending /exit in 5s`);
						// Wait 5s for Claude to finish any final writes, then send /exit
						setTimeout(() => {
							if (worker.status === 'running') {
								// Type /exit, then Escape to dismiss autocomplete, then Enter to confirm
								provider.sendInput(session.id, '/exit');
								setTimeout(() => {
									provider.sendInput(session.id, '\x1b'); // Escape — dismiss autocomplete
									setTimeout(() => {
										provider.sendInput(session.id, '\r'); // Enter — execute /exit
									}, 300);
								}, 500);
							}
						}, 5000);
					}
				}
			});

			// Stall detector — only fires if completion was NOT detected
			stallCheckTimer = setInterval(() => {
				if (worker.status !== 'running' || completionDetected) {
					if (stallCheckTimer) {
						clearInterval(stallCheckTimer);
						stallCheckTimer = null;
					}
					return;
				}
				const silentMs = Date.now() - lastOutputTime;
				if (silentMs >= 120_000) {
					worker.iterationCount++;
					if (session.interactive) {
						// First nudge: ask to exit. Further nudges: escalate.
						const nudge = worker.iterationCount === 1
							? '/exit'
							: '/exit';
						// Send /exit directly, then Escape (dismiss autocomplete) + Enter
						provider.sendInput(session.id, nudge);
						setTimeout(() => {
							provider.sendInput(session.id, '\x1b');
							setTimeout(() => provider.sendInput(session.id, '\r'), 300);
						}, 500);
						log(runId, `stall nudge ${worker.iterationCount} sent to ${task.id} (silent for ${Math.round(silentMs / 1000)}s)`);
					}
					if (worker.iterationCount >= 3) {
						log(runId, `killing ${task.id} — stalled after ${worker.iterationCount} nudges`);
						worker.status = 'stuck';
						worker.error = 'Worker stalled — no output for extended period';
						provider.kill(session.id);
						if (stallCheckTimer) {
							clearInterval(stallCheckTimer);
							stallCheckTimer = null;
						}
					}
					saveWorkerState(runId, worker).catch(() => {});
				}
			}, 30_000);

			// Wire exit listener
			session.emitter.on('exit', async (code: number) => {
				if (stallCheckTimer) {
					clearInterval(stallCheckTimer);
					stallCheckTimer = null;
				}
				worker.completedAt = now();
				// Exit code 0 or 129 (SIGHUP from PTY close) = done
				// On macOS, Claude Code exiting cleanly can produce exit code 129
				// when the PTY controlling terminal is destroyed on child exit.
				// Also treat as done if completion was already detected.
				const isCleanExit = code === 0 || code === 129 || completionDetected;
				if (isCleanExit) {
					worker.status = 'done';
					worker.error = undefined;
				} else if (worker.status !== 'stuck') {
					worker.status = 'failed';
				}
				if (worker.status !== 'done' && !worker.error) {
					worker.error = `Exit code: ${code}`;
				}

				// Auto-commit worker's changes so they can be merged later
				if (worker.status === 'done' && worker.worktreePath) {
					try {
						await execFileAsync('git', ['add', '-A'], { cwd: worker.worktreePath });
						await execFileAsync('git', ['commit', '-m', `feat: ${task.name}`, '--allow-empty'], { cwd: worker.worktreePath });
						log(runId, `auto-committed changes for ${task.id}`);
					} catch (commitErr) {
						log(runId, `auto-commit failed for ${task.id}: ${commitErr}`);
					}

					// Pre-merge validation — run install/typecheck/build in the
					// worker's worktree. No repair cascade (validation mode).
					// Catches broken code before it enters the merge phase.
					try {
						log(runId, `validating ${task.id}...`);
						const validation = await validateWorker(runId, worker, (line) => log(runId, line));
						worker.validation = validation;
						if (!validation.passed) {
							const failedSteps = validation.steps
								.filter((s) => s.status === 'failed')
								.map((s) => s.id)
								.join(', ');
							worker.status = 'validation_failed';
							worker.error = `validation failed: ${failedSteps}`;
							log(runId, `validation FAILED for ${task.id}: ${failedSteps}`);
						} else {
							log(runId, `validation PASSED for ${task.id} (${Math.round(validation.durationMs / 1000)}s)`);
						}
					} catch (valErr) {
						// Validator itself crashed — don't block the worker on infra issues.
						// Record the error but leave status as 'done' so merge can still attempt.
						log(runId, `validation infra error for ${task.id}: ${valErr}`);
					}
				}

				// Update run state under dispatch lock to serialize with other exits
				await withDispatchLock(async () => {
					await saveWorkerState(runId, worker);
					// Send resolved status (not raw exit code) so frontend matches server state
					emitRunEvent(runId, 'worker_exit', {
						taskId: task.id,
						exitCode: worker.status === 'done' ? 0 : code,
						resolvedStatus: worker.status,
					});

					const latestRun = await loadRun(runId);
					if (!latestRun) return;

					latestRun.workers[task.id] = worker;

					// Propagate blocked status to dependents if this worker didn't succeed
					if (worker.status === 'failed' || worker.status === 'killed' || worker.status === 'stuck' || worker.status === 'validation_failed') {
						await propagateBlockedDependents(latestRun, task, worker.status === 'validation_failed' ? 'failed' : worker.status);
					}

					// Record failure summary for PM context (current run + future runs)
					if (worker.status === 'failed' || worker.status === 'stuck' || worker.status === 'killed' || worker.status === 'validation_failed') {
						const summary: FailureSummary = {
							taskId: task.id,
							taskName: task.name,
							exitCode: typeof code === 'number' ? code : -1,
							error: worker.error || '',
							lastOutput: (worker.lastOutputSummary || '').slice(0, 500),
							iterationsUsed: worker.iterationCount,
						};
						latestRun.failureSummaries = [
							...(latestRun.failureSummaries || []),
							summary,
						];
					}

					await saveRun(latestRun);
					await regenerateBoard(runId);

					// Notify PM of worker completion/failure
					if (worker.status === 'done') {
						const doneCount = Object.values(latestRun.workers).filter(
							(w) => w.taskId !== '_pm' && w.status === 'done',
						).length;
						const totalCount = latestRun.plan.tasks.length;
						notifyPm(
							runId,
							`Worker "${task.name}" COMPLETED successfully (${doneCount}/${totalCount} done)`,
						).catch(() => {});
						emitRunEvent(runId, 'pm_notification', {
							type: 'completion',
							taskId: task.id,
							taskName: task.name,
							message: 'completed',
						});
					} else if (worker.status === 'failed' || worker.status === 'stuck') {
						const lastOutput = worker.lastOutputSummary || 'No output captured';
						const blockedDeps = latestRun.plan.tasks
							.filter((t) => t.dependsOn.includes(task.id))
							.map((t) => t.name);
						const blockedMsg =
							blockedDeps.length > 0
								? `\nBlocked dependents: ${blockedDeps.join(', ')}`
								: '';
						notifyPm(
							runId,
							`Worker "${task.name}" FAILED (${worker.status}, exit code: ${
								worker.error || 'unknown'
							})\nLast output: ${lastOutput}${blockedMsg}\nAdvise the user on how to proceed.`,
						).catch(() => {});
						emitRunEvent(runId, 'pm_notification', {
							type: 'failure',
							taskId: task.id,
							taskName: task.name,
							message: worker.error || 'failed',
						});
					}

					// Dispatch next ready workers (inner — already inside the lock)
					if (latestRun.status === 'running') {
						await dispatchReadyWorkersInner(runId).catch(() => {});
					}

					// Check for conflicts after successful worker completion
					if (worker.status === 'done') {
						checkActiveConflicts(runId).catch(() => {});
					}

					// Check if all tasks are resolved
					const allDone = latestRun.plan.tasks.every((t) => {
						const w = latestRun.workers[t.id];
						return (
							w &&
							(w.status === 'done' ||
								w.status === 'failed' ||
								w.status === 'killed' ||
								w.status === 'stuck' ||
								w.status === 'blocked' ||
								w.status === 'interrupted' ||
								w.status === 'validation_failed')
						);
					});
					if (allDone) {
						const anyFailed = latestRun.plan.tasks.some((t) => {
							const w = latestRun.workers[t.id];
							return (
								w &&
								(w.status === 'failed' ||
									w.status === 'killed' ||
									w.status === 'stuck' ||
									w.status === 'blocked' ||
									w.status === 'interrupted' ||
									w.status === 'validation_failed')
							);
						});
						const finalStatus = anyFailed ? 'failed' : 'done';
						latestRun.status = finalStatus;
						latestRun.completedAt = now();
						await saveRun(latestRun);
						log(runId, `all workers finished — ${finalStatus}`);
						emitRunEvent(runId, 'run_status', { status: finalStatus });

						// Clean up event emitter and output buffers for completed run
						cleanupRunEmitter(runId);
						cleanupOutputBuffers(runId);

						// Kill PM when run reaches terminal state
						const latestPm = latestRun.workers['_pm'];
						if (latestPm && latestPm.status === 'running' && latestPm.workerId) {
							notifyPm(
								runId,
								`Run ${finalStatus.toUpperCase()}. All workers resolved. You may now exit.`,
							).catch(() => {});
							// Give PM 5 seconds to process the notification, then send /exit
							setTimeout(() => {
								try {
									if (isPtyAlive(latestPm.workerId)) {
										writePtyInput(latestPm.workerId, '/exit\n');
									}
								} catch {
									/* ignore */
								}
							}, 5000);
						}
					}
				});
			});

			await saveWorkerState(runId, worker);
			dispatched.push(task.id);
			emitRunEvent(runId, 'worker_dispatched', { taskId: task.id, workerId: session.id });
			log(runId, `dispatched ${task.id} → worker ${session.id} in ${worktreePath}`);
		} catch (err) {
			log(runId, `failed to dispatch ${task.id}: ${err}`);
		}
	}

	if (dispatched.length > 0) {
		await saveRun(run);
		await regenerateBoard(runId);
	}

	return dispatched;
}

export async function getRunState(runId: string): Promise<OrchestrationRun | null> {
	return loadRun(runId);
}

export async function interveneAsync(runId: string, taskId: string, input: string): Promise<boolean> {
	const run = await loadRun(runId);
	if (!run) return false;

	const worker = run.workers[taskId];
	if (!worker || worker.status !== 'running') return false;

	const provider = await getProvider(worker.providerType || 'claude-code');
	if (!provider.canReceiveInput()) return false;

	return provider.sendInput(worker.workerId, input);
}

export async function killWorkerAsync(runId: string, taskId: string): Promise<boolean> {
	const run = await loadRun(runId);
	if (!run) return false;

	const worker = run.workers[taskId];
	if (!worker) return false;

	if (worker.status === 'running' && worker.workerId) {
		const provider = await getProvider(worker.providerType || 'claude-code');
		provider.kill(worker.workerId);
	}

	worker.status = 'killed';
	worker.completedAt = now();
	run.workers[taskId] = worker;
	await saveRun(run);
	await saveWorkerState(runId, worker);
	await regenerateBoard(runId);
	emitRunEvent(runId, 'worker_exit', { taskId, exitCode: -1 });
	return true;
}

export async function cancelRun(runId: string): Promise<void> {
	const run = await loadRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);

	// Kill all living workers
	for (const [taskId, worker] of Object.entries(run.workers)) {
		if (worker.status === 'running') {
			try {
				const provider = await getProvider(worker.providerType || 'claude-code');
				if (provider.isAlive(worker.workerId)) {
					provider.kill(worker.workerId);
				}
			} catch { /* ignore — may already be dead */ }
			worker.status = 'killed';
			worker.completedAt = now();
			await saveWorkerState(runId, worker);
		}
	}

	run.status = 'cancelled';
	run.completedAt = now();
	await saveRun(run);
	await regenerateBoard(runId);
	emitRunEvent(runId, 'run_status', { status: 'cancelled' });
	cleanupRunEmitter(runId);
	cleanupOutputBuffers(runId);
	log(runId, 'cancelled');
}

// ── Conflict detection ───────────────────────────────────────────

/**
 * Check for merge conflicts between completed worker branches.
 * Runs after each worker completes. Uses git merge-tree (dry run only,
 * no working-tree changes).
 */
export async function checkActiveConflicts(runId: string): Promise<ConflictReport[]> {
	const run = await loadRun(runId);
	if (!run) return [];

	const completedTasks = run.plan.tasks.filter((t) => {
		const w = run.workers[t.id];
		return w && w.status === 'done' && w.branch;
	});

	if (completedTasks.length < 1) return [];

	const reports: ConflictReport[] = [];

	// Check each completed branch against main
	for (const task of completedTasks) {
		const worker = run.workers[task.id];
		try {
			const result = await dryRunMerge(run.projectPath, worker.branch);
			if (!result.canMerge) {
				// Filter out auto-generated CLAUDE.md (always conflicts, always safe to ignore)
				const filteredConflicts = result.conflicts.filter((f) => !f.endsWith('CLAUDE.md'));
				if (filteredConflicts.length === 0) continue;
				reports.push({
					taskA: task.id,
					taskB: 'main',
					files: filteredConflicts,
					severity: 'warn',
					description: `"${task.name}" would conflict with main branch`,
				});
			}
		} catch { /* skip on error */ }
	}

	// Pairwise check between completed branches (cap at 10 pairs)
	let pairCount = 0;
	for (let i = 0; i < completedTasks.length && pairCount < 10; i++) {
		for (let j = i + 1; j < completedTasks.length && pairCount < 10; j++) {
			pairCount++;
			const branchA = run.workers[completedTasks[i].id].branch;
			const branchB = run.workers[completedTasks[j].id].branch;

			try {
				const result = await dryRunMerge(run.projectPath, branchB, branchA);
				if (!result.canMerge) {
					// Filter out auto-generated CLAUDE.md (always conflicts, always safe to ignore)
					const filteredConflicts = result.conflicts.filter((f) => !f.endsWith('CLAUDE.md'));
					if (filteredConflicts.length === 0) continue;
					reports.push({
						taskA: completedTasks[i].id,
						taskB: completedTasks[j].id,
						files: filteredConflicts,
						severity: 'block',
						description: `"${completedTasks[i].name}" and "${completedTasks[j].name}" have conflicting changes`,
					});
				}
			} catch { /* skip on error */ }
		}
	}

	// Store reports on the run. Re-read + merge under the dispatch lock —
	// checkActiveConflicts runs fire-and-forget in parallel with other worker
	// exits, so blindly saving `run` here would stomp status fields that
	// later workers wrote while we were running dryRunMerge.
	await withDispatchLock(async () => {
		const fresh = await loadRun(runId);
		if (!fresh) return;
		fresh.conflictReports = reports;
		await saveRun(fresh);
	});

	// Notify PM if conflicts found
	if (reports.length > 0) {
		const blockConflicts = reports.filter((r) => r.severity === 'block');
		const warnConflicts = reports.filter((r) => r.severity === 'warn');
		let msg = `CONFLICT DETECTED: ${reports.length} conflict(s) found.`;
		if (blockConflicts.length > 0) {
			msg += `\nBLOCKING: ${blockConflicts.map((r) => r.description).join('; ')}`;
		}
		if (warnConflicts.length > 0) {
			msg += `\nWARNING: ${warnConflicts.map((r) => r.description).join('; ')}`;
		}
		msg += '\nAdvise the user on merge strategy.';
		notifyPm(runId, msg).catch(() => {});

		emitRunEvent(runId, 'conflicts_detected', { conflicts: reports });
	}

	return reports;
}

// ── Merge ────────────────────────────────────────────────────────

export async function beginMerge(
	runId: string,
): Promise<{ merged: string[]; conflicts: Record<string, string[]> }> {
	const run = await loadRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);

	run.status = 'merging';
	await saveRun(run);

	const merged: string[] = [];
	const conflicts: Record<string, string[]> = {};

	// Topological sort — merge leaves (no deps) first, roots (many deps) last
	const completedIds = new Set(
		run.plan.tasks.filter((t) => run.workers[t.id]?.status === 'done').map((t) => t.id),
	);

	const sorted: TaskNode[] = [];
	const visited = new Set<string>();

	const visit = (task: TaskNode): void => {
		if (visited.has(task.id)) return;
		visited.add(task.id);
		for (const depId of task.dependsOn) {
			const dep = run.plan.tasks.find((t) => t.id === depId);
			if (dep && completedIds.has(dep.id)) visit(dep);
		}
		sorted.push(task);
	};

	for (const task of run.plan.tasks) {
		if (completedIds.has(task.id)) visit(task);
	}

	const completedTasks = sorted;

	for (const task of completedTasks) {
		const worker = run.workers[task.id];
		const branch = worker.branch;

		// Skip if branch is already merged (idempotent)
		try {
			const { stdout: mergedBranches } = await execFileAsync(
				'git',
				['branch', '--merged'],
				{ cwd: run.projectPath },
			);
			const alreadyMerged = mergedBranches
				.split('\n')
				.some((line) => line.replace(/^\*?\s*/, '').trim() === branch);
			if (alreadyMerged) {
				merged.push(task.id);
				run.mergeLog.push(`[${now()}] ${branch}: already merged (skipped)`);
				continue;
			}
		} catch { /* proceed with merge check */ }

		// Dry run first
		const dryResult = await dryRunMerge(run.projectPath, branch);

		if (dryResult.canMerge) {
			const mergeResult = await mergeBranch(run.projectPath, branch);
			if (mergeResult.success) {
				merged.push(task.id);
				run.mergeLog.push(`[${now()}] Merged ${branch}: ${mergeResult.message}`);
			} else {
				conflicts[task.id] = mergeResult.conflicts;
				run.mergeLog.push(`[${now()}] CONFLICT merging ${branch}: ${mergeResult.conflicts.join(', ')}`);
			}
		} else {
			conflicts[task.id] = dryResult.conflicts;
			run.mergeLog.push(`[${now()}] WOULD CONFLICT ${branch}: ${dryResult.conflicts.join(', ')}`);
		}
	}

	run.status = Object.keys(conflicts).length === 0 ? 'done' : 'failed';
	run.completedAt = now();
	await saveRun(run);
	await regenerateBoard(runId);

	log(runId, `merge complete — ${merged.length} merged, ${Object.keys(conflicts).length} conflicts`);
	return { merged, conflicts };
}

// ── Cleanup ──────────────────────────────────────────────────────

export async function cleanupRun(runId: string, deleteBranches = false): Promise<void> {
	const run = await loadRun(runId);
	if (!run) return;

	// Remove all worktrees for this run
	const worktrees = await listWorktrees(run.projectPath, runId);
	for (const wt of worktrees) {
		try {
			await removeWorktree(wt.path, true);
		} catch (err) {
			log(runId, `failed to remove worktree ${wt.path}: ${err}`);
		}

		if (deleteBranches) {
			try {
				await deleteBranch(run.projectPath, wt.branch);
			} catch (err) {
				log(runId, `failed to delete branch ${wt.branch}: ${err}`);
			}
		}
	}

	await pruneWorktrees(run.projectPath);
	log(runId, 'cleanup complete');
}

// ── Recovery ─────────────────────────────────────────────────────

/**
 * Scan persisted runs and detect workers whose PTY sessions died
 * (typically after a server restart). Mark them as 'interrupted'
 * and update run status accordingly.
 */
export async function recoverRuns(): Promise<{ recovered: number; interrupted: number }> {
	const runs = await listRuns(999);
	let recovered = 0;
	let interrupted = 0;

	for (const run of runs) {
		if (
			run.status !== 'running' &&
			run.status !== 'approved' &&
			run.status !== 'merging'
		) {
			continue;
		}

		let runModified = false;

		for (const [taskId, worker] of Object.entries(run.workers)) {
			if (worker.status !== 'running') continue;

			let alive = false;
			try {
				if (worker.providerType) {
					const provider = await getProvider(worker.providerType);
					alive = provider.isAlive(worker.workerId);
				} else {
					// Legacy workers without providerType — fall back to PTY check
					alive = isPtyAlive(worker.workerId);
				}
			} catch {
				// Provider unavailable — treat as dead
				alive = false;
			}
			if (alive) continue;

			worker.status = 'interrupted';
			worker.completedAt = now();
			worker.error = 'Process interrupted by server restart';
			await saveWorkerState(run.runId, worker);
			runModified = true;
			interrupted++;
			log(run.runId, `worker ${taskId} marked as interrupted (session ${worker.workerId} dead)`);
		}

		if (!runModified) continue;
		recovered++;

		if (run.status === 'merging') {
			run.mergeLog = [
				...run.mergeLog,
				`[${now()}] Merge interrupted by server restart`,
			];
			run.status = 'failed';
			await saveRun(run);
			await regenerateBoard(run.runId);
			continue;
		}

		const realWorkers = Object.entries(run.workers).filter(([id]) => id !== '_pm');
		const allResolved =
			realWorkers.length > 0 &&
			realWorkers.every(
				([, w]) =>
					w.status === 'done' ||
					w.status === 'failed' ||
					w.status === 'killed' ||
					w.status === 'stuck' ||
					w.status === 'blocked' ||
					w.status === 'interrupted',
			);

		if (allResolved && run.status === 'running') {
			run.status = 'failed';
		}

		await saveRun(run);
		await regenerateBoard(run.runId);
	}

	if (recovered > 0) {
		console.log(
			`[orchestration] Recovery: ${recovered} runs scanned, ${interrupted} workers marked interrupted`,
		);
	}

	return { recovered, interrupted };
}

/**
 * Resume a failed run by re-dispatching workers that were interrupted.
 * Deletes interrupted worker entries (and any downstream blocked entries)
 * so the normal dispatch pass re-creates them from scratch.
 */
export async function resumeRun(runId: string): Promise<OrchestrationRun> {
	const run = await loadRun(runId);
	if (!run) throw new Error(`Run not found: ${runId}`);

	const interruptedWorkers = Object.entries(run.workers).filter(
		([id, w]) => id !== '_pm' && w.status === 'interrupted',
	);

	if (interruptedWorkers.length === 0) {
		throw new Error('No interrupted workers to resume');
	}

	for (const [taskId, worker] of interruptedWorkers) {
		if (worker.worktreePath) {
			try {
				await removeWorktree(worker.worktreePath, true);
			} catch (err) {
				log(runId, `cleanup worktree for ${taskId} failed: ${err}`);
			}
		}
		delete run.workers[taskId];
	}

	for (const [taskId, worker] of Object.entries(run.workers)) {
		if (taskId === '_pm') continue;
		if (worker.status !== 'blocked') continue;

		const task = run.plan.tasks.find((t) => t.id === taskId);
		if (!task) continue;

		const hasInterruptedDep = task.dependsOn.some(
			(depId) => !run.workers[depId] || run.workers[depId].status === 'interrupted',
		);
		if (hasInterruptedDep) {
			delete run.workers[taskId];
		}
	}

	run.status = 'running';
	await saveRun(run);
	await regenerateBoard(runId);

	log(runId, `resuming — ${interruptedWorkers.length} workers will be re-dispatched`);

	await withDispatchLock(() => dispatchReadyWorkersInner(runId));

	return (await loadRun(runId))!;
}
