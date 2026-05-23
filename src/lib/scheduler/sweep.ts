/** Stale-row sweep.
 *
 *  If the process crashes mid-run, a `started` row stays open with no
 *  `finished_at`. `hasActiveRun` then returns true forever for that
 *  task, jamming overlap protection. The sweep closes any `started`
 *  row whose `started_at` is older than `maxRuntimeMs`, marking it as
 *  `error: 'process-crashed'` so run history makes the failure visible.
 *
 *  Called once at boot before tasks are reconciled. Phase 1 surfaced
 *  this gap; Phase 2 fixes it.
 */

import { getHeartbeatDb } from '../channels/whatsapp/heartbeat-state.js';

export interface SweepResult {
	swept: number;
	rowIds: number[];
}

const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000; // 30 min

export function sweepStaleStartedRows(
	maxRuntimeMs: number = DEFAULT_MAX_RUNTIME_MS,
	now: Date = new Date(),
): SweepResult {
	const cutoffIso = new Date(now.getTime() - maxRuntimeMs).toISOString();
	const db = getHeartbeatDb();

	const stale = db
		.prepare(
			`SELECT id FROM scheduler_runs
			 WHERE status = 'started'
			   AND finished_at IS NULL
			   AND started_at < ?`,
		)
		.all(cutoffIso) as { id: number }[];

	if (stale.length === 0) return { swept: 0, rowIds: [] };

	const ids = stale.map((r) => r.id);
	const finishedAt = now.toISOString();
	const update = db.prepare(
		`UPDATE scheduler_runs
		 SET finished_at = ?, status = 'error',
		     error_message = 'process-crashed (stale-sweep on boot)'
		 WHERE id = ?`,
	);
	const tx = db.transaction((rows: number[]) => {
		for (const id of rows) update.run(finishedAt, id);
	});
	tx(ids);

	console.warn(`[scheduler] sweep closed ${ids.length} stale started row(s)`);
	return { swept: ids.length, rowIds: ids };
}
