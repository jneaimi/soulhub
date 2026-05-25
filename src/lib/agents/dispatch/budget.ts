/**
 * Budget caps — production runs respect the agent's stored budget; test runs
 * use ADR §6 hard caps so a curious user can't burn through real spend.
 */

import type { DispatchMode } from './types.js';

export interface ResolvedBudget {
	/** Soft cap (ADR-006 tier 1). Crossing it no longer kills the run — it is an
	 *  informational checkpoint; the run auto-extends to the ceiling (the
	 *  "auto-approve band": near-done runs aren't discarded one turn short). */
	max_usd: number;
	/** Soft turn cap — same auto-extend semantics as `max_usd`. */
	max_turns: number;
	/** Hard ceiling (ADR-006 tier 2). Crossing it terminates the run — the
	 *  runaway/recursion backstop. Default `max_usd × CEILING_MULTIPLIER`. */
	ceiling_usd: number;
	/** Hard turn ceiling — terminal. Default `max_turns × CEILING_MULTIPLIER`. */
	ceiling_turns: number;
	timeout_ms: number;
}

interface AgentBudgetLike {
	max_usd?: number;
	max_turns?: number;
	timeout_sec?: number;
	/** Optional explicit hard ceilings; default to `CEILING_MULTIPLIER × soft`. */
	ceiling_usd?: number;
	ceiling_turns?: number;
}

/** How far past the soft cap a run auto-extends before the hard ceiling kills it
 *  (ADR-006). 2× gives a near-done run room to land without letting a runaway
 *  spend unbounded. ADR-006 Phase 2 lets the operator raise the ceiling further
 *  via Telegram-gated `claude --resume`. */
const CEILING_MULTIPLIER = 2;

const TEST_CAPS = {
	max_usd: 0.1,
	max_turns: 5,
	timeout_ms: 60_000,
};

// Production default raised from 60s → 180s after first real research dispatch
// hit the wall-clock at 60.1s mid-task. Web research (WebSearch + a couple of
// WebFetch calls + synthesis) reliably needs 90-150s; 180s covers the median
// with headroom. Per-agent budgets (researcher, etc.) override upward.
const PRODUCTION_DEFAULTS = {
	max_usd: 0.5,
	max_turns: 25,
	timeout_ms: 180_000,
};

/** Derive the hard ceilings for a soft cap pair, honouring any explicit
 *  per-agent override and never letting a ceiling fall below its soft cap. */
function withCeilings(
	soft: { max_usd: number; max_turns: number; timeout_ms: number },
	agentBudget?: AgentBudgetLike,
): ResolvedBudget {
	return {
		...soft,
		ceiling_usd: Math.max(soft.max_usd, agentBudget?.ceiling_usd ?? soft.max_usd * CEILING_MULTIPLIER),
		ceiling_turns: Math.max(
			soft.max_turns,
			agentBudget?.ceiling_turns ?? soft.max_turns * CEILING_MULTIPLIER,
		),
	};
}

/** Resolve the budget for a dispatch. Test mode floors at the smaller of
 *  TEST_CAPS and the agent's configured budget — never raises a configured
 *  cap, so a misconfigured agent still can't blow past production limits. */
export function resolveBudget(mode: DispatchMode, agentBudget?: AgentBudgetLike): ResolvedBudget {
	const soft = {
		max_usd: agentBudget?.max_usd ?? PRODUCTION_DEFAULTS.max_usd,
		max_turns: agentBudget?.max_turns ?? PRODUCTION_DEFAULTS.max_turns,
		timeout_ms:
			agentBudget?.timeout_sec != null
				? agentBudget.timeout_sec * 1000
				: PRODUCTION_DEFAULTS.timeout_ms,
	};

	if (mode === 'test') {
		// Test mode floors the soft caps; ceilings derive from the test soft caps
		// so a curious user still can't burn real spend exploring the band.
		return withCeilings(
			{
				max_usd: Math.min(soft.max_usd, TEST_CAPS.max_usd),
				max_turns: Math.min(soft.max_turns, TEST_CAPS.max_turns),
				timeout_ms: Math.min(soft.timeout_ms, TEST_CAPS.timeout_ms),
			},
			// Test mode ignores agent ceiling overrides — derive strictly from the
			// floored soft caps (so the test ceiling can't exceed 2× TEST_CAPS).
			undefined,
		);
	}

	// `production` and `oneshot` both honour the configured budget as-is —
	// the only difference between them is the backend (PTY vs cli-flag),
	// resolved one level up in dispatch/index.ts.
	return withCeilings(soft, agentBudget);
}
