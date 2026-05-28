import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listSessions as listStoredSessions, pruneOldSessions } from '$lib/pty/store.js';
import { listSessions as listActiveSessions } from '$lib/pty/manager.js';

/** GET /api/sessions — list all sessions (active + historical) */
export const GET: RequestHandler = async ({ url }) => {
	const limit = Number(url.searchParams.get('limit') || '50');
	const origin = url.searchParams.get('origin');   // e.g. 'chat-drawer'
	const cwd = url.searchParams.get('cwd');          // exact cwd match
	const activeIds = new Set(listActiveSessions());

	// When filtering (drawer session picker), scan a larger pool first so the
	// limit applies AFTER the filter, then dedupe by claudeSessionId keeping the
	// newest (a resumed session reuses its predecessor's Claude id).
	const filtering = Boolean(origin || cwd);
	let metas = listStoredSessions(filtering ? 1000 : limit);
	if (origin) metas = metas.filter((m) => m.origin === origin);
	if (cwd) metas = metas.filter((m) => m.cwd === cwd);

	if (filtering) {
		const seen = new Set<string>();
		metas = metas
			.filter((m) => {
				if (!m.claudeSessionId) return true;
				if (seen.has(m.claudeSessionId)) return false;
				seen.add(m.claudeSessionId);
				return true;
			})
			.slice(0, limit);
	}

	const sessions = metas.map((meta) => ({ ...meta, alive: activeIds.has(meta.id) }));
	return json({ sessions, count: sessions.length });
};

/** DELETE /api/sessions — prune old sessions */
export const DELETE: RequestHandler = async ({ url }) => {
	const keep = Number(url.searchParams.get('keep') || '100');
	const pruned = pruneOldSessions(keep);
	return json({ pruned });
};
