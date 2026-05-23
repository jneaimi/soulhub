/** Scheduler lifecycle.
 *
 *  Three responsibilities:
 *
 *    1. **initSchedulerCore(snapshot)** — boot hook. Sweeps stale
 *       started rows, reconciles the registry against settings, then
 *       runs catchup-on-boot. Wired from `hooks.server.ts`.
 *
 *    2. **reconcileFromSettings(snapshot)** — diff the current registry
 *       against settings and reach the target state via add / remove /
 *       re-register. Idempotent. Called both at boot and after every
 *       successful POST /api/settings.
 *
 *    3. **shutdownScheduler()** — stop every task. Called by the
 *       graceful-shutdown handler so PM2 reload doesn't leak cron
 *       intervals.
 *
 *  Design notes:
 *
 *    - Reconcile only re-registers a task if its cron / timezone /
 *      noOverlap changed. Editing `description` alone doesn't bounce
 *      the schedule.
 *    - Tasks whose `type` isn't registered as a handler are SKIPPED
 *      (with a warning), not errored. This tolerates incremental
 *      rollout — e.g. a user upgrading between phases shouldn't see
 *      the scheduler refuse to start because Phase 4 task types
 *      aren't installed yet.
 *    - `enabled: false` tasks are unregistered if currently running,
 *      otherwise ignored.
 *    - Critical: `reconcile` operates on the snapshot, not on
 *      `config` directly. This keeps the function pure-ish and
 *      testable, and protects against the
 *      `feedback_settings_post_empty_clobbers` failure mode (passing
 *      `{tasks: []}` would wipe everything; that's the contract — the
 *      caller is responsible for sending a non-clobbering snapshot.
 *      POST /api/settings already enforces deep-merge before reload).
 */

import type { SchedulerTaskSchema, SchedulerSchema } from '../config.schema.js';
import type { z } from 'zod';
import {
	register,
	unregister,
	list,
	getTask as getRegisteredTask,
	destroyAllTasks,
} from './registry.js';
import { getTaskHandler } from './task-types.js';
import { sweepStaleStartedRows } from './sweep.js';
import { applyCatchupOnBoot } from './catchup.js';

type SchedulerSnapshot = z.infer<typeof SchedulerSchema>;
type SchedulerTaskSpec = z.infer<typeof SchedulerTaskSchema>;

export interface ReconcileResult {
	registered: string[];
	unregistered: string[];
	updated: string[];
	unchanged: string[];
	skipped: { taskId: string; reason: string }[];
}

/** What identifies a "no-op" reconcile for a task — the fields whose
 *  change requires re-registering the cron schedule. Description
 *  changes alone don't bounce. */
function rescheduleSignature(spec: SchedulerTaskSpec): string {
	return JSON.stringify([spec.cron, spec.timezone ?? null, spec.noOverlap]);
}

const lastSpecSig = new Map<string, string>();

