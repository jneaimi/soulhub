/** Task handler: contract-registry-falsifier (soul-hub-governance ADR-002, P2).
 *
 *  The runtime safety-net for the contract registry. Two jobs each tick:
 *    1. Recompile the on-disk cache from the vault source (keeps `touching`
 *       answers fresh even if a vault-write recompile was missed).
 *    2. Run the registry's own self-falsifier (resolution + freshness).
 *
 *  A clean check returns its summary (the run records `success`). A registry
 *  with violations THROWS, so the run records `error` and surfaces red on the
 *  `/hygiene` automations dashboard — the registry-can-rot watch from ADR-001
 *  made into a live signal. The mere fact that the task keeps firing is itself
 *  the liveness falsifier (automation-registry `expectedMaxStaleHours`). */

import type { TaskFn } from '../task-types.js';
import { check, compile } from '../../contracts/registry.js';

export function contractFalsifierFactory(_params: unknown): TaskFn {
	return async () => {
		compile(); // refresh cache from vault source
		const c = check();
		const summary = {
			count: c.count,
			cacheStale: c.cacheStale,
			unresolvedFiles: c.unresolvedFiles,
			danglingFalsifiers: c.danglingFalsifiers,
			danglingDeps: c.danglingDeps,
		};
		if (!c.ok) {
			const parts: string[] = [];
			if (c.cacheStale) parts.push('cache stale');
			if (c.unresolvedFiles.length) parts.push(`${c.unresolvedFiles.length} unresolved file glob(s)`);
			if (c.danglingFalsifiers.length) parts.push(`${c.danglingFalsifiers.length} dangling falsifier(s)`);
			if (c.danglingDeps.length) parts.push(`${c.danglingDeps.length} dangling dep(s)`);
			throw new Error(`contract registry self-falsifier RED: ${parts.join('; ')}`);
		}
		return { ok: true, ...summary };
	};
}
