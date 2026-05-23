/** Domain-agnostic task registry.
 *
 *  Wraps node-cron v4 with a simple register/unregister/list/runNow API.
 *  Each registered task gets a `recordRun()` wrapper around its callback
 *  so every invocation lands in `scheduler_runs` — same shape whether the
 *  task fires from cron or from `runNow()`.
 *
 *  Phase 1 scope: programmatic API only. Settings.json wiring,
 *  hot-reload, and catchup-on-boot land in Phase 2.
 */

import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { recordRun, getActiveAbortController, isRunActive, type RecordRunResult } from './runner.js';
import { lastSuccessfulRun, runHistory, type RunRow } from './db.js';
import type { TaskFn } from './task-types.js';

export interface Task {
	id: string;
	cron: string;
	timezone?: string;
	noOverlap?: boolean;
	description?: string;
	/** `skip` excludes the task from catchup-on-boot (ADR
	 *  2026-05-22-graceful-shutdown-fix P2). Absent/`run` = default behaviour. */
	catchupPolicy?: 'run' | 'skip';
	fn: TaskFn;
}

export interface TaskInfo {
	id: string;
	cron: string;
	timezone: string | null;
	noOverlap: boolean;
	description: string | null;
	catchupPolicy: 'run' | 'skip' | null;
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastStatus: string | null;
}

interface RegisteredTask {
	task: Task;
	scheduled: ScheduledTask;
}

const registry = new Map<string, RegisteredTask>();

export class SchedulerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SchedulerError';
	}
}

export function register(task: Task): void {
	if (!task.id) throw new SchedulerError('Task id is required');
	if (registry.has(task.id)) {
		throw new SchedulerError(`Task already registered: ${task.id}`);
	}
	if (!cron.validate(task.cron)) {
		throw new SchedulerError(`Invalid cron expression for ${task.id}: ${task.cron}`);
	}

	// Note: we do NOT pass `noOverlap` to node-cron. Its overlap guard
	// blocks the second tick at the library level and our wrapper never
	// runs, so the skip wouldn't land in `scheduler_runs`. We enforce
	// overlap in the runner via `hasActiveRun` so every skipped tick is
	// observable in run history and the check naturally extends to
	// cross-process scenarios via the shared SQLite DB.
	const scheduled = cron.schedule(
		task.cron,
		async (ctx) => {
			const scheduledFor = ctx?.date instanceof Date
				? ctx.date.toISOString()
				: new Date().toISOString();
			await recordRun(task.id, task.fn, {
				noOverlap: task.noOverlap === true,
				scheduledFor,
			});
		},
		{
			name: task.id,
			timezone: task.timezone,
		},
	);

	registry.set(task.id, { task, scheduled });
	console.log(`[scheduler] registered: ${task.id} — ${task.cron}${task.timezone ? ` (${task.timezone})` : ''}`);
}

export function unregister(taskId: string): boolean {
	const entry = registry.get(taskId);
	if (!entry) return false;
	void entry.scheduled.destroy();
	registry.delete(taskId);
	console.log(`[scheduler] unregistered: ${taskId}`);
	return true;
}

export function getTask(taskId: string): TaskInfo | null {
	const entry = registry.get(taskId);
	if (!entry) return null;
	return toInfo(entry);
}

export function list(): TaskInfo[] {
	return Array.from(registry.values()).map(toInfo);
}

/** Run a registered task immediately. Bypasses the cron schedule but
 *  goes through the same `recordRun` wrapper so it lands in history.
 *  Honours the task's noOverlap flag. */
export async function runNow(taskId: string): Promise<RecordRunResult> {
	const entry = registry.get(taskId);
	if (!entry) {
		throw new SchedulerError(`Task not registered: ${taskId}`);
	}
	const { task } = entry;
	return recordRun(task.id, task.fn, {
		noOverlap: task.noOverlap === true,
	});
}

/** Cancel an in-flight run by aborting its AbortSignal. Handlers that
 *  wired the signal (shell-script SIGTERM, vault-scout chained signal)
 *  will bail immediately. Handlers that ignore the signal complete
 *  naturally; `recordRun` still flags the row as cancelled because
 *  `signal.aborted` is checked in its finally block. Returns true if a
 *  run was active for the task, false otherwise — caller surfaces that
 *  to the UI ("cancel requested" vs "no active run"). */
export function killRun(taskId: string): boolean {
	const controller = getActiveAbortController(taskId);
	if (!controller) return false;
	controller.abort();
	console.warn(`[scheduler] ${taskId}: kill requested`);
	return true;
}

export function isTaskRunning(taskId: string): boolean {
	return isRunActive(taskId);
}

function computeNextRun(cronExpr: string, timezone?: string): Date | null {
	// node-cron v4's `ScheduledTask.getNextRun()` is broken for weekly
	// crons (returns dates years in the future for `0 9 * * 0`). Use
	// cron-parser — already a dep for catchup, gives the correct
	// upcoming fire time.
	try {
		const it = CronExpressionParser.parse(cronExpr, {
			currentDate: new Date(),
			tz: timezone,
		});
		return it.next().toDate();
	} catch {
		return null;
	}
}

function toInfo(entry: RegisteredTask): TaskInfo {
	const { task } = entry;
	const next = computeNextRun(task.cron, task.timezone);
	const last = lastSuccessfulRun(task.id);
	const recent = runHistory(task.id, 1)[0] as RunRow | undefined;
	return {
		id: task.id,
		cron: task.cron,
		timezone: task.timezone ?? null,
		noOverlap: task.noOverlap === true,
		description: task.description ?? null,
		catchupPolicy: task.catchupPolicy ?? null,
		nextRunAt: next ? next.toISOString() : null,
		lastRunAt: last?.startedAt ?? recent?.startedAt ?? null,
		lastStatus: recent?.status ?? null,
	};
}

/** Stop every registered task and clear the registry. Used by
 *  `shutdownScheduler()` (production: PM2 reload) and by tests for
 *  fixture isolation. Idempotent — safe to call when registry is
 *  already empty. */
export function destroyAllTasks(): void {
	for (const entry of registry.values()) {
		void entry.scheduled.destroy();
	}
	registry.clear();
}
