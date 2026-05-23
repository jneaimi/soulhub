/** Missed-run catchup.
 *
 *  When the process restarts, any task whose previous scheduled fire
 *  was missed should fire once before normal cron resumes. We detect
 *  "missed" by comparing the most recent prev-fire-time of the cron
 *  expression to the task's last successful run — if the prev-fire
 *  happened after that, we missed it.
 *
 *  We deliberately fire at most one catchup per task per boot. The
 *  goal is "the user gets their Sunday digest by Monday morning if
 *  PM2 was down at 09:00 Sunday", not "replay every missed week."
 */

import { CronExpressionParser } from 'cron-parser';
import { lastSuccessfulRun } from './db.js';
import { runNow } from './registry.js';
import type { TaskInfo } from './registry.js';
import type { RecordRunResult } from './runner.js';

export interface CatchupOutcome {
	taskId: string;
	fired: boolean;
	reason: 'no-prev-fire' | 'caught-up' | 'never-ran' | 'cron-error' | 'fired' | 'skip-policy';
	prevFireAt?: string;
	lastSuccessAt?: string;
	runResult?: RecordRunResult;
}

/** Fire a single catchup run for `task` if appropriate. Pure-ish:
 *  takes a task description, returns an outcome — no globals beyond
 *  the DB read and `runNow` call. */
export async function catchupTask(
	task: TaskInfo,
	now: Date = new Date(),
): Promise<CatchupOutcome> {
	// Measurement tasks (falsifiers, liveness probes) opt out of catchup —
	// re-running a stale measurement on every restart has no value and spams
	// the hygiene page (ADR 2026-05-22-graceful-shutdown-fix P2).
	if (task.catchupPolicy === 'skip') {
		return { taskId: task.id, fired: false, reason: 'skip-policy' };
	}

	let prevFireAt: Date;
	try {
		const it = CronExpressionParser.parse(task.cron, {
			currentDate: now,
			tz: task.timezone ?? undefined,
		});
		prevFireAt = it.prev().toDate();
	} catch (err) {
		console.warn(`[scheduler] catchup: cron parse failed for ${task.id}: ${(err as Error).message}`);
		return { taskId: task.id, fired: false, reason: 'cron-error' };
	}

	const lastSuccess = lastSuccessfulRun(task.id);

	if (!lastSuccess) {
		// First-ever boot for this task — don't replay history.
		return {
			taskId: task.id,
			fired: false,
			reason: 'never-ran',
			prevFireAt: prevFireAt.toISOString(),
		};
	}

	const lastSuccessAt = lastSuccess.startedAt;
	if (new Date(lastSuccessAt).getTime() >= prevFireAt.getTime()) {
		// Last successful run was at or after the most recent scheduled
		// fire — nothing to catch up.
		return {
			taskId: task.id,
			fired: false,
			reason: 'caught-up',
			prevFireAt: prevFireAt.toISOString(),
			lastSuccessAt,
		};
	}

	console.log(
		`[scheduler] catchup firing ${task.id}: prev-fire ${prevFireAt.toISOString()} > last-success ${lastSuccessAt}`,
	);
	const runResult = await runNow(task.id);
	return {
		taskId: task.id,
		fired: true,
		reason: 'fired',
		prevFireAt: prevFireAt.toISOString(),
		lastSuccessAt,
		runResult,
	};
}

/** Run catchup against every task in the iterable. Sequential by
 *  design — concurrent catchups can hammer external services and
 *  catchup is rare enough to not need parallelism. */
export async function applyCatchupOnBoot(
	tasks: Iterable<TaskInfo>,
	now: Date = new Date(),
): Promise<CatchupOutcome[]> {
	const results: CatchupOutcome[] = [];
	for (const task of tasks) {
		results.push(await catchupTask(task, now));
	}
	const fired = results.filter((r) => r.fired).length;
	if (fired > 0) {
		console.log(`[scheduler] catchup-on-boot fired ${fired}/${results.length} task(s)`);
	}
	return results;
}
