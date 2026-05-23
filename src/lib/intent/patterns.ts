/** Per ADR-023 Phase 1.5 — intent pattern proposals + approval queue.
 *
 *  Three tables, all in the same `inbox.db` as `intent_log` + `chat_history`:
 *
 *    intent_patterns_proposed   pending approval; written by the analyst
 *    intent_patterns_rejected   dismissed; analyst should not re-propose
 *    intent_patterns            approved runtime table; consulted by the
 *                                Phase 2 lookup engine (NOT consulted yet —
 *                                P1.5 only populates this table when the
 *                                operator approves, the runtime read path
 *                                ships in P2 with the kill switch
 *                                `intent.patternEngine.enabled`)
 *
 *  Schemas are created lazily on first access — fresh installs work
 *  without a migration step (consistent with how `intent/log.ts` and
 *  `chat_history` handle their tables). */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';
import { normalizeSignature } from './normalize.js';

export type MatchKind = 'exact' | 'prefix' | 'contains' | 'regex';

export interface PatternProposal {
	batchId: string;
	signature: string;
	matchKind: MatchKind;
	pickedRoute: string;
	placeholderText: string | null;
	confidence: number;
	conversationKey: string | null;
	citations: string[];
	rationale: string | null;
}

export interface ProposedRow {
	id: number;
	batchId: string;
	signature: string;
	matchKind: MatchKind;
	pickedRoute: string;
	placeholderText: string | null;
	confidence: number;
	conversationKey: string | null;
	citations: string[];
	rationale: string | null;
	proposedAt: number;
	dismissedAt: number | null;
}

