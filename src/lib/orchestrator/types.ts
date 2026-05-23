/**
 * Orchestrator decision shape — shared between the v2 classifier
 * (`src/lib/orchestrator-v2/decide-v2.ts`) and downstream consumers (inbound
 * handler, metrics dashboard). v2 emits `OrchestratorDecision` via the
 * `mapToolCallsToDecision` shim so analytics rows stay in the same shape
 * the v1 path used; the actual user-facing payload is the richer
 * `V2Output` (in `orchestrator-v2/types.ts`).
 *
 * Seven actions:
 *   - reply           — plain chat reply
 *   - web-search      — quick Gemini-grounded Google Search citation
 *   - vault-search    — defer to vault-chat for personal-note lookups
 *   - generate-image  — text-to-image via the existing `/img` route
 *   - propose-dispatch — propose a heavy agent dispatch + wait for confirm
 *   - dispatch        — fire the specialist agent now (explicit command)
 *   - clarify         — ambiguous; ask the user to rephrase
 */

export type OrchestratorAction =
	| 'reply'
	| 'web-search'
	| 'vault-search'
	| 'generate-image'
	| 'propose-dispatch'
	| 'dispatch'
	| 'clarify';

export interface OrchestratorDecision {
	action: OrchestratorAction;
	/** For `reply` and `clarify`: the text the user sees. For
	 *  `propose-dispatch`: optional one-line preface (the proposal text
	 *  itself is rendered deterministically by the inbound handler). */
	reply?: string;
	/** For `dispatch` and `propose-dispatch`: which specialist. */
	agent?: string;
	/** For `dispatch` and `propose-dispatch`: the self-contained instruction
	 *  the agent will execute. */
	task?: string;
	/** For `propose-dispatch`: a short label describing what the agent will
	 *  do, rendered into the proposal text. ~80 chars. */
	proposalLabel?: string;
	/** For `web-search`: the grounded query string. Often identical to the
	 *  user message but may be tightened (e.g. add location context). */
	webQuery?: string;
	/** For `generate-image`: the cleaned image prompt. Falls back to the
	 *  user message when the model omits it. */
	imagePrompt?: string;
	confidence: number;
	reasoning?: string;
}

import type { ProposalOrigin } from './proposal-history.js';

export interface DecideResult {
	decision: OrchestratorDecision;
	/** When the LLM call or schema validation failed. The caller should fall
	 *  through to vault-chat rather than surfacing an error. */
	fellThrough: boolean;
	/** Human-readable note for logs — never shown to user. */
	note?: string;
	/** Proposal source for analytics. Set when the decision is
	 *  `propose-dispatch`: `'force-commit'`, `'confidence-downgrade'`, or
	 *  omitted (caller treats undefined as `'natural'`). The inbound handler
	 *  forwards this to `setPending` so `proposal_history.origin` records it. */
	proposalOrigin?: ProposalOrigin;
}
