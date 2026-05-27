/** Task handler: vault-hygiene (ADR-001 P3).
 *
 *  Runs the deterministic vault-hygiene janitor pass on its own scheduler
 *  cadence (every 30 min). ADR-008 (2026-05-26): replaced the keeper agent
 *  dispatch with a direct call to the deterministic janitor — no LLM, no agent.
 *  Previously this piggybacked on the heartbeat's private timer (ADR-010); with
 *  the heartbeat now scheduler-native, hygiene gets its own every-30-minutes
 *  task and its own `scheduler_runs` records. */

import type { TaskFn } from '../task-types.js';
import { tickVaultHygiene } from '../../vault-hygiene/index.js';

export function vaultHygieneTaskFactory(_params: unknown): TaskFn {
	return async () => {
		return await tickVaultHygiene();
	};
}
