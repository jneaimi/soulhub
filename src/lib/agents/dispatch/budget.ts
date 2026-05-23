/**
 * Budget caps — production runs respect the agent's stored budget; test runs
 * use ADR §6 hard caps so a curious user can't burn through real spend.
 */

import type { DispatchMode } from './types.js';

export interface ResolvedBudget {
	max_usd: number;
	max_turns: number;
	timeout_ms: number;
}

interface AgentBudgetLike {
	max_usd?: number;
	max_turns?: number;
	timeout_sec?: number;
}

const TEST_CAPS: ResolvedBudget = {
	max_usd: 0.1,
	max_turns: 5,
	timeout_ms: 60_000,
};

// Production default raised from 60s → 180s after first real research dispatch
// hit the wall-clock at 60.1s mid-task. Web research (WebSearch + a couple of
// WebFetch calls + synthesis) reliably needs 90-150s; 180s covers the median
// with headroom. Per-agent budgets (researcher, etc.) override upward.
const PRODUCTION_DEFAULTS: ResolvedBudget = {
	max_usd: 0.5,
	max_turns: 25,
	timeout_ms: 180_000,
};

/** Resolve the budget for a dispatch. Test mode floors at the smaller of
 *  TEST_CAPS and the agent's configured budget — never raises a configured
 *  cap, so a misconfigured agent still can't blow past production limits. */
export function resolveBudget(mode: DispatchMode, agentBudget?: AgentBudgetLike): ResolvedBudget {
	const configured: ResolvedBudget = {
		max_usd: agentBudget?.max_usd ?? PRODUCTION_DEFAULTS.max_usd,
		max_turns: agentBudget?.max_turns ?? PRODUCTION_DEFAULTS.max_turns,
		timeout_ms:
			agentBudget?.timeout_sec != null
				? agentBudget.timeout_sec * 1000
				: PRODUCTION_DEFAULTS.timeout_ms,
	};

	if (mode === 'test') {
		return {
			max_usd: Math.min(configured.max_usd, TEST_CAPS.max_usd),
			max_turns: Math.min(configured.max_turns, TEST_CAPS.max_turns),
			timeout_ms: Math.min(configured.timeout_ms, TEST_CAPS.timeout_ms),
		};
	}

	// `production` and `oneshot` both honour the configured budget as-is —
	// the only difference between them is the backend (PTY vs cli-flag),
	// resolved one level up in dispatch/index.ts.
	return configured;
}
