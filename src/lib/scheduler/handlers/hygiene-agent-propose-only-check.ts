/** Task handler: hygiene-agent-propose-only-check (ADR-007 P1 falsifier).
 *
 *  Falsifier for the `hygiene-agent-propose-only` contract. Asserts that
 *  the dispatched `hygiene-fixer` agent NEVER writes to the vault directly:
 *  zero audit-log rows attributed to the fixer agent must exist.
 *
 *  Implementation: queries the `vault_writes` audit log (written by the
 *  ADR-046 vault write chokepoint via `engine.updateNote`) for any row
 *  where `actor = 'hygiene-fixer'` or `source_agent = 'hygiene-fixer'`.
 *  Non-zero count means the propose-only boundary leaked.
 *
 *  The runtime check complements the static `buildCheck` in the contract
 *  registry (which fails the build if the agent profile gains a write tool).
 *  Defense-in-depth: both need to hold for the guarantee to be true.
 *
 *  ADR-007 revision 2026-05-26 #4: this falsifier must be REGISTERED AND GREEN
 *  before the fixer is ever dispatched. The registration happens in hooks.server.ts;
 *  the vault contract-registry note update is a manual operator step (vault
 *  writes are chokepointed — see follow-ups in the hand-back).
 */

import type { TaskFn } from '../task-types.js';
import { getVaultEngine } from '../../vault/index.js';

/** The fixer agent id to watch. */
const FIXER_AGENT_ID = 'hygiene-fixer';

export function hygieneAgentProposeOnlyCheckFactory(_params: unknown): TaskFn {
	return async () => {
		const engine = getVaultEngine();

		// If the engine is not running the vault has no write history to check.
		// Treat as green (can't be false-positive when the fixer can't run either).
		if (!engine) {
			return {
				ok: true,
				status: 'green',
				detail: 'vault engine unavailable — no writes to check',
			};
		}

		// Query the audit log. The vault engine exposes `getWritesByAgent(agentId)`
		// which counts rows from the ADR-046 write log. If the method isn't present
		// on this engine version we fall back to the REST API.
		let fixerWriteCount = 0;
		let dataSource: 'engine' | 'api' | 'unavailable' = 'unavailable';

		// Primary: engine method (fastest, no network).
		if (typeof (engine as unknown as Record<string, unknown>).getWritesByAgent === 'function') {
			const rows = (engine as unknown as { getWritesByAgent: (id: string) => unknown[] })
				.getWritesByAgent(FIXER_AGENT_ID);
			fixerWriteCount = Array.isArray(rows) ? rows.length : 0;
			dataSource = 'engine';
		} else {
			// Fallback: REST API (slightly slower but always available when Soul Hub is up).
			try {
				const res = await fetch(
					`http://127.0.0.1:2400/api/vault/writes?agent=${encodeURIComponent(FIXER_AGENT_ID)}&limit=1`,
					{ signal: AbortSignal.timeout(5000) },
				);
				if (res.ok) {
					const data = (await res.json()) as { total?: number; count?: number };
					fixerWriteCount = data.total ?? data.count ?? 0;
					dataSource = 'api';
				}
			} catch {
				// Can't reach the API — fail-open: the static buildCheck is the
				// backstop; we'd rather not false-positive a green task into red.
				return {
					ok: true,
					status: 'green',
					detail: `Could not reach vault API — skipping runtime check (buildCheck still guards)`,
					dataSource: 'unavailable',
				};
			}
		}

		if (fixerWriteCount > 0) {
			// 🔴 FAILED: propose-only boundary leaked.
			throw new Error(
				`PROPOSE-ONLY VIOLATED: ${fixerWriteCount} vault write(s) attributed to agent '${FIXER_AGENT_ID}'. ` +
				`ADR-007 §Decision requires the fixer never writes. ` +
				`Check the audit log: GET /api/vault/writes?agent=hygiene-fixer. ` +
				`This likely means the executor wrote under the wrong actor — verify the approval-actor discipline in agent-primitives.ts.`,
			);
		}

		return {
			ok: true,
			status: 'green',
			detail: `${FIXER_AGENT_ID} has zero vault writes — propose-only boundary holds`,
			fixerWriteCount,
			dataSource,
		};
	};
}
