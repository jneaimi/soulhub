/** Run-record wrapper.
 *
 *  `recordRun` is the single execution path for any scheduled task. It
 *  inserts a `started` row, invokes the user callback, then updates the
 *  row to `success` or `error`. If `noOverlap` is set and a previous
 *  invocation is still live, it inserts an `overlap-skipped` row instead.
 *
 *  The wrapper is independent of node-cron; the registry passes its
 *  callback through here, but `runNow` and tests can call this directly.
 */

import {
	hasActiveRun,
	recordRunStarted,
	recordRunFinished,
	recordRunError,
	recordRunSkippedOverlap,
	type RunStatus,
} from './db.js';
import type { TaskFn } from './task-types.js';

export interface RecordRunOptions {
	/** Skip the run if a previous one is still in flight. */
	noOverlap?: boolean;
	/** ISO timestamp of the scheduled tick. Defaults to now (good enough
	 *  for `runNow`; cron callers can pass the actual fire time). */
	scheduledFor?: string;
}

export interface RecordRunResult {
	status: RunStatus;
	runId: number | null;
	durationMs: number;
	output?: unknown;
	error?: string;
}

/** Active runs keyed by taskId. Map value is the AbortController whose
 *  signal was passed to the handler — `killRun(taskId)` aborts it.
 *  noOverlap guarantees at most one entry per taskId; without noOverlap
 *  the most-recent runner overwrites the older entry and the older run
 *  loses its cancel handle (acceptable: cancel applies to the
 *  user-visible "running" pill, which always reflects the latest run).
 *  Lives in this module — not the registry — so cron-driven and
 *  runNow-driven invocations share one source of truth. */
const activeControllers = new Map<string, AbortController>();

export function getActiveAbortController(taskId: string): AbortController | undefined {
	return activeControllers.get(taskId);
}

export function isRunActive(taskId: string): boolean {
	return activeControllers.has(taskId);
}

export async function recordRun(
	taskId: string,
	fn: TaskFn,
	opts: RecordRunOptions = {},
): Promise<RecordRunResult> {
	const scheduledFor = opts.scheduledFor ?? new Date().toISOString();

	if (opts.noOverlap && hasActiveRun(taskId)) {
		const runId = recordRunSkippedOverlap(taskId, scheduledFor);
		console.warn(`[scheduler] ${taskId}: overlap-skipped (previous run still active)`);
		return { status: 'overlap-skipped', runId, durationMs: 0 };
	}

	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const runId = recordRunStarted({ taskId, scheduledFor, startedAt });
	const controller = new AbortController();
	activeControllers.set(taskId, controller);

	try {
		const output = await fn({ signal: controller.signal });
		const durationMs = Date.now() - startedAtMs;
		// If the run was cancelled mid-flight but the handler still
		// returned cleanly (some handlers don't honour the signal),
		// record it as cancelled rather than success — the user pressed
		// cancel for a reason.
		if (controller.signal.aborted) {
			recordRunError(runId, {
				durationMs,
				errorMessage: 'cancelled by user',
			});
			return { status: 'error', runId, durationMs, error: 'cancelled by user' };
		}
		recordRunFinished(runId, {
			durationMs,
			outputSummary: output ?? null,
		});
		return { status: 'success', runId, durationMs, output };
	} catch (err) {
		const durationMs = Date.now() - startedAtMs;
		const cancelled = controller.signal.aborted;
		const errorMessage = cancelled
			? 'cancelled by user'
			: err instanceof Error
				? `${err.message}\n${err.stack ?? ''}`.trim()
				: String(err);
		recordRunError(runId, { durationMs, errorMessage });
		if (cancelled) {
			console.warn(`[scheduler] ${taskId}: cancelled after ${durationMs}ms`);
		} else {
			console.error(`[scheduler] ${taskId}: error after ${durationMs}ms — ${errorMessage}`);
		}
		return { status: 'error', runId, durationMs, error: errorMessage };
	} finally {
		// Only clear the map entry if it's still ours — without noOverlap
		// a newer run may have overwritten it.
		if (activeControllers.get(taskId) === controller) {
			activeControllers.delete(taskId);
		}
	}
}
