/** Task handler: vault-hygiene (ADR-001 P3).
 *
 *  Runs the keeper's auto-fix + escalation tick on its own scheduler cadence.
 *  Previously this piggybacked on the heartbeat's private timer (ADR-010); with
 *  the heartbeat now scheduler-native, hygiene gets its own every-30-minutes
 *  task and its own `scheduler_runs` records — it was always documented as
 *  running "independently" of the proactive nudge. */

import type { TaskFn } from '../task-types.js';
import { tickVaultHygiene } from '../../vault-hygiene/index.js';

export function vaultHygieneTaskFactory(_params: unknown): TaskFn {
	return async () => {
		return await tickVaultHygiene();
	};
}
