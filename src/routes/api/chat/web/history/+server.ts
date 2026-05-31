/**
 * GET  /api/chat/web/history — Restore transcript for a scope (ADR-017 S1).
 * DELETE /api/chat/web/history — Clear transcript / new-chat reset (ADR-017 S2).
 *
 * Both routes resolve `scopeKind + params → conversationKey` using the same
 * `conversationKeyForScope` helper as POST /api/chat/web so the key is always
 * consistent.
 *
 * Query params (mirrors POST body fields):
 *   scopeKind   — 'project' | 'vault-note' | 'inbox-thread' | 'crm-contact' | 'global'
 *   slug        — project slug               (required when scopeKind='project')
 *   notePath    — vault-relative note path  (required when scopeKind='vault-note')
 *   contactId   — CRM contact ID            (required when scopeKind='crm-contact')
 *
 * GET 200:
 *   `{ messages: { role: 'user'|'assistant', content: string, ts: number }[], conversationKey: string }`
 *
 *   Returns the same sliding window as `loadHistory` (last 16 turns, 4 h
 *   idle, 2 KB cap) — so the visible transcript is always congruent with
 *   the model's actual context.  Only `user` and `assistant` rows are
 *   returned; proactive-source rows are excluded (they appear to the LLM
 *   as assistant turns but were injected by heartbeat/scheduler and would
 *   confuse the visible transcript).
 *
 * DELETE 200:
 *   `{ cleared: number, conversationKey: string }`
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { conversationKeyForScope } from '$lib/chat/conversation-key.js';
import { resetConversation } from '$lib/vault-chat/history.js';
import { getInboxDb } from '$lib/inbox/db.js';

// ── Policy constants — must stay in sync with history.ts ─────────────────────
const TURN_LIMIT   = 16;
const IDLE_GAP_MS  = 4 * 60 * 60 * 1000; // 4 hours
const MAX_TOTAL_BYTES = 2048;

interface HistoryRow {
	role: 'user' | 'assistant';
	content: string;
	ts: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse + validate scope params from URL search params. Returns `null` with an
 *  error message when a required param is missing for the given `scopeKind`. */
function parseScopeParams(
	url: URL,
): { kind: string; params: Record<string, string> } | { error: string; status: number } {
	const kind      = url.searchParams.get('scopeKind') ?? 'global';
	const slug      = url.searchParams.get('slug')      ?? '';
	const notePath  = url.searchParams.get('notePath')  ?? '';
	const contactId = url.searchParams.get('contactId') ?? '';

	if (kind === 'project' && !slug.trim()) {
		return { error: "scopeKind='project' requires a non-empty 'slug' query param", status: 400 };
	}
	if (kind === 'vault-note' && !notePath.trim()) {
		return { error: "scopeKind='vault-note' requires a non-empty 'notePath' query param", status: 400 };
	}
	if (kind === 'crm-contact' && !contactId.trim()) {
		return { error: "scopeKind='crm-contact' requires a non-empty 'contactId' query param", status: 400 };
	}

	const params: Record<string, string> = {};
	if (slug)      params.slug      = slug;
	if (notePath)  params.notePath  = notePath;
	if (contactId) params.contactId = contactId;

	return { kind, params };
}

/** Load recent turns for a key, applying the SAME policy as `loadHistory`
 *  in history.ts but ALSO returning `ts` for client-side relative time. */
function loadHistoryWithTs(conversationKey: string, now = Date.now()): HistoryRow[] {
	if (!conversationKey) return [];
	const cutoff = now - IDLE_GAP_MS;
	const rows = getInboxDb()
		.prepare<[string, number, number]>(
			`SELECT role, content, ts
			 FROM chat_history
			 WHERE conversation_key = ? AND ts >= ?
			 ORDER BY ts DESC
			 LIMIT ?`,
		)
		.all(conversationKey, cutoff, TURN_LIMIT) as HistoryRow[];

	// Replicate the byte-cap from history.ts — drop oldest until under cap.
	let bytes = 0;
	const kept: HistoryRow[] = [];
	for (const row of rows) {
		bytes += row.content.length;
		if (bytes > MAX_TOTAL_BYTES && kept.length > 0) break;
		kept.push(row);
	}

	// Return oldest-first so the client can append directly to the messages array.
	return kept.reverse();
}

// ── GET — restore transcript ──────────────────────────────────────────────────

export const GET: RequestHandler = ({ url }) => {
	const parsed = parseScopeParams(url);
	if ('error' in parsed) {
		return json({ error: parsed.error }, { status: parsed.status });
	}

	const { kind, params } = parsed;
	const conversationKey = conversationKeyForScope(kind, params);

	try {
		const rows = loadHistoryWithTs(conversationKey);
		return json({ messages: rows, conversationKey });
	} catch (err) {
		const msg = (err as Error).message;
		console.error(`[api/chat/web/history GET] ${msg}`);
		return json({ error: 'Failed to load history' }, { status: 500 });
	}
};

// ── DELETE — new-chat reset ───────────────────────────────────────────────────

export const DELETE: RequestHandler = ({ url }) => {
	const parsed = parseScopeParams(url);
	if ('error' in parsed) {
		return json({ error: parsed.error }, { status: parsed.status });
	}

	const { kind, params } = parsed;
	const conversationKey = conversationKeyForScope(kind, params);

	try {
		const cleared = resetConversation(conversationKey);
		return json({ cleared, conversationKey });
	} catch (err) {
		const msg = (err as Error).message;
		console.error(`[api/chat/web/history DELETE] ${msg}`);
		return json({ error: 'Failed to reset conversation' }, { status: 500 });
	}
};
