import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listSessions as listStoredSessions, pruneOldSessions } from '$lib/pty/store.js';
import { listSessions as listActiveSessions } from '$lib/pty/manager.js';

/** GET /api/sessions — list all sessions (active + historical) */
export const GET: RequestHandler = async ({ url }) => {
	const limit = Number(url.searchParams.get('limit') || '50');
	const activeIds = new Set(listActiveSessions());
	const sessions = listStoredSessions(limit).map((meta) => ({
		...meta,
		alive: activeIds.has(meta.id),
	}));
	return json({ sessions, count: sessions.length });
};

/** DELETE /api/sessions — prune old sessions */
export const DELETE: RequestHandler = async ({ url }) => {
	const keep = Number(url.searchParams.get('keep') || '100');
	const pruned = pruneOldSessions(keep);
	return json({ pruned });
};
