/**
 * GET /api/agents/runs?status=X&subjectPath=Y&agentId=Z&limit=N
 *
 * Recent agent runs across all agents with optional filters.  Powers
 * `soul run list` so operators can inspect dispatch state from the
 * terminal without reaching for `sqlite3 ~/.soul-hub/data/ops/ops.db`
 * (a recurring escape hatch surfaced by the 2026-05-28→29 session).
 *
 * Filters compose with AND; newest-first; limit bounded [1, 500].
 * Read-only; same-origin not required (vault metadata view).
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listRecentRuns } from '$lib/agents/runs.js';

export const GET: RequestHandler = async ({ url }) => {
	const status = url.searchParams.get('status') || undefined;
	const subjectPath = url.searchParams.get('subjectPath') || undefined;
	const agentId = url.searchParams.get('agentId') || undefined;
	const limitRaw = url.searchParams.get('limit');
	const limit = limitRaw ? Number(limitRaw) : undefined;
	if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
		return json({ error: 'limit must be a positive number' }, { status: 400 });
	}

	const runs = listRecentRuns({ status, subjectPath, agentId, limit });
	return json({
		filters: { status, subjectPath, agentId, limit: limit ?? 50 },
		runs,
		count: runs.length,
	});
};
