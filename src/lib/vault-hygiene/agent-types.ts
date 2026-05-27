/** ADR-007 — Agentic Hygiene Remediation: types.
 *
 *  The edit-op vocabulary and the HygieneProposal contract the hygiene-fixer
 *  agent produces. Each edit-op maps 1-to-1 with a deterministic, git-revertible
 *  executor that runs AFTER the operator approves.
 *
 *  P1 executors: retarget-link + add-links (in agent-primitives.ts).
 *  P2 executors: promote, set-status / tick-task, move-note, verify.
 */

// ─── P1: edit-op vocabulary ────────────────────────────────────────────────

/** Re-point a broken wikilink to an existing target. Must preserve
 *  `[[raw|alias]]` display text and replace ALL occurrences in the source. */
export interface RetargetLinkOp {
	op: 'retarget-link';
	/** Source note (vault-relative) that contains the broken wikilink. */
	source: string;
	/** The raw inner text of the broken link, matching `UnresolvedIssue.raw`. */
	raw: string;
	/** The correct, existing target (vault-relative path). */
	newTarget: string;
}

/** Add wikilinks from an orphan note to related notes. Every proposed
 *  target must resolve before the executor writes; if a target does not
 *  exist, the executor rejects that op (edge case 9, ADR-007). */
export interface AddLinksOp {
	op: 'add-links';
	/** The orphan note to link from (vault-relative). */
	path: string;
	/** Resolved vault-relative paths of related notes to link to. */
	targets: string[];
}

// ─── P2 stubs (typed for forward-compat; executors built in ADR-007 P2) ───

export interface MoveNoteOp {
	op: 'move-note';
	path: string;
	zone: string;
}

export interface SetStatusOp {
	op: 'set-status';
	path: string;
	status: string;
}

export interface SetFrontmatterOp {
	op: 'set-frontmatter';
	path: string;
	field: string;
	value: unknown;
}

export interface RenameFileOp {
	op: 'rename-file';
	path: string;
	newPath: string;
}

export interface TickTaskOp {
	op: 'tick-task';
	path: string;
	line: number;
}

export interface PromoteOp {
	op: 'promote';
	path: string;
	zone: string;
}

/** Union of all edit-ops. P1 executors: retarget-link + add-links.
 *  The approve endpoint rejects P2 ops at runtime until their executors land. */
export type EditOp =
	| RetargetLinkOp
	| AddLinksOp
	| MoveNoteOp
	| SetStatusOp
	| SetFrontmatterOp
	| RenameFileOp
	| TickTaskOp
	| PromoteOp;

// ─── Proposal contract (what the hygiene-fixer agent outputs) ─────────────

/** Strict JSON contract the `hygiene-fixer` agent outputs. Load-bearing:
 *  the approve endpoint validates this shape before dispatching any executor.
 *  The agent is ALWAYS structurally incapable of writing (no write/Bash tools
 *  + ADR-046 Pass 1+2+3), so this contract is the bridge between the
 *  agent's reasoning and the deterministic executor. */
export interface HygieneProposal {
	bucket: string;
	/** Vault-relative path of the primary affected note. */
	target: string;
	/** One-sentence human-readable rationale. */
	summary: string;
	confidence: 'high' | 'medium' | 'low';
	/** Primary edit set. */
	edits: EditOp[];
	/** Alternative edit sets (operator can pick one from the approve UI). */
	alternatives: EditOp[][];
}

/** Runtime result of executing an approved proposal. */
export interface ProposalExecutionResult {
	ok: boolean;
	opsExecuted: number;
	details: string[];
	error?: string;
}

// ─── Proposal store shape ────────────────────────────────────────────────

export type ProposalStatus = 'dispatching' | 'ready' | 'error';

export interface ProposalEntry {
	rowKey: string;
	status: ProposalStatus;
	runId?: string;
	proposal?: HygieneProposal;
	error?: string;
	/** Raw agent output (for debugging when JSON parse fails). */
	rawOutput?: string;
	updatedAt: number;
}
