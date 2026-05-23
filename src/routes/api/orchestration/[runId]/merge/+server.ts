import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun } from '$lib/orchestration/board.js';
import { runSmartMerge } from '$lib/orchestration/merge-agent.js';
import { emitRunEvent } from '$lib/orchestration/events.js';

const inFlight = new Set<string>();

/** POST /api/orchestration/[runId]/merge — AI-assisted merge with conflict resolution */
export const POST: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	if (inFlight.has(params.runId)) {
		return json({ error: 'Merge already in progress' }, { status: 409 });
	}

	const hasCompleted = run.plan.tasks.some((t) => {
		const w = run.workers[t.id];
		return w && w.status === 'done';
	});
	if (!hasCompleted) {
		return json({ error: 'No completed workers to merge' }, { status: 400 });
	}

	inFlight.add(params.runId);
	emitRunEvent(params.runId, 'run_status', { status: 'merging' });

	// Fire-and-forget: merge runs in background, progress via SSE merge_progress events
	runSmartMerge(params.runId)
		.then((result) => {
			const status = result.success ? 'done' : 'failed';
			emitRunEvent(params.runId, 'run_status', { status });
		})
		.catch((err) => {
			console.error(`[orchestration:${params.runId}] merge error:`, err);
			emitRunEvent(params.runId, 'run_status', { status: 'failed' });
		})
		.finally(() => {
			inFlight.delete(params.runId);
		});

	return json({ ok: true, message: 'Merge started — progress via SSE' });
};
