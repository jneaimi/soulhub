/** Task handler: heartbeat (ADR-001 P3).
 *
 *  Wraps one proactive heartbeat tick as a scheduler trigger-type, replacing
 *  the engine's retired private `node-cron`/`setInterval`. The cron fires every
 *  30m around the clock; `runHeartbeatOnce` applies its own active-hours / mute
 *  / daily-cap gates and no-ops (with an audit row) outside the active window —
 *  the "let it tick and no-op" contract. The returned status is recorded in
 *  `scheduler_runs`.
 *
 *  `runHeartbeatOnce` is bounded (one LLM call), so the handler doesn't thread
 *  `ctx.signal` — there's no long-running loop to abort. */

import type { TaskFn } from '../task-types.js';
import { runHeartbeatOnce } from '../../heartbeat/heartbeat.js';

export function heartbeatTaskFactory(_params: unknown): TaskFn {
	return async () => {
		return await runHeartbeatOnce('scheduled');
	};
}
