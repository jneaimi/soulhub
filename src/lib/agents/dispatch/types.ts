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
		/** ADR-006 — raise the hard ceilings (default 2× soft). Used by the
		 *  resume path when the operator grants more budget via Telegram. */
		ceiling_usd?: number;
		ceiling_turns?: number;
	};
	/** ADR-006 Phase 2 — when true, hitting the HARD ceiling pauses the run
	 *  (clean-kill → `awaiting-budget-approval`) instead of terminating it, so
	 *  the operator can grant more budget via Telegram and the run resumes via
	 *  `claude --resume`. Background dispatches (no chat `jid`) default to true;
	 *  chat dispatches keep the hard kill (the human is already present). */
	pausable_on_ceiling?: boolean;
	/** ADR-006 Phase 2 — resume an existing Claude session (raised ceiling)
	 *  rather than starting fresh. Set by the resume path; the backend passes
	 *  `--resume <id>` and omits `--session-id`. */
	resume_session_id?: string;
	/** ADR-024 D2 — when resuming, work in the EXISTING branch's worktree
	 *  rather than provisioning a new one. Must be set alongside
	 *  `resume_session_id`; absent → fresh worktree provisioned as usual. */
	resume_branch?: string;
	/** R5 fix (2026-05-30) — explicit cwd for the PTY child / oneshot spawn.
	 *  Set to the provisioned worktree path so the agent starts IN the
	 *  worktree instead of cwd=vault + relying on a `cd` directive in the
	 *  prompt. Without this, run 524 sat in /Users/jneaimi/vault for 22 min
	 *  doing nothing: relative paths didn't resolve, the PreToolUse scope
	 *  guard saw the wrong working dir, and any self-`cd` the agent forgot
	 *  meant zero commits on the worktree branch. Undefined → backend falls
	 *  back to its historical default (vaultDir for claude-pty), preserving
	 *  behavior for non-artifact dispatches that have no worktree. */
	cwd?: string;
}

export type DispatchEvent =
	/** ADR-020 P4 — `claudeSessionId` carries the spawned session's UUID so
	 *  the dispatcher can persist it to `agent_runs.claude_session_id` at
	 *  start time (not just at finish), giving the dispatch-scope-guard.sh
	 *  PreToolUse hook a stable join key for the running row. Optional for
	 *  backward-compat: backends that don't expose session-id-at-start (e.g.
	 *  claude-cli-flag, which learns it from the JSON envelope at the end)
	 *  omit it. */
	| { type: 'started'; backend: string; model?: string; runId: string; ts: number; claudeSessionId?: string }
	| { type: 'output'; data: string; ts: number }
	| { type: 'tool_call'; name: string; ts: number }
	| { type: 'step'; n: number; finishReason?: string; ts: number }
	| { type: 'error'; message: string; ts: number }
	/** ADR-006 Phase 3 — velocity projection sees the run ~1 turn from its hard
	 *  ceiling. `dispatch/index.ts` turns this into an early Telegram warning so
	 *  the operator can raise the ceiling in-flight (avoiding the pause/resume
	 *  cycle). Carries everything the escalation + live-grant base needs. */
	| {
			type: 'budget_warning';
			runId: string;
			sessionUuid: string;
			ceilingUsd: number;
			ceilingTurns: number;
			spentUsd: number;
			turns: number;
			reason: 'max_usd' | 'max_turns';
			ts: number;
	  }
	/** ADR-026 P3 — live cost/turns progress tick, emitted every time the
	 *  transcript snapshot changes during a PTY run. `dispatch/index.ts`
	 *  persists these into the `running` DB row so the board chip can show
	 *  real numbers mid-run instead of `$0.00 · 0t`. */
	| { type: 'progress'; runId: string; costUsd: number; numTurns: number; ts: number }
	| { type: 'done'; result: DispatchResult; ts: number };

export interface DispatchResult {
	runId: string;
	agentId: string;
	backend: string;
	status:
		| 'success'
		| 'error'
		| 'cancelled'
		| 'timeout'
		| 'budget-exceeded'
		| 'goal_achieved'
		/** ADR-006 Phase 2 — hit the hard ceiling but was pausable: the session
		 *  is preserved, awaiting an operator budget grant to resume. */
		| 'awaiting-budget-approval'
		/** ADR-026 P2 — agent emitted an `ask_operator` sentinel mid-run: the
		 *  session is preserved, awaiting an operator answer which rides back
		 *  in as the `task` on `--resume`. */
		| 'awaiting-operator-input';
	output: string;
	cost_usd: number;
	num_turns: number;
	duration_ms: number;
	error?: string;
	/** ADR-006 Phase 2 — present iff `status === 'awaiting-budget-approval'`.
	 *  The context the escalation + resume path needs. */
	budget_pause?: {
		/** Which ceiling tripped. */
		reason: 'max_usd' | 'max_turns';
		/** Ceilings that were in force (so the bump raises from the right base). */
		ceiling_usd: number;
		ceiling_turns: number;
	};
	/** ADR-026 P2 — present iff `status === 'awaiting-operator-input'`.
	 *  The question the agent needs answered before it can continue. */
	operator_pause?: {
		question: string;
	};
	/** ADR-002 Layer 1 — Claude Code session UUID for this run, when the backend
	 *  set a deterministic `--session-id` (PTY) or reported one (cli-flag). Lets
	 *  consumers re-locate the JSONL transcript for replay/audit. */
	claude_session_id?: string;
}

export interface BackendDispatcher {
	id: AgentSummary['backend'];
	dispatch(agent: AgentSummary, opts: DispatchOptions): AsyncGenerator<DispatchEvent, DispatchResult, void>;
}
