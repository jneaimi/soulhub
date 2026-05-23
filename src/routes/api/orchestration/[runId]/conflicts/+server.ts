import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun } from '$lib/orchestration/board.js';
import { checkActiveConflicts } from '$lib/orchestration/conductor.js';

/** GET /api/orchestration/[runId]/conflicts — return stored conflict reports */
export const GET: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) return json({ error: 'Run not found' }, { status: 404 });
	return json({ conflicts: run.conflictReports || [] });
};

/** POST /api/orchestration/[runId]/conflicts — run conflict check now */
export const POST: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) return json({ error: 'Run not found' }, { status: 404 });
	try {
		const reports = await checkActiveConflicts(params.runId);
		return json({ conflicts: reports });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
