/**
 * GET /api/chat/web/conversations — Cross-scope history picker (ADR-017 S3).
 *
 * Returns one row per distinct `web:` conversation key in `chat_history`,
 * ordered newest-first, with the last turn's snippet + turn count decoded
 * back to `{ scopeKind, scopeParams, label, targetUrl }` for the drawer
 * history picker.
 *
 * Query params:
 *   limit  — max rows to return (default 50, max 100)
 *
 * Response 200:
 * ```json
 * {
 *   "conversations": [
 *     {
 *       "conversationKey": "web:project:soul-hub-chat",
 *       "scopeKind":       "project",
 *       "scopeParams":     { "slug": "soul-hub-chat" },
 *       "label":           "project: soul-hub-chat",
 *       "targetUrl":       "/projects/soul-hub-chat",
 *       "lastTs":          1716912345678,
 *       "lastRole":        "assistant",
 *       "snippet":         "The OAuth flow is failing because…",
 *       "turnCount":       6
 *     },
 *     …
 *   ]
 * }
 * ```
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { parseScopeFromKey } from '$lib/chat/conversation-key.js';
import { getInboxDb } from '$lib/inbox/db.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;
/** Truncate snippet to this many characters. */
const SNIPPET_LEN   = 140;

interface ConversationRow {
	conversationKey: string;
	lastRole:        'user' | 'assistant';
	snippet:         string;
	lastTs:          number;
	turnCount:       number;
}

function loadConversations(limit: number): ConversationRow[] {
	// Use a self-join to pull the most-recent row per key efficiently on SQLite
	// (no window functions needed — just a GROUP BY + inner-join on max ts).
	const rows = getInboxDb()
		.prepare<[number]>(
			`SELECT
			  ch.conversation_key  AS conversationKey,
			  ch.role              AS lastRole,
			  ch.content           AS snippet,
			  ch.ts                AS lastTs,
			  (
			    SELECT COUNT(*)
			    FROM chat_history c2
			    WHERE c2.conversation_key = ch.conversation_key
			  )                    AS turnCount
			 FROM chat_history ch
			 INNER JOIN (
			   SELECT conversation_key, MAX(ts) AS max_ts
			   FROM   chat_history
			   WHERE  conversation_key LIKE 'web:%'
			   GROUP BY conversation_key
			 ) latest
			   ON ch.conversation_key = latest.conversation_key
			  AND ch.ts               = latest.max_ts
			 ORDER BY ch.ts DESC
			 LIMIT ?`,
		)
		.all(limit) as ConversationRow[];

	return rows;
}

export const GET: RequestHandler = ({ url }) => {
	const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
	const limit    = Number.isNaN(rawLimit) ? DEFAULT_LIMIT : Math.min(Math.max(1, rawLimit), MAX_LIMIT);

	try {
		const rows = loadConversations(limit);

		const conversations = rows.map((row) => {
			const scope = parseScopeFromKey(row.conversationKey);
			return {
				conversationKey: row.conversationKey,
				scopeKind:       scope.scopeKind,
				scopeParams:     scope.scopeParams,
				label:           scope.label,
				targetUrl:       scope.targetUrl,
				lastTs:          row.lastTs,
				lastRole:        row.lastRole,
				snippet:         row.snippet.length > SNIPPET_LEN
					? row.snippet.slice(0, SNIPPET_LEN) + '…'
					: row.snippet,
				turnCount:       row.turnCount,
			};
		});

		return json({ conversations });
	} catch (err) {
		const msg = (err as Error).message;
		console.error(`[api/chat/web/conversations GET] ${msg}`);
		return json({ error: 'Failed to load conversations' }, { status: 500 });
	}
};