export function reconcileFromSettings(snapshot: SchedulerSnapshot): ReconcileResult {
	const result: ReconcileResult = {
		registered: [],
		unregistered: [],
		updated: [],
		unchanged: [],
		skipped: [],
	};

	if (!snapshot.enabled) {
		// Scheduler globally disabled — tear everything down. Note: this
		// is a settings-driven kill switch, distinct from
		// `shutdownScheduler()` which is a process-shutdown path.
		const all = list().map((t) => t.id);
		for (const id of all) {
			unregister(id);
			lastSpecSig.delete(id);
			result.unregistered.push(id);
		}
		return result;
	}

	const desiredById = new Map<string, SchedulerTaskSpec>();
	for (const spec of snapshot.tasks) {
		if (!spec.enabled) continue;
		desiredById.set(spec.id, spec);
	}

	// Pass 1: drop tasks no longer desired (or that flipped to disabled).
	for (const live of list()) {
		if (!desiredById.has(live.id)) {
			unregister(live.id);
			lastSpecSig.delete(live.id);
			result.unregistered.push(live.id);
		}
	}

	// Pass 2: register-or-update everything still desired.
	for (const spec of desiredById.values()) {
		const handler = getTaskHandler(spec.type);
		if (!handler) {
			result.skipped.push({
				taskId: spec.id,
				reason: `unknown task type: ${spec.type}`,
			});
			console.warn(
				`[scheduler] reconcile: skipping ${spec.id} — type '${spec.type}' has no registered handler`,
			);
			continue;
		}

		let fn;
		try {
			fn = handler.factory(spec.params);
		} catch (err) {
			result.skipped.push({
				taskId: spec.id,
				reason: `factory threw: ${(err as Error).message}`,
			});
			console.error(`[scheduler] reconcile: factory failed for ${spec.id}:`, err);
			continue;
		}

		const live = getRegisteredTask(spec.id);
		const sig = rescheduleSignature(spec);

		if (!live) {
			register({
				id: spec.id,
				cron: spec.cron,
				timezone: spec.timezone,
				noOverlap: spec.noOverlap,
				description: spec.description,
				catchupPolicy: spec.catchupPolicy,
				fn,
			});
			lastSpecSig.set(spec.id, sig);
			result.registered.push(spec.id);
			continue;
		}

		const prevSig = lastSpecSig.get(spec.id);
		if (prevSig === sig) {
			result.unchanged.push(spec.id);
			continue;
		}

		// Schedule-relevant fields changed — bounce.
		unregister(spec.id);
		register({
			id: spec.id,
			cron: spec.cron,
			timezone: spec.timezone,
			noOverlap: spec.noOverlap,
			description: spec.description,
			catchupPolicy: spec.catchupPolicy,
			fn,
		});
		lastSpecSig.set(spec.id, sig);
		result.updated.push(spec.id);
	}

	return result;
}

export interface InitResult {
	swept: number;
	reconcile: ReconcileResult;
	catchupFired: number;
}

/** Boot-time entrypoint. Order:
 *    1. Sweep stale rows (so overlap protection isn't pre-jammed).
 *    2. Reconcile the registry against settings.
 *    3. Run catchup-on-boot (each task may fire once if it missed its
 *       scheduled slot while the process was down).
 *
 *  Safe to call exactly once at startup. Tests can call it after
 *  manipulating the registry/handlers, but normal request handlers
 *  should call `reconcileFromSettings` only. */
export async function initSchedulerCore(
	snapshot: SchedulerSnapshot,
): Promise<InitResult> {
	if (!snapshot.enabled) {
		console.log('[scheduler] disabled by settings — skipping init');
		return {
			swept: 0,
			reconcile: { registered: [], unregistered: [], updated: [], unchanged: [], skipped: [] },
			catchupFired: 0,
		};
	}

	const sweep = sweepStaleStartedRows(snapshot.staleRunMaxRuntimeMs);
	const reconcile = reconcileFromSettings(snapshot);
	const tasks = list();
	const catchup = await applyCatchupOnBoot(tasks);
	const catchupFired = catchup.filter((c) => c.fired).length;

	console.log(
		`[scheduler] init complete: ${reconcile.registered.length} registered, ` +
			`${reconcile.skipped.length} skipped, ${sweep.swept} stale row(s) closed, ` +
			`${catchupFired} catchup fired`,
	);

	return { swept: sweep.swept, reconcile, catchupFired };
}

/** Stop every registered task. For PM2 reload / process shutdown.
 *  Idempotent — safe to call multiple times. */
export function shutdownScheduler(): void {
	const before = list().length;
	destroyAllTasks();
	lastSpecSig.clear();
	if (before > 0) {
		console.log(`[scheduler] shutdown: stopped ${before} task(s)`);
	}
}

/** Test-only helper to clear the lastSpecSig cache so reconcile
 *  decisions don't leak across tests. */
export function _resetLifecycleForTests(): void {
	lastSpecSig.clear();
}
