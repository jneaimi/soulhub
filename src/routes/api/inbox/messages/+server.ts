import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listMessages, getMessage, getInboxStats } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/messages — list messages with filtering
 *   ?account=id     — filter by account
 *   ?folder=INBOX   — filter by folder
 *   ?search=query   — FTS5 search
 *   ?status=new     — process_status filter (new | queued | processed | skipped)
 *   ?category=...   — Layer 2 category filter
 *   ?since=ms       — lower bound on date_received (epoch ms)
 *   ?limit=50       — page size
 *   ?offset=0       — pagination offset
 */
export const GET: RequestHandler = async ({ url }) => {
	const accountId = url.searchParams.get('account') || undefined;
	const folder = url.searchParams.get('folder') || undefined;
	const search = url.searchParams.get('search') || undefined;
	const status = url.searchParams.get('status') || undefined;
	const category = url.searchParams.get('category') || undefined;
	const sinceRaw = url.searchParams.get('since');
	const since = sinceRaw ? Number(sinceRaw) : undefined;
	const limit = parseInt(url.searchParams.get('limit') || '50', 10);
	const offset = parseInt(url.searchParams.get('offset') || '0', 10);

	if (limit < 1 || limit > 200) {
		return json({ error: 'limit must be 1-200' }, { status: 400 });
	}
	if (offset < 0) {
		return json({ error: 'offset must be >= 0' }, { status: 400 });
	}
	if (since !== undefined && !Number.isFinite(since)) {
		return json({ error: 'since must be epoch milliseconds' }, { status: 400 });
	}

	const { messages, total } = listMessages({
		accountId, folder, search, status, category, since, limit, offset,
	});
	const stats = getInboxStats();

	return json({ messages, total, stats });
};
