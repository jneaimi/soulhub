import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { listRuns } from '$lib/sessions/dispatch.js';

/** GET /api/runs — list recent Soul Hub run JSONLs (newest first) */
export const GET: RequestHandler = async ({ url }) => {
	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 500);
	const runs = await listRuns();
	return json({ runs: runs.slice(0, limit) });
};
