/**
 * Dispatch types — shared across the three backend dispatchers.
 *
 *   `DispatchEvent` is the streaming wire-format the test endpoint emits.
 *   `DispatchResult` is the final summary returned when the run finishes.
 *
 * Each backend dispatcher implements `dispatch(...)` returning an async
 * iterable of events plus a final `DispatchResult`.
 */

import type { AgentSummary } from '../types.js';

/**
 * Dispatch modes — pick the (backend, budget-cap-policy) pair:
 *
 *  - `production`   PTY backend with /goal loop, no budget caps (agent / step
 *                   budget honoured as-is). Default for chat-dispatched runs.
 *  - `test`         cli-flag backend (-p) with hard caps from `TEST_CAPS` in
 *                   budget.ts ($0.10 / 5 turns / 60s) — for cheap CI smokes.
 *  - `oneshot`      cli-flag backend (-p), no budget caps. For agents that
 *                   are structurally single-pass (no iteration loop) and need
 *                   production-scale budgets — e.g. peer-brief-synth which
 *                   reads inputs, synthesises once, writes a 38KB recipe,
 *                   emits a marker, exits. PTY + /goal added latency + fuzzy
 *                   goal-evaluation failure modes for no benefit. ADR-007 S3.
 */
export type DispatchMode = 'production' | 'test' | 'oneshot';

export interface DispatchOptions {
	mode: DispatchMode;
	task: string;
	signal?: AbortSignal;
	/** Optional conversation brief built by the orchestrator. Lane dispatchers
	 *  prepend it to the task prompt so the agent sees the gist of the chat
	 *  it was dispatched from. Bounded to ~600 chars upstream — never the
	 *  raw 16-turn history. Empty/undefined → behave as before (single-shot). */
	context?: string;
	/** ADR-005 — per-call goal-condition override. When set, the dispatcher
	 *  prefers this over `agent.goal_condition`. Used by the Naseej runner
	 *  to let recipe steps override an agent's default convergence rule.
	 *  Today only the `claude-pty` backend acts on goal-conditions; other
	 *  backends ignore both the agent default and this override. */
	goal_condition?: string;
	/** ADR-005 — per-call budget override. Partial — any subset of fields
	 *  shadows the agent's stored budget; missing fields fall through to
	 *  the agent default, which itself falls through to PRODUCTION_DEFAULTS
	 *  in `budget.ts:resolveBudget`. Used by the Naseej runner to let
	 *  recipe steps tighten/loosen budget on a per-step basis. */
	budget_override?: {
		max_usd?: number;
		max_turns?: number;
		timeout_sec?: number;
	};
}

export type DispatchEvent =
	| { type: 'started'; backend: string; model?: string; runId: string; ts: number }
	| { type: 'output'; data: string; ts: number }
	| { type: 'tool_call'; name: string; ts: number }
	| { type: 'step'; n: number; finishReason?: string; ts: number }
	| { type: 'error'; message: string; ts: number }
	| { type: 'done'; result: DispatchResult; ts: number };

export interface DispatchResult {
	runId: string;
	agentId: string;
	backend: string;
	status: 'success' | 'error' | 'cancelled' | 'timeout' | 'budget-exceeded' | 'goal_achieved';
	output: string;
	cost_usd: number;
	num_turns: number;
	duration_ms: number;
	error?: string;
	/** ADR-002 Layer 1 — Claude Code session UUID for this run, when the backend
	 *  set a deterministic `--session-id` (PTY) or reported one (cli-flag). Lets
	 *  consumers re-locate the JSONL transcript for replay/audit. */
	claude_session_id?: string;
}

export interface BackendDispatcher {
	id: AgentSummary['backend'];
	dispatch(agent: AgentSummary, opts: DispatchOptions): AsyncGenerator<DispatchEvent, DispatchResult, void>;
}
