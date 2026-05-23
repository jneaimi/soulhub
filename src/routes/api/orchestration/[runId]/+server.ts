import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun, archiveRun, saveRun } from '$lib/orchestration/board.js';

/** GET /api/orchestration/[runId] — get current run state */
export const GET: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}
	return json(run);
};

/** PATCH /api/orchestration/[runId] — reopen a cancelled/failed run */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	const body = await request.json();
	if (body.action === 'reopen') {
		if (run.status !== 'cancelled' && run.status !== 'failed') {
			return json({ error: `Cannot reopen run with status: ${run.status}` }, { status: 400 });
		}
		run.status = 'planning';
		run.startedAt = undefined;
		run.completedAt = undefined;
		// Clear worker entries (keep tasks)
		run.workers = {};
		run.mergeLog = [];
		// Clear stale failure/conflict data from previous attempts
		run.failureSummaries = [];
		run.conflictReports = [];
		await saveRun(run);
		return json({ ok: true, run });
	}

	return json({ error: `Unknown action: ${body.action}` }, { status: 400 });
};

/** DELETE /api/orchestration/[runId] — cancel and cleanup */
export const DELETE: RequestHandler = async ({ params, url }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	// If still active, mark as cancelled
	if (run.status !== 'done' && run.status !== 'failed' && run.status !== 'cancelled') {
		run.status = 'cancelled';
		run.completedAt = new Date().toISOString();
		await saveRun(run);

		// Notify any SSE listeners
		const { emitRunEvent } = await import('$lib/orchestration/events.js');
		emitRunEvent(params.runId, 'run_status', { status: 'cancelled' });
	}

	const cleanup = url.searchParams.get('deleteBranches') === 'true';
	if (cleanup) {
		await archiveRun(params.runId);
	}

	return json({ ok: true });
};
