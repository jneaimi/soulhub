/**
 * GET /api/agents/runs/history?subjectPath=projects/...
 *
 * ADR-020 P1 — per-ADR run history endpoint.  Returns every agent_run row
 * whose `subject_path` matches the query parameter, ordered oldest-first
 * (so the UI can render them as a chronological timeline) + a cumulative
 * cost across all runs.
 *
 * Powers the AdrDrawer's "Run history" strip.  Read-only, same-origin not
 * required (it's a vault metadata view, no side effects).
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAdrRunHistory } from '$lib/agents/runs.js';

export const GET: RequestHandler = async ({ url }) => {
	const subjectPath = (url.searchParams.get('subjectPath') ?? '').trim();
	if (!subjectPath) {
		return json({ error: 'subjectPath query parameter is required' }, { status: 400 });
	}
	// Defensive path-safety: refuse anything that looks like traversal.
	if (subjectPath.includes('..') || subjectPath.startsWith('/')) {
		return json({ error: 'invalid subjectPath' }, { status: 400 });
	}

	const history = getAdrRunHistory(subjectPath);
	return json({
		subjectPath,
		runs: history.runs,
		cumulativeCostUsd: history.cumulativeCostUsd,
		runCount: history.runs.length,
	});
};
