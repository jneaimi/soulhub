/**
 * Pending-proposal tracker — persists a one-step "I propose to do X" record
 * per conversation so the user's next message can confirm/redirect/cancel
 * without re-running the classifier.
 *
 * UX problem this solves (from 2026-05-06 chat test): the orchestrator
 * was auto-dispatching `researcher` on simple questions ("how's the
 * weather in UAE", "do we have research on agriculture"). The redesign
 * adds `propose-dispatch` as a non-final action — the orchestrator emits
 * a one-line proposal, this module stores it, and the inbound handler
 * intercepts the next user reply BEFORE running classification:
 *
 *   - "yes" / "go" / "do it"  → execute the pending proposal
 *   - "web" / "quick"          → swap the proposal for a `web-search` action
 *   - "no" / "cancel"          → drop the proposal, send acknowledgement
 *   - anything else            → drop the proposal, classify the new
 *                                message normally (the user moved on)
 *
 * Storage: same SQLite handle as `chat_history` (~/.soul-hub/data/inbox.db).
 * Schema is created lazily on first access. Stale rows pruned on each save.
 *
 * TTL: configurable via `setPending`'s `ttl_ms` option, default 24h (ADR-007).
 * The previous 10-minute default silently dropped proposals when the user
 * deferred their reply through a meal/meeting; 24h covers natural delays
 * and the 6h grace window (see `getPending`) catches genuinely-late "yes".
 */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';
import {
	recordProposal,
	resolveByConversation,
	type ProposalResolution,
	type ProposalOrigin,
} from './proposal-history.js';

/** Default TTL — 24h. Covers natural reply delays (sleep, meetings, travel).
 *  Per-call override via `setPending({ttl_ms})` for shorter-lived proposals. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Grace window after expiry where `getPending` still returns the row with
 *  `expired: true`. Lets the inbound handler surface "your proposal expired
 *  Xm ago — say yes within 5 min to run anyway" instead of silently dropping
 *  a delayed confirm. ADR-007 Gap 2. */
const GRACE_MS = 6 * 60 * 60 * 1000;

export interface PendingProposal {
	conversationKey: string;
	createdAt: number;
	expiresAt: number;
	agentId: string;
	task: string;
	/** Short label rendered into the proposal text (e.g. "Full research dive
	 *  on hydroponics"). Bounded ~80 chars by upstream classifier. */
	label: string;
	/** ADR-007 Gap 2 — true when the proposal is past `expiresAt` but still
	 *  within the 6h grace window. Inbound handler renders a "your proposal
	 *  expired Xm ago" prompt and accepts a fresh confirm within 5 min. */
	expired?: boolean;
}

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS pending_proposals (
			conversation_key TEXT PRIMARY KEY,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			agent_id TEXT NOT NULL,
			task TEXT NOT NULL,
			label TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_pending_proposals_expires
			ON pending_proposals(expires_at);
	`);
}

function db(): Database {
	const handle = getInboxDb();
	if (!schemaReady) {
		ensureSchema(handle);
		schemaReady = true;
	}
	return handle;
}

/** Stash a fresh proposal. Replaces any existing proposal on the same key
 *  — only the latest one is honoured, since the orchestrator can re-evaluate
 *  the user's intent on every turn.
 *
 *  `ttl_ms` overrides the 24h default (ADR-007 Gap 1). Use shorter TTLs for
 *  transient proposals (e.g. web-search alternatives), longer for heavy
 *  multi-day research dispatches. */
export function setPending(input: {
	conversationKey: string;
	agentId: string;
	task: string;
	label: string;
	ttl_ms?: number;
	/** ADR-008 Phase 8 — proposal source for analytics. Forwarded to
	 *  `recordProposal` so the audit row is tagged at write time. */
	origin?: ProposalOrigin;
	/** ADR-009 Phase 5 — A/B branch that decided this proposal. Forwarded
	 *  to `recordProposal` so analytics queries can group by branch.
	 *  Pass `null`/undefined for v1 (Gemini-classifier) callers. */
	modelBranch?: string | null;
}): PendingProposal {
	const now = Date.now();
	const ttl = input.ttl_ms ?? DEFAULT_TTL_MS;
	const proposal: PendingProposal = {
		conversationKey: input.conversationKey,
		createdAt: now,
		expiresAt: now + ttl,
		agentId: input.agentId,
		task: input.task,
		label: input.label,
	};

	const handle = db();
	pruneExpired(handle, now);

	handle
		.prepare(
			`INSERT OR REPLACE INTO pending_proposals
				(conversation_key, created_at, expires_at, agent_id, task, label)
				VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			proposal.conversationKey,
			proposal.createdAt,
			proposal.expiresAt,
			proposal.agentId,
			proposal.task,
			proposal.label,
		);

	// ADR-007 Gap 3 — record an audit-trail row alongside the live state.
	// `recordProposal` also resolves any prior unresolved row on this
	// conversation as `superseded`, so the live `INSERT OR REPLACE` above
	// stays in sync with the history view.
	recordProposal({
		conversationKey: proposal.conversationKey,
		agentId: proposal.agentId,
		task: proposal.task,
		label: proposal.label,
		shownText: formatProposal(proposal),
		expiresAt: proposal.expiresAt,
		origin: input.origin,
		modelBranch: input.modelBranch,
	});

	return proposal;
}