export interface PatternRow {
	id: number;
	signature: string;
	matchKind: MatchKind;
	pickedRoute: string;
	placeholderText: string | null;
	confidence: number;
	conversationKey: string | null;
	approvedAt: number;
	approvedBy: string;
	hitCount: number;
	lastHitTs: number | null;
	retiredAt: number | null;
}

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS intent_patterns_proposed (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			batch_id TEXT NOT NULL,
			signature TEXT NOT NULL,
			match_kind TEXT NOT NULL CHECK(match_kind IN ('exact','prefix','contains','regex')),
			picked_route TEXT NOT NULL,
			placeholder_text TEXT,
			confidence REAL NOT NULL,
			conversation_key TEXT,
			citations_json TEXT NOT NULL,
			rationale TEXT,
			proposed_at INTEGER NOT NULL,
			dismissed_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_intent_proposed_batch
			ON intent_patterns_proposed(batch_id, dismissed_at);
		CREATE INDEX IF NOT EXISTS idx_intent_proposed_pending
			ON intent_patterns_proposed(dismissed_at, proposed_at);

		CREATE TABLE IF NOT EXISTS intent_patterns_rejected (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			signature TEXT NOT NULL,
			match_kind TEXT NOT NULL,
			picked_route TEXT NOT NULL,
			conversation_key TEXT,
			rejected_at INTEGER NOT NULL,
			reason TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_intent_rejected_signature
			ON intent_patterns_rejected(signature);

		CREATE TABLE IF NOT EXISTS intent_patterns (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			signature TEXT NOT NULL,
			match_kind TEXT NOT NULL CHECK(match_kind IN ('exact','prefix','contains','regex')),
			picked_route TEXT NOT NULL,
			placeholder_text TEXT,
			confidence REAL NOT NULL,
			conversation_key TEXT,
			approved_at INTEGER NOT NULL,
			approved_by TEXT NOT NULL DEFAULT 'user',
			hit_count INTEGER NOT NULL DEFAULT 0,
			last_hit_ts INTEGER,
			retired_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_intent_patterns_lookup
			ON intent_patterns(signature, retired_at);
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

export function writeProposals(proposals: PatternProposal[]): number {
	if (proposals.length === 0) return 0;
	const now = Date.now();
	const stmt = db().prepare(
		`INSERT INTO intent_patterns_proposed
		 (batch_id, signature, match_kind, picked_route, placeholder_text,
		  confidence, conversation_key, citations_json, rationale, proposed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const tx = db().transaction((rows: PatternProposal[]) => {
		let count = 0;
		for (const p of rows) {
			stmt.run(
				p.batchId,
				p.signature,
				p.matchKind,
				p.pickedRoute,
				p.placeholderText,
				p.confidence,
				p.conversationKey,
				JSON.stringify(p.citations),
				p.rationale,
				now,
			);
			count += 1;
		}
		return count;
	});
	return tx(proposals);
}

interface ProposedRawRow {
	id: number;
	batch_id: string;
	signature: string;
	match_kind: MatchKind;
	picked_route: string;
	placeholder_text: string | null;
	confidence: number;
	conversation_key: string | null;
	citations_json: string;
	rationale: string | null;
	proposed_at: number;
	dismissed_at: number | null;
}

function hydrateProposed(r: ProposedRawRow): ProposedRow {
	let citations: string[] = [];
	try {
		const parsed: unknown = JSON.parse(r.citations_json);
		if (Array.isArray(parsed)) citations = parsed.filter((c): c is string => typeof c === 'string');
	} catch {
		// Defensive — never let a corrupt citations row break listing.
	}
	return {
		id: r.id,
		batchId: r.batch_id,
		signature: r.signature,
		matchKind: r.match_kind,
		pickedRoute: r.picked_route,
		placeholderText: r.placeholder_text,
		confidence: r.confidence,
		conversationKey: r.conversation_key,
		citations,
		rationale: r.rationale,
		proposedAt: r.proposed_at,
		dismissedAt: r.dismissed_at,
	};
}

/** List pending (un-dismissed) proposals. Most-recent batch first. */
export function listProposed(opts: { batchId?: string; includeDismissed?: boolean } = {}): ProposedRow[] {
	const where: string[] = [];
	const params: unknown[] = [];
	if (opts.batchId) {
		where.push('batch_id = ?');
		params.push(opts.batchId);
	}
	if (!opts.includeDismissed) {
		where.push('dismissed_at IS NULL');
	}
	const sql = `
		SELECT id, batch_id, signature, match_kind, picked_route, placeholder_text,
		       confidence, conversation_key, citations_json, rationale,
		       proposed_at, dismissed_at
		FROM intent_patterns_proposed
		${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
		ORDER BY proposed_at DESC, id DESC
	`;
	const rows = db().prepare(sql).all(...params) as ProposedRawRow[];
	return rows.map(hydrateProposed);
}

export function getProposed(id: number): ProposedRow | null {
	const row = db()
		.prepare(
			`SELECT id, batch_id, signature, match_kind, picked_route, placeholder_text,
			        confidence, conversation_key, citations_json, rationale,
			        proposed_at, dismissed_at
			 FROM intent_patterns_proposed WHERE id = ?`,
		)
		.get(id) as ProposedRawRow | undefined;
	return row ? hydrateProposed(row) : null;
}

export interface PromoteResult {
	ok: boolean;
	patternId?: number;
	error?: string;
}

/** Promote a proposed row to the live `intent_patterns` table. Atomic:
 *  insert into intent_patterns + mark the proposal dismissed in a single
 *  transaction so a crash mid-promote can't leave it half-applied.
 *  Idempotent — calling on an already-dismissed proposal returns ok:false. */
export function promoteProposal(id: number, approvedBy = 'user'): PromoteResult {
	const proposal = getProposed(id);
	if (!proposal) return { ok: false, error: `proposal ${id} not found` };
	if (proposal.dismissedAt !== null) return { ok: false, error: `proposal ${id} already resolved` };

	const now = Date.now();
	const tx = db().transaction(() => {
		const insert = db()
			.prepare(
				`INSERT INTO intent_patterns
				 (signature, match_kind, picked_route, placeholder_text, confidence,
				  conversation_key, approved_at, approved_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				proposal.signature,
				proposal.matchKind,
				proposal.pickedRoute,
				proposal.placeholderText,
				proposal.confidence,
				proposal.conversationKey,
				now,
				approvedBy,
			);
		db()
			.prepare(`UPDATE intent_patterns_proposed SET dismissed_at = ? WHERE id = ?`)
			.run(now, id);
		return Number(insert.lastInsertRowid);
	});
	const patternId = tx();
	return { ok: true, patternId };
}

export interface RejectResult {
	ok: boolean;
	rejectedId?: number;
	error?: string;
}

/** Reject a proposal. Writes to `intent_patterns_rejected` (so the analyst
 *  can dedupe future proposals against rejection history) and marks the
 *  proposal dismissed. */
export function rejectProposal(id: number, reason?: string): RejectResult {
	const proposal = getProposed(id);
	if (!proposal) return { ok: false, error: `proposal ${id} not found` };
	if (proposal.dismissedAt !== null) return { ok: false, error: `proposal ${id} already resolved` };

	const now = Date.now();
	const tx = db().transaction(() => {
		const insert = db()
			.prepare(
				`INSERT INTO intent_patterns_rejected
				 (signature, match_kind, picked_route, conversation_key, rejected_at, reason)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				proposal.signature,
				proposal.matchKind,
				proposal.pickedRoute,
				proposal.conversationKey,
				now,
				reason ?? null,
			);
		db()
			.prepare(`UPDATE intent_patterns_proposed SET dismissed_at = ? WHERE id = ?`)
			.run(now, id);
		return Number(insert.lastInsertRowid);
	});
	const rejectedId = tx();
	return { ok: true, rejectedId };
}

export interface BatchResolveResult {
	promoted: number;
	rejected: number;
	deferred: number;
	skipped: number;
}

/** Approve every pending proposal in a batch. Each row goes through
 *  `promoteProposal` (already-resolved rows are skipped). */
export function promoteAllInBatch(batchId: string, approvedBy = 'user'): BatchResolveResult {
	const pending = listProposed({ batchId });
	let promoted = 0;
	let skipped = 0;
	for (const row of pending) {
		const r = promoteProposal(row.id, approvedBy);
		if (r.ok) promoted += 1;
		else skipped += 1;
	}
	return { promoted, rejected: 0, deferred: 0, skipped };
}

/** Defer a batch — mark every still-pending proposal as dismissed without
 *  writing to rejected. The analyst will see these signatures again on
 *  next run and may re-propose if the evidence persists. */
export function deferBatch(batchId: string): BatchResolveResult {
	const pending = listProposed({ batchId });
	const now = Date.now();
	const stmt = db().prepare(
		`UPDATE intent_patterns_proposed SET dismissed_at = ? WHERE id = ?`,
	);
	let deferred = 0;
	const tx = db().transaction(() => {
		for (const row of pending) {
			stmt.run(now, row.id);
			deferred += 1;
		}
	});
	tx();
	return { promoted: 0, rejected: 0, deferred, skipped: 0 };
}

/** Signatures the analyst has been told "no" on already. Used to scrub
 *  obvious repeats out of new proposal batches before they hit the queue.
 *  Returns lowercase signatures for easy Set lookup. */
export function rejectedSignatures(limit = 200): Set<string> {
	const rows = db()
		.prepare<[number]>(
			`SELECT signature FROM intent_patterns_rejected
			 ORDER BY rejected_at DESC LIMIT ?`,
		)
		.all(limit) as Array<{ signature: string }>;
	return new Set(rows.map((r) => r.signature.toLowerCase()));
}

/** Confidence floor for the runtime engine to actually short-circuit the
 *  LLM router. The table allows proposals as low as 0.80 (so the operator
 *  can keep a low-confidence rule visible without it firing); the runtime
 *  needs to be stricter because one bad route burns more trust than ten
 *  LLM calls.  ADR-023 §Phase 2. */
const PATTERN_CONFIDENCE_FLOOR = 0.95;

export interface PatternHit {
	/** Discriminator. `learned` = operator-approved row in `intent_patterns`
	 *  (the P2 path). `history` = ADR-023 §P3 fallback derived from raw
	 *  `intent_log` agreement when no learned pattern matched. */
	kind: 'learned' | 'history';
	/** Set when `kind: 'learned'` — points at the `intent_patterns.id` that
	 *  fired. `null` for history hits because there's no persistent row to
	 *  reference; the agreement is recomputed each request. */
	patternId: number | null;
	signature: string;
	pickedRoute: string;
	placeholderText: string | null;
	confidence: number;
	matchKind: MatchKind;
	scope: 'per-user' | 'global';
	/** Only set for history hits: extra evidence for the audit trail
	 *  ("12/13 votes for vault-chat over 30 days"). */
	votes?: { route: string; count: number; total: number };
}

interface RuntimePatternRow {
	id: number;
	signature: string;
	match_kind: MatchKind;
	picked_route: string;
	placeholder_text: string | null;
	confidence: number;
	conversation_key: string | null;
}

/** Specificity score — drives priority when multiple patterns match.
 *  Lower number = higher priority. Per-user beats global. Within scope,
 *  exact > prefix > contains. Regex is allowed in the schema but the
 *  analyst never emits it in P1.5, and the runtime skips it for safety
 *  (regex lookups need their own compile + audit). */
function priorityScore(scope: 'per-user' | 'global', kind: MatchKind): number {
	const scopeBase = scope === 'per-user' ? 0 : 10;
	const kindOffset =
		kind === 'exact' ? 0 : kind === 'prefix' ? 1 : kind === 'contains' ? 2 : 9;
	return scopeBase + kindOffset;
}

function matches(message: string, signature: string, kind: MatchKind): boolean {
	const msg = message.toLowerCase();
	const sig = signature.toLowerCase();
	if (!sig) return false;
	if (kind === 'exact') return msg === sig;
	if (kind === 'prefix') return msg.startsWith(sig);
	if (kind === 'contains') return msg.includes(sig);
	return false; // regex not supported in v0 — safety
}

/** Runtime lookup. Returns null on miss / disabled. Lazy — only reads
 *  the table when called, so an idle channel pays nothing.
 *
 *  Lookup order (highest priority first):
 *    1. per-user exact
 *    2. per-user prefix
 *    3. per-user contains
 *    4. global exact
 *    5. global prefix
 *    6. global contains
 *
 *  Within an equal-priority tier, higher `confidence` wins.
 *
 *  Side effect on hit: bumps `hit_count` + `last_hit_ts` so the analyst
 *  can later flag stale patterns ("no hits in 30 days → propose retire").
 *  The bump is best-effort; it never throws back to the router. */
export function tryPatternRoute(
	message: string,
	conversationKey?: string,
): PatternHit | null {
	if (!message) return null;

	const rows = db()
		.prepare<[string | null]>(
			`SELECT id, signature, match_kind, picked_route, placeholder_text,
			        confidence, conversation_key
			 FROM intent_patterns
			 WHERE retired_at IS NULL
			   AND confidence >= ${PATTERN_CONFIDENCE_FLOOR}
			   AND (conversation_key IS NULL OR conversation_key = ?)`,
		)
		.all(conversationKey ?? null) as RuntimePatternRow[];

	if (rows.length === 0) return null;

	const hits: Array<{ row: RuntimePatternRow; priority: number; scope: 'per-user' | 'global' }> = [];
	for (const row of rows) {
		const scope: 'per-user' | 'global' = row.conversation_key ? 'per-user' : 'global';
		if (scope === 'per-user' && row.conversation_key !== (conversationKey ?? null)) continue;
		if (!matches(message, row.signature, row.match_kind)) continue;
		hits.push({ row, scope, priority: priorityScore(scope, row.match_kind) });
	}

	if (hits.length === 0) return null;

	// Sort: priority ASC (lower = better), confidence DESC, id ASC (stable).
	hits.sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		if (a.row.confidence !== b.row.confidence) return b.row.confidence - a.row.confidence;
		return a.row.id - b.row.id;
	});

	const best = hits[0];
	bumpPatternHit(best.row.id);

	return {
		kind: 'learned',
		patternId: best.row.id,
		signature: best.row.signature,
		pickedRoute: best.row.picked_route,
		placeholderText: best.row.placeholder_text,
		confidence: best.row.confidence,
		matchKind: best.row.match_kind,
		scope: best.scope,
	};
}

/** Increments hit_count and stamps last_hit_ts. Best-effort. Internal —
 *  only `tryPatternRoute` calls this; the runtime doesn't expose a
 *  manual bump path because hit-counts are derived signal, not operator
 *  state. */
function bumpPatternHit(patternId: number, now = Date.now()): void {
	try {
		db()
			.prepare(
				`UPDATE intent_patterns
				 SET hit_count = hit_count + 1, last_hit_ts = ?
				 WHERE id = ?`,
			)
			.run(now, patternId);
	} catch (err) {
		console.warn(`[intent-patterns] hit-count bump failed: ${(err as Error).message}`);
	}
}

interface HistoryFallbackOptions {
	/** Minimum number of historical rows agreeing on the route. Default 5. */
	minVotes?: number;
	/** Minimum share of votes the top route must hold to win. Default 0.90. */
	minAgreement?: number;
	/** Time window in days to consider. Default 30. */
	windowDays?: number;
	/** Override "now" for testing. */
	now?: number;
}

/** ADR-023 §Phase 3 — history fallback.
 *
 *  When no operator-approved learned pattern matches, look at the user's
 *  own recent `intent_log` rows with the *same normalized signature*. If
 *  enough recent rows agreed on a single route, treat that as an implicit
 *  pattern for this turn only (no row persisted; the agreement is
 *  recomputed every call).
 *
 *  Filters:
 *    - `source IN ('llm','regex','pattern')` — exclude `'fallback'`
 *      because those are router failures, not learnable intent signal.
 *    - `ts >= now - windowDays` — old routes shouldn't bake in stale wrong
 *      decisions.
 *
 *  Result thresholds:
 *    - total votes >= minVotes (default 5)
 *    - top-route share >= minAgreement (default 0.90)
 *
 *  Returns null on miss / disabled / no conversationKey. */
export function tryHistoryFallback(
	message: string,
	conversationKey: string | undefined,
	opts: HistoryFallbackOptions = {},
): PatternHit | null {
	if (!message || !conversationKey) return null;
	const minVotes = opts.minVotes ?? 5;
	const minAgreement = opts.minAgreement ?? 0.9;
	const windowDays = opts.windowDays ?? 30;
	const now = opts.now ?? Date.now();
	const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

	const signature = normalizeSignature(message);
	if (!signature) return null;

	const rows = db()
		.prepare<[string, string, number]>(
			`SELECT picked_route, COUNT(*) AS n
			 FROM intent_log
			 WHERE conversation_key = ?
			   AND normalized_signature = ?
			   AND ts >= ?
			   AND source IN ('llm','regex','pattern')
			 GROUP BY picked_route
			 ORDER BY n DESC, picked_route ASC`,
		)
		.all(conversationKey, signature, cutoff) as Array<{ picked_route: string; n: number }>;

	if (rows.length === 0) return null;

	const total = rows.reduce((s, r) => s + r.n, 0);
	if (total < minVotes) return null;

	const top = rows[0];
	const agreement = top.n / total;
	if (agreement < minAgreement) return null;

	return {
		kind: 'history',
		patternId: null,
		signature,
		pickedRoute: top.picked_route,
		placeholderText: null,
		confidence: agreement,
		matchKind: 'exact',
		scope: 'per-user',
		votes: { route: top.picked_route, count: top.n, total },
	};
}

/** Soft-delete a pattern. Idempotent. */
export function retirePattern(patternId: number, now = Date.now()): boolean {
	const r = db()
		.prepare(`UPDATE intent_patterns SET retired_at = ? WHERE id = ? AND retired_at IS NULL`)
		.run(now, patternId);
	return r.changes > 0;
}

/** Active runtime patterns (not retired). Phase 2 will read this; P1.5
 *  ships the writer side only. Kept here so the API and an eventual
 *  settings UI can preview what's approved without taking a dep on P2. */
export function listActivePatterns(): PatternRow[] {
	const rows = db()
		.prepare(
			`SELECT id, signature, match_kind, picked_route, placeholder_text,
			        confidence, conversation_key, approved_at, approved_by,
			        hit_count, last_hit_ts, retired_at
			 FROM intent_patterns
			 WHERE retired_at IS NULL
			 ORDER BY approved_at DESC`,
		)
		.all() as Array<{
		id: number;
		signature: string;
		match_kind: MatchKind;
		picked_route: string;
		placeholder_text: string | null;
		confidence: number;
		conversation_key: string | null;
		approved_at: number;
		approved_by: string;
		hit_count: number;
		last_hit_ts: number | null;
		retired_at: number | null;
	}>;
	return rows.map((r) => ({
		id: r.id,
		signature: r.signature,
		matchKind: r.match_kind,
		pickedRoute: r.picked_route,
		placeholderText: r.placeholder_text,
		confidence: r.confidence,
		conversationKey: r.conversation_key,
		approvedAt: r.approved_at,
		approvedBy: r.approved_by,
		hitCount: r.hit_count,
		lastHitTs: r.last_hit_ts,
		retiredAt: r.retired_at,
	}));
}
