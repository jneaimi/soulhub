import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { loadProjectTimeline } from '$lib/sessions/joiner.js';

/**
 * GET /api/sessions/timeline
 *   ?project=<absPath>          filter to entries whose cwd is inside this root
 *   ?since=<iso>                default: 7 days ago
 *   ?until=<iso>                default: now
 *   ?limit=<n>                  default: 200, max 1000
 *   ?q=<text>                   case-insensitive substring across label/cwd/ids
 *   ?includeClaudeStandalone=false  drop PTY-only Claude rows (default true)
 */
export const GET: RequestHandler = async ({ url }) => {
	const project = url.searchParams.get('project') ?? undefined;
	const since = url.searchParams.get('since') ?? undefined;
	const until = url.searchParams.get('until') ?? undefined;
	const limitRaw = url.searchParams.get('limit');
	const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
	const q = url.searchParams.get('q') ?? undefined;
	const includeClaudeStandalone = url.searchParams.get('includeClaudeStandalone') !== 'false';

	try {
		const result = await loadProjectTimeline({
			project,
			since,
			until,
			limit,
			q,
			includeClaudeStandalone,
		});
		return json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return json({ error: message }, { status: 500 });
	}
};