/** Read the live proposal for a key. Returns undefined when nothing is
 *  pending or the row is past the grace window. Rows in the grace window
 *  (`expires_at < now < expires_at + GRACE_MS`) are returned with
 *  `expired: true` so the inbound handler can surface a "your proposal
 *  expired Xm ago" prompt instead of dropping silently (ADR-007 Gap 2). */
export function getPending(conversationKey: string): PendingProposal | undefined {
	const handle = db();
	const now = Date.now();

	const row = handle
		.prepare(
			`SELECT conversation_key, created_at, expires_at, agent_id, task, label
				FROM pending_proposals
				WHERE conversation_key = ?`,
		)
		.get(conversationKey) as
		| {
				conversation_key: string;
				created_at: number;
				expires_at: number;
				agent_id: string;
				task: string;
				label: string;
		  }
		| undefined;

	if (!row) return undefined;

	// Past the grace window — clean up + nothing to show.
	if (row.expires_at + GRACE_MS < now) {
		clearPending(conversationKey);
		return undefined;
	}

	const expired = row.expires_at < now;

	return {
		conversationKey: row.conversation_key,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		agentId: row.agent_id,
		task: row.task,
		label: row.label,
		expired,
	};
}

/** Drop a proposal — used when user confirmed (post-dispatch) or declined.
 *  Prefer `resolvePending(key, kind)` when the resolution kind is known so
 *  the audit trail captures it; this raw form is for defensive cleanup
 *  (e.g. cancel paths where no proposal may exist). */
export function clearPending(conversationKey: string): void {
	db().prepare(`DELETE FROM pending_proposals WHERE conversation_key = ?`).run(conversationKey);
}

/** Resolve a pending proposal: record the resolution kind in
 *  `proposal_history` AND drop the live state row. Use this from every
 *  user-driven path (confirm / decline / switch-to-web / unrelated /
 *  expired / cancelled). ADR-007 Gap 3. */
export function resolvePending(
	conversationKey: string,
	resolution: ProposalResolution,
): void {
	resolveByConversation(conversationKey, resolution);
	clearPending(conversationKey);
}

/** Prune rows past the 6h grace window. Anything within the grace window
 *  remains so `getPending` can surface it as `expired: true`. */
function pruneExpired(handle: Database, now: number): void {
	handle
		.prepare(`DELETE FROM pending_proposals WHERE expires_at + ? < ?`)
		.run(GRACE_MS, now);
}

/** Classify a user reply against a live proposal. Pure string analysis;
 *  no LLM call. Tight matching on common confirm/decline tokens — anything
 *  ambiguous returns 'unrelated' so we drop the proposal and re-classify
 *  the new message normally rather than guessing.
 *
 *  Confirm tokens are intentionally narrow — "ok" alone could be a
 *  conversational ack; users explicitly typing "yes" / "go" / "do it" /
 *  "ship it" / "go ahead" / "👍" want to confirm.
 *
 *  "web" / "quick" / "search" → user wants a quick web lookup instead
 *  of the heavy agent; the inbound handler converts the proposal to a
 *  `web-search` action and clears the proposal.
 */
export type ProposalReplyKind = 'confirm' | 'decline' | 'switch-to-web' | 'unrelated';

export function classifyProposalReply(message: string): ProposalReplyKind {
	const m = message.trim().toLowerCase();
	if (m.length === 0) return 'unrelated';

	// Confirm — short, explicit affirmations only.
	if (/^(yes|y|yep|yeah|sure|ok\s*(go|do)|go|go ahead|do it|ship it|run it|start|fire|🚀|👍|✅)\b\.?$/i.test(m)) {
		return 'confirm';
	}

	// Switch to web search.
	if (/^(web|quick|search|just search|web search|google it)\b\.?$/i.test(m)) {
		return 'switch-to-web';
	}

	// Decline.
	if (/^(no|nope|cancel|skip|nah|forget it|stop|drop it|❌|🛑)\b\.?$/i.test(m)) {
		return 'decline';
	}

	return 'unrelated';
}

/** Render the grace-window prompt for a proposal that's past its TTL but
 *  within the 6h grace window (ADR-007 Gap 2). The user sees how stale the
 *  proposal is and can confirm afresh — anything other than `confirm` drops
 *  the row and falls through to normal classification. */
export function formatExpiredPrompt(proposal: PendingProposal): string {
	const ageMin = Math.round((Date.now() - proposal.expiresAt) / 60_000);
	const ageDisplay = ageMin >= 60 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
	return [
		`Your earlier proposal (*${proposal.label}*) expired ${ageDisplay} ago.`,
		``,
		`Reply *yes* in the next 5 min to run *${proposal.agentId}* anyway, or describe what you'd like fresh.`,
	].join('\n');
}

/** Render the proposal text the orchestrator sends to the user. Templated
 *  in code (not LLM-generated) so prompt-injection in the user message
 *  can't change the action that fires on "yes". The label/agentId comes
 *  from the structured classifier output and is bound to the row. */
export function formatProposal(proposal: PendingProposal): string {
	return [
		`Looks like you want *${proposal.label}*.`,
		``,
		`Reply *yes* to run *${proposal.agentId}* (heavy — minutes), *web* for a quick web summary instead, or *no* to drop it.`,
	].join('\n');
}
