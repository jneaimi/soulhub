/**
 * GET /api/agents/[id]/runs — paginated run history for one agent.
 *
 * Query params:
 *   - limit: 1..500, default 50
 *   - mode:  'production' | 'test' (omit for all modes)
 */

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { listAgentRuns, getAgentStats } from '$lib/agents/runs.js';
import { getAgent } from '$lib/agents/store.js';
import type { DispatchMode } from '$lib/agents/dispatch/types.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const id = params.id;
	if (!id) throw error(400, 'agent id is required');
	if (!getAgent(id)) throw error(404, `agent '${id}' not found`);

	const limitRaw = url.searchParams.get('limit');
	const limit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 50, 1), 500) : 50;

	const modeRaw = url.searchParams.get('mode');
	const mode: DispatchMode | undefined =
		modeRaw === 'production' || modeRaw === 'test' ? modeRaw : undefined;

	const runs = listAgentRuns(id, { limit, mode });
	const stats = getAgentStats(id);

	return json({ runs, stats, count: runs.length, limit });
};
