/** Per ADR-023 Phase 1 — persistent intent decision log.
 *
 *  Replaces the in-memory ring buffer in `whatsapp/router.ts:67` for
 *  durability across restarts. The pattern miner (Phase 1.5, future)
 *  reads this table to propose deterministic routing rules.
 *
 *  Storage: same `~/.soul-hub/data/inbox.db` SQLite file as
 *  `chat_history` (per ADR-021). Schema is created lazily on first
 *  access — no migration step for fresh installs.
 *
 *  Wire shape: every routing decision in `routeFreeForm` writes one
 *  row. Slash commands skip the router and don't get logged (their
 *  intent is unambiguous; nothing to learn). */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';

export type IntentSource = 'regex' | 'llm' | 'pattern' | 'fallback';

export interface IntentDecision {
	ts: number;
	conversationKey: string;
	rawMessage: string;
	normalizedSignature: string;
	pickedRoute: string;
	source: IntentSource;
	confidence?: number;
	latencyMs?: number;
	/** ADR-033 §Engines play 1 — 12-char SHA1 prefix of the composed
	 *  persona bundle that was injected into the orchestrator-v2 system
	 *  prompt at decision time. Stamping it here turns the intent-learner's
	 *  nightly mining into an automatic persona-regression detector: when
	 *  `personaVersion` changes (operator edits `operations/soul.md` etc.),
	 *  the next morning's audit shows route distributions stratified by
	 *  persona version. Undefined for `regex`/`fallback` sources that
	 *  bypass the orchestrator entirely. */
	personaVersion?: string;
}

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS intent_log (
			ts INTEGER NOT NULL,
			conversation_key TEXT NOT NULL,
			raw_message TEXT NOT NULL,
			normalized_signature TEXT NOT NULL,
			picked_route TEXT NOT NULL,
			source TEXT NOT NULL CHECK(source IN ('regex','llm','pattern','fallback')),
			confidence REAL,
			latency_ms INTEGER,
			satisfied INTEGER,
			PRIMARY KEY (conversation_key, ts)
		);
		CREATE INDEX IF NOT EXISTS idx_intent_log_signature
			ON intent_log(normalized_signature, ts DESC);
		CREATE INDEX IF NOT EXISTS idx_intent_log_recent
			ON intent_log(ts DESC);
		-- ADR-023 §Phase 3: history-fallback lookup query is
		-- (conversation_key, normalized_signature, ts DESC). Existing PK
		-- (conversation_key, ts) covers the user-scoped scan but doesn't
		-- help with signature filtering. Additive composite index — safe
		-- on existing DBs because IF NOT EXISTS is idempotent.
		CREATE INDEX IF NOT EXISTS idx_intent_log_by_user_sig
			ON intent_log(conversation_key, normalized_signature, ts DESC);
	`);

	// ADR-033 §Engines play 1 — additive column for persona version
	// stratification. PRAGMA table_info gate keeps migration idempotent on
	// existing DBs without an ALTER-OR-IGNORE syntax in SQLite. Older rows
	// stay NULL (pre-ADR-033 era); the audit dashboard treats NULL as
	// `(pre-persona)` rather than a missing field.
	const cols = db.prepare(`PRAGMA table_info(intent_log)`).all() as Array<{ name: string }>;
	if (!cols.some((c) => c.name === 'persona_version')) {
		db.exec(`ALTER TABLE intent_log ADD COLUMN persona_version TEXT`);
	}
}

function db(): Database {
	const handle = getInboxDb();
	if (!schemaReady) {
		ensureSchema(handle);
		schemaReady = true;
	}
	return handle;
}

/** Record one routing decision. Best-effort: the writer never throws;
 *  a logging failure must never break the user-facing reply path. */
export function writeIntentDecision(decision: IntentDecision): void {
	if (!decision.conversationKey || !decision.rawMessage) return;
	try {
		db()
			.prepare(
				`INSERT OR REPLACE INTO intent_log
				 (ts, conversation_key, raw_message, normalized_signature, picked_route, source, confidence, latency_ms, persona_version)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				decision.ts,
				decision.conversationKey,
				decision.rawMessage,
				decision.normalizedSignature,
				decision.pickedRoute,
				decision.source,
				decision.confidence ?? null,
				decision.latencyMs ?? null,
				decision.personaVersion ?? null,
			);
	} catch (err) {
		console.warn(`[intent-log] write failed: ${(err as Error).message}`);
	}
}

/** Sweep rows older than `retentionDays`. Cheap to call; no-op when
 *  there's nothing to delete. Called from the daily intent-mining task
 *  (`runIntentMining`) so the table can't grow unboundedly. */
export function pruneIntentLog(retentionDays = 90, now = Date.now()): number {
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const result = db().prepare(`DELETE FROM intent_log WHERE ts < ?`).run(cutoff);
	return result.changes;
}
