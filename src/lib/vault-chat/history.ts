/** Conversation memory for vault-chat — per-sender (or per-group) sliding
 *  window backed by SQLite so it survives restarts.
 *
 *  Policy (settled with the user, 2026-05-03):
 *    - Window:   last 16 turns OR last 4 hours of activity
 *    - Hard cap: 2KB total content bytes (drops oldest beyond cap)
 *    - Reset:    `/reset`, `/new`, `/clear` commands wipe per-key
 *    - Stale rows pruned on every save
 *    - Conversation key:
 *        DM    → sender's E.164 number (e.g. "+971506691134")
 *        Group → group JID (e.g. "120363xxxxx@g.us") so all members share
 *                one thread of context
 *
 *  Storage: lives in the same `~/.soul-hub/data/inbox.db` SQLite file the
 *  email inbox uses. WAL mode is already on; the schema is created lazily
 *  on first access so new installs don't need a migration step. */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';
import type { ChatMessage } from '../llm/types.js';

const TURN_LIMIT = 16;
const IDLE_GAP_MS = 4 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 2048;
const RESET_COMMANDS = new Set(['/reset', '/new', '/clear']);

interface HistoryRow {
	role: 'user' | 'assistant';
	content: string;
	ts: number;
}

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_history (
			conversation_key TEXT NOT NULL,
			ts INTEGER NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('user','assistant')),
			content TEXT NOT NULL,
			PRIMARY KEY (conversation_key, ts)
		);
		CREATE INDEX IF NOT EXISTS idx_chat_history_recent
			ON chat_history(conversation_key, ts DESC);
	`);
	// Per ADR-021: proactive sends (heartbeat, scheduler reminders, agent
	// follow-ups) tag their row with `source` so we can distinguish them
	// from reactive replies. Additive migration — wrapped because SQLite
	// has no "ADD COLUMN IF NOT EXISTS" so re-runs on a migrated DB throw
	// "duplicate column name" which we treat as success.
	try {
		db.exec(`ALTER TABLE chat_history ADD COLUMN source TEXT`);
	} catch (err) {
		if (!/duplicate column name/i.test((err as Error).message)) throw err;
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

/** True when the user typed a reset command. Pre-empts the LLM call so a
 *  reset is instant + free, and so the wipe can happen at the dispatch
 *  layer before the orchestrator runs. */
export function isResetCommand(text: string | null | undefined): boolean {
	if (typeof text !== 'string') return false;
	return RESET_COMMANDS.has(text.trim().toLowerCase());
}

/** Load the recent turns for a conversation. Returns oldest-first so the
 *  caller can append directly to the LLM `messages` array. Applies all
 *  three policy gates (turn count, idle window, byte cap). */
export function loadHistory(conversationKey: string, now = Date.now()): ChatMessage[] {
	if (!conversationKey) return [];
	const cutoff = now - IDLE_GAP_MS;
	const rows = db()
		.prepare<[string, number, number]>(
			`SELECT role, content, ts FROM chat_history
			 WHERE conversation_key = ? AND ts >= ?
			 ORDER BY ts DESC
			 LIMIT ?`,
		)
		.all(conversationKey, cutoff, TURN_LIMIT) as HistoryRow[];

	// Drop oldest until total content bytes fits under the cap. Newest-first
	// iteration here so the freshest turns always survive the trim.
	let bytes = 0;
	const kept: HistoryRow[] = [];
	for (const row of rows) {
		bytes += row.content.length;
		if (bytes > MAX_TOTAL_BYTES && kept.length > 0) break;
		kept.push(row);
	}

	return kept.reverse().map((r) => ({ role: r.role, content: r.content }));
}

/** Append a turn. Caller saves user + assistant turns separately so the
 *  schema stays flat (one row per turn) and the same time-window query
 *  slices both. */
export function saveTurn(
	conversationKey: string,
	role: 'user' | 'assistant',
	content: string,
	now = Date.now(),
): void {
	if (!conversationKey || !content) return;
	db()
		.prepare(
			`INSERT INTO chat_history (conversation_key, ts, role, content)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(conversationKey, now, role, content);
}

/** Per ADR-021: register a proactive outbound message (heartbeat,
 *  scheduler reminder, agent follow-up) so the next user reply has the
 *  right context. Role is always `assistant`; the `source` column lets
 *  us tell these apart from reactive replies. Returns silently for
 *  empty inputs to keep callers terse. */
export type ProactiveSource = 'heartbeat' | 'scheduler' | 'agent-followup';

export function saveProactiveTurn(
	conversationKey: string,
	content: string,
	source: ProactiveSource,
	now = Date.now(),
): void {
	if (!conversationKey || !content) return;
	db()
		.prepare(
			`INSERT INTO chat_history (conversation_key, ts, role, content, source)
			 VALUES (?, ?, 'assistant', ?, ?)`,
		)
		.run(conversationKey, now, content, source);
}

/** Wipe a conversation. Returns the number of rows removed so the caller
 *  can word the reply ("reset" vs "already empty"). */
export function resetConversation(conversationKey: string): number {
	if (!conversationKey) return 0;
	const result = db()
		.prepare(`DELETE FROM chat_history WHERE conversation_key = ?`)
		.run(conversationKey);
	return result.changes;
}

/** Sweep rows older than the idle window across all conversations. Cheap
 *  to call after every save — keeps the table from growing unboundedly
 *  across abandoned threads. */
export function pruneStaleHistory(now = Date.now()): number {
	const result = db()
		.prepare(`DELETE FROM chat_history WHERE ts < ?`)
		.run(now - IDLE_GAP_MS);
	return result.changes;
}

/** Build the retrieval-time query string. Concatenates the last 2 user
 *  turns plus the new message so lexical search resolves follow-ups like
 *  "tell me more about that" — without prior turns the search has no
 *  topic anchor. Assistant turns are excluded because their generated
 *  prose dilutes lexical scoring. */
export function buildRetrievalInput(history: ChatMessage[], newMessage: string): string {
	const recentUser = history
		.filter((m) => m.role === 'user')
		.slice(-2)
		.map((m) => m.content);
	return [...recentUser, newMessage].filter((s) => s && s.trim()).join('\n');
}

/** Configuration constants exposed for tests / docs / settings preview. */
export const HISTORY_POLICY = {
	turnLimit: TURN_LIMIT,
	idleGapMs: IDLE_GAP_MS,
	maxTotalBytes: MAX_TOTAL_BYTES,
	resetCommands: [...RESET_COMMANDS],
} as const;
