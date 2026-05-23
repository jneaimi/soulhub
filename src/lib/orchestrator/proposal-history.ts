/**
 * Proposal audit trail (ADR-007 Gap 3).
 *
 * Append-only history of every `propose-dispatch` proposal the orchestrator
 * has surfaced + how it resolved. Lives alongside `pending_proposals` in
 * `inbox.db` (lazy schema). Where `pending_proposals` is the live state
 * (DELETE-on-consume), this table is the timeline (INSERT + UPDATE).
 *
 * Why: lets us measure confirm/decline ratios per agent, time-to-confirm
 * distribution, and stale-fire rates. The data also unblocks future
 * tuning of the propose-dispatch confidence threshold (decide.ts:46).
 *
 * Schema lives here, not in `pending-proposals.ts`, so the live-state
 * table stays minimal (single PK row per conversation, hot-path read).
 *
 * `agent_run_id` is a string FK to `agent_runs.runId` in `heartbeat.db`.
 * SQLite cannot enforce cross-database FKs; we treat it as a soft join.
 */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';

export type ProposalResolution =
	| 'confirm'
	| 'decline'
	| 'switch-to-web'
	| 'unrelated'
	| 'expired'
	| 'superseded'
	| 'cancelled';

/** ADR-008 Phase 8 — why a proposal was created. Lets analytics distinguish
 *  the user-confirms-vs-declines rate per *source* (e.g. is force-commit
 *  synthesizing useful tasks? does the confidence-downgrade path catch real
 *  ambiguity?). Intentionally a closed enum: any proposal that doesn't fit
 *  one of the named sources is `'natural'` (the default).
 *
 *  Note: `'intent-switch'` was considered (per ADR § Things explicitly NOT
 *  done) but doesn't fit at proposal-creation time — intent-switch happens
 *  in the state machine, abandoning a prior gathering or proposed phase.
 *  When the abandoned state had a live proposal, the existing `'superseded'`
 *  resolution captures it; when it was just gathering, there's no proposal
 *  row to tag. */
export type ProposalOrigin = 'natural' | 'force-commit' | 'confidence-downgrade';

export interface ProposalHistoryRow {
	id: number;
	conversationKey: string;
	proposedAt: number;
	resolvedAt: number | null;
	agentId: string;
	task: string;
	label: string;
	shownText: string;
	resolution: ProposalResolution | null;
	origin: ProposalOrigin;
	agentRunId: string | null;
	expiresAt: number;
	/** ADR-009 Phase 5 — which model branch decided this proposal.
	 *  Null on rows from the v1 path (Gemini classifier) and on rows
	 *  written before the column was added. */
	modelBranch: string | null;
	/** ADR-009 Phase 6 — set to 1 when the user flagged the dispatched
	 *  agent as wrong (via the `/wrong` command). Default 0. */
	wrongDispatch: number;
}

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS proposal_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_key TEXT NOT NULL,
			proposed_at INTEGER NOT NULL,
			resolved_at INTEGER,
			agent_id TEXT NOT NULL,
			task TEXT NOT NULL,
			label TEXT NOT NULL,
			shown_text TEXT NOT NULL,
			resolution TEXT,
			origin TEXT NOT NULL DEFAULT 'natural',
			agent_run_id TEXT,
			expires_at INTEGER NOT NULL,
			model_branch TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_proposal_history_conv
			ON proposal_history(conversation_key, proposed_at DESC);
		CREATE INDEX IF NOT EXISTS idx_proposal_history_unresolved
			ON proposal_history(conversation_key, resolved_at)
			WHERE resolved_at IS NULL;
	`);

	// Lazy migrations for tables that pre-date a column add. PRAGMA-checked
	// so each migration is idempotent. Run BEFORE creating any index that
	// references a migrated column — otherwise the index creation fails on
	// older databases where the column doesn't yet exist.
	const cols = db.prepare(`PRAGMA table_info(proposal_history)`).all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === 'origin')) {
		// ADR-008 Phase 8 — origin tracks WHY a proposal was created.
		db.exec(`ALTER TABLE proposal_history ADD COLUMN origin TEXT NOT NULL DEFAULT 'natural'`);
	}
	if (!cols.some((c) => c.name === 'model_branch')) {
		// ADR-009 Phase 5 — model_branch tracks which A/B branch decided
		// the proposal. NULL-able because v1 (Gemini) rows pre-date the
		// branch concept; only orchestrator-v2 rows populate this.
		db.exec(`ALTER TABLE proposal_history ADD COLUMN model_branch TEXT`);
	}
	if (!cols.some((c) => c.name === 'wrong_dispatch')) {
		// ADR-009 Phase 6 — user-flagged wrong-dispatch indicator. Written
		// by `flagWrongDispatch()` when the user replies `/wrong` after a
		// confirmed dispatch lands the wrong agent. Read by Phase 7 winner
		// selection — any branch with ≥1 wrong-dispatch fails the falsifier.
		db.exec(
			`ALTER TABLE proposal_history ADD COLUMN wrong_dispatch INTEGER NOT NULL DEFAULT 0`,
		);
	}

	// Indexes that reference migrated columns — created last so the column
	// is guaranteed to exist on legacy databases.
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_proposal_history_branch
			ON proposal_history(model_branch, proposed_at DESC)
			WHERE model_branch IS NOT NULL;
		CREATE INDEX IF NOT EXISTS idx_proposal_history_wrong
			ON proposal_history(model_branch)
			WHERE wrong_dispatch = 1;
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

/** Record a fresh proposal. Returns the new history id so callers can bind
 *  the eventual agent run via `bindAgentRun(historyId, runId)`.
 *
 *  `origin` (ADR-008 Phase 8) records WHY the proposal was created — set
 *  to `'force-commit'` when the clarify-cap guard fired, `'confidence-
 *  downgrade'` when a `dispatch` decision dropped to propose-dispatch
 *  because confidence < 0.85, and `'natural'` (default) for everything
 *  else. */
export function recordProposal(input: {
	conversationKey: string;
	agentId: string;
	task: string;
	label: string;
	shownText: string;
	expiresAt: number;
	origin?: ProposalOrigin;
	/** ADR-009 Phase 5 — model branch that decided this proposal. Pass
	 *  `null` / undefined for v1 rows (Gemini classifier path); the
	 *  orchestrator-v2 path passes the assigned branch name. */
	modelBranch?: string | null;
}): number {
	const handle = db();
	const now = Date.now();

	// Any older unresolved row on this conversation gets `superseded`.
	handle
		.prepare(
			`UPDATE proposal_history
				SET resolved_at = ?, resolution = 'superseded'
				WHERE conversation_key = ? AND resolved_at IS NULL`,
		)
		.run(now, input.conversationKey);

	const result = handle
		.prepare(
			`INSERT INTO proposal_history
				(conversation_key, proposed_at, agent_id, task, label, shown_text, origin, expires_at, model_branch)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.conversationKey,
			now,
			input.agentId,
			input.task,
			input.label,
			input.shownText,
			input.origin ?? 'natural',
			input.expiresAt,
			input.modelBranch ?? null,
		);

	return Number(result.lastInsertRowid);
}

/** Resolve a proposal by conversation key. Updates the most recent
 *  unresolved row. No-op when nothing is unresolved (defensive — callers
 *  may call this from cancel paths where a proposal was never issued). */
export function resolveByConversation(
	conversationKey: string,
	resolution: ProposalResolution,
): number | null {
	const handle = db();
	const row = handle
		.prepare(
			`SELECT id FROM proposal_history
				WHERE conversation_key = ? AND resolved_at IS NULL
				ORDER BY proposed_at DESC
				LIMIT 1`,
		)
		.get(conversationKey) as { id: number } | undefined;

	if (!row) return null;

	handle
		.prepare(
			`UPDATE proposal_history
				SET resolved_at = ?, resolution = ?
				WHERE id = ?`,
		)
		.run(Date.now(), resolution, row.id);

	return row.id;
}

/** Bind an agent run to an existing history row — used by the dispatch
 *  worker once a runId is assigned. Idempotent: re-binding overwrites. */
export function bindAgentRun(historyId: number, agentRunId: string): void {
	db()
		.prepare(`UPDATE proposal_history SET agent_run_id = ? WHERE id = ?`)
		.run(agentRunId, historyId);
}

/** Find the most recently `confirm`-resolved row for this conversation that
 *  has no agent run bound yet, and bind the given runId to it. Used by the
 *  dispatch worker — it knows the runId but not the historyId, and the
 *  resolution already happened in the inbound handler. Returns the id that
 *  was bound, or null when no candidate exists (e.g. dispatch fired without
 *  going through propose-confirm). */
export function bindLatestConfirmed(
	conversationKey: string,
	agentId: string,
	agentRunId: string,
): number | null {
	const handle = db();
	const row = handle
		.prepare(
			`SELECT id FROM proposal_history
				WHERE conversation_key = ?
				  AND agent_id = ?
				  AND resolution = 'confirm'
				  AND agent_run_id IS NULL
				ORDER BY resolved_at DESC
				LIMIT 1`,
		)
		.get(conversationKey, agentId) as { id: number } | undefined;

	if (!row) return null;
	bindAgentRun(row.id, agentRunId);
	return row.id;
}

const SELECT_COLS = `
	id,
	conversation_key  AS conversationKey,
	proposed_at       AS proposedAt,
	resolved_at       AS resolvedAt,
	agent_id          AS agentId,
	task,
	label,
	shown_text        AS shownText,
	resolution,
	origin,
	agent_run_id      AS agentRunId,
	expires_at        AS expiresAt
`;

/** Recent proposals for a conversation, newest first. Use for UI surfacing
 *  ("recent proposals" in /agents/orchestrator) and analytics queries. */
export function recentProposals(
	conversationKey: string,
	limit = 20,
): ProposalHistoryRow[] {
	return db()
		.prepare(
			`SELECT ${SELECT_COLS}
				FROM proposal_history
				WHERE conversation_key = ?
				ORDER BY proposed_at DESC
				LIMIT ?`,
		)
		.all(conversationKey, limit) as ProposalHistoryRow[];
}

/** Lifetime stats per agent — confirm rate, decline rate, expired rate, plus
 *  ADR-008 Phase 8 origin breakdown so the operations dashboard can tell
 *  whether force-commit-origin proposals are being declined more often than
 *  natural-origin ones (the falsifier triggers tightening `deterministicTask`
 *  if force-commit decline rate ≥40%). */
export interface ProposalStats {
	agentId: string;
	totalProposed: number;
	confirmed: number;
	declined: number;
	switchedToWeb: number;
	expired: number;
	superseded: number;
	confirmRate: number; // confirmed / (confirmed + declined + switched + expired) — excludes superseded
	byOrigin: {
		natural: number;
		forceCommit: number;
		confidenceDowngrade: number;
	};
}

export function statsByAgent(): ProposalStats[] {
	const rows = db()
		.prepare(
			`SELECT
				agent_id AS agentId,
				COUNT(*) AS totalProposed,
				SUM(CASE WHEN resolution = 'confirm' THEN 1 ELSE 0 END) AS confirmed,
				SUM(CASE WHEN resolution = 'decline' THEN 1 ELSE 0 END) AS declined,
				SUM(CASE WHEN resolution = 'switch-to-web' THEN 1 ELSE 0 END) AS switchedToWeb,
				SUM(CASE WHEN resolution = 'expired' THEN 1 ELSE 0 END) AS expired,
				SUM(CASE WHEN resolution = 'superseded' THEN 1 ELSE 0 END) AS superseded,
				SUM(CASE WHEN origin = 'natural' THEN 1 ELSE 0 END) AS naturalCount,
				SUM(CASE WHEN origin = 'force-commit' THEN 1 ELSE 0 END) AS forceCommitCount,
				SUM(CASE WHEN origin = 'confidence-downgrade' THEN 1 ELSE 0 END) AS confidenceDowngradeCount
			FROM proposal_history
			GROUP BY agent_id
			ORDER BY totalProposed DESC`,
		)
		.all() as Array<{
		agentId: string;
		totalProposed: number;
		confirmed: number;
		declined: number;
		switchedToWeb: number;
		expired: number;
		superseded: number;
		naturalCount: number;
		forceCommitCount: number;
		confidenceDowngradeCount: number;
	}>;

	return rows.map((r) => {
		const denom = r.confirmed + r.declined + r.switchedToWeb + r.expired;
		return {
			agentId: r.agentId,
			totalProposed: r.totalProposed,
			confirmed: r.confirmed,
			declined: r.declined,
			switchedToWeb: r.switchedToWeb,
			expired: r.expired,
			superseded: r.superseded,
			confirmRate: denom > 0 ? r.confirmed / denom : 0,
			byOrigin: {
				natural: r.naturalCount,
				forceCommit: r.forceCommitCount,
				confidenceDowngrade: r.confidenceDowngradeCount,
			},
		};
	});
}

export interface BranchStats {
	modelBranch: string;
	totalProposed: number;
	confirmed: number;
	declined: number;
	switchedToWeb: number;
	expired: number;
	superseded: number;
	/** confirmRate = confirmed / (confirmed + declined + switchedToWeb + expired). */
	confirmRate: number;
	/** ADR-009 Phase 6 falsifier — count of `/wrong`-flagged dispatches.
	 *  ≥1 in 14 days kills the branch. */
	wrongDispatchCount: number;
}

/** ADR-009 Phase 5 — analytics aggregator for the 14-day model A/B.
 *  Groups `proposal_history` rows by `model_branch`, skipping rows where
 *  `model_branch IS NULL` (v1 / legacy rows). Phase 7 reads this to pick
 *  a winner. */
export function getProposalStatsByBranch(): BranchStats[] {
	const rows = db()
		.prepare(
			`SELECT
				model_branch AS modelBranch,
				COUNT(*) AS totalProposed,
				SUM(CASE WHEN resolution = 'confirm' THEN 1 ELSE 0 END) AS confirmed,
				SUM(CASE WHEN resolution = 'decline' THEN 1 ELSE 0 END) AS declined,
				SUM(CASE WHEN resolution = 'switch-to-web' THEN 1 ELSE 0 END) AS switchedToWeb,
				SUM(CASE WHEN resolution = 'expired' THEN 1 ELSE 0 END) AS expired,
				SUM(CASE WHEN resolution = 'superseded' THEN 1 ELSE 0 END) AS superseded,
				SUM(CASE WHEN wrong_dispatch = 1 THEN 1 ELSE 0 END) AS wrongDispatchCount
			FROM proposal_history
			WHERE model_branch IS NOT NULL
			GROUP BY model_branch
			ORDER BY totalProposed DESC`,
		)
		.all() as Array<{
		modelBranch: string;
		totalProposed: number;
		confirmed: number;
		declined: number;
		switchedToWeb: number;
		expired: number;
		superseded: number;
		wrongDispatchCount: number;
	}>;

	return rows.map((r) => {
		const denom = r.confirmed + r.declined + r.switchedToWeb + r.expired;
		return {
			modelBranch: r.modelBranch,
			totalProposed: r.totalProposed,
			confirmed: r.confirmed,
			declined: r.declined,
			switchedToWeb: r.switchedToWeb,
			expired: r.expired,
			superseded: r.superseded,
			confirmRate: denom > 0 ? r.confirmed / denom : 0,
			wrongDispatchCount: r.wrongDispatchCount,
		};
	});
}

export interface WrongDispatchFlagResult {
	flagged: boolean;
	historyId: number | null;
	modelBranch: string | null;
	agentId: string | null;
	task: string | null;
}

/** ADR-009 Phase 6 — flag the most recent confirmed dispatch on the
 *  conversation as wrong-agent. Returns the row id + branch + agent so
 *  the caller can fire a Telegram alert. Returns `flagged: false` when
 *  no recent confirm exists (defensive — keeps the `/wrong` command
 *  idempotent on accidental triggers). */
export function flagWrongDispatch(conversationKey: string): WrongDispatchFlagResult {
	const handle = db();
	const row = handle
		.prepare(
			`SELECT id, model_branch AS modelBranch, agent_id AS agentId, task
				FROM proposal_history
				WHERE conversation_key = ? AND resolution = 'confirm'
				ORDER BY proposed_at DESC
				LIMIT 1`,
		)
		.get(conversationKey) as
		| { id: number; modelBranch: string | null; agentId: string; task: string }
		| undefined;
	if (!row) {
		return { flagged: false, historyId: null, modelBranch: null, agentId: null, task: null };
	}
	handle
		.prepare(`UPDATE proposal_history SET wrong_dispatch = 1 WHERE id = ?`)
		.run(row.id);
	return {
		flagged: true,
		historyId: row.id,
		modelBranch: row.modelBranch,
		agentId: row.agentId,
		task: row.task,
	};
}
