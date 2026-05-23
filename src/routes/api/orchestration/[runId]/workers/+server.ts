import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun, saveRun, saveWorkerState } from '$lib/orchestration/board.js';
import { emitRunEvent, getOutputTail } from '$lib/orchestration/events.js';

/** POST /api/orchestration/[runId]/workers — intervene, kill */
export const POST: RequestHandler = async ({ params, request }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	const body = await request.json();
	const { action } = body;

	if (action === 'intervene') {
		const { taskId, input } = body;
		if (!taskId || !input) {
			return json({ error: 'Missing taskId or input' }, { status: 400 });
		}

		const worker = run.workers[taskId];
		if (!worker) {
			return json({ error: 'Worker not found' }, { status: 404 });
		}
		if (worker.status !== 'running') {
			return json({ error: `Worker is ${worker.status}, not running` }, { status: 400 });
		}

		// Emit intervention event — conductor will pick this up and write to worker's stdin
		emitRunEvent(params.runId, 'intervention', { taskId, input });
		return json({ ok: true });
	}

	if (action === 'kill') {
		const { taskId } = body;
		if (!taskId) {
			return json({ error: 'Missing taskId' }, { status: 400 });
		}

		const worker = run.workers[taskId];
		if (!worker) {
			return json({ error: 'Worker not found' }, { status: 404 });
		}

		// Mark as killed even if already dead (idempotent)
		if (worker.status === 'running' || worker.status === 'pending') {
			worker.status = 'killed';
			worker.completedAt = new Date().toISOString();
			run.workers[taskId] = worker;
			await saveWorkerState(params.runId, worker);
			await saveRun(run);
			emitRunEvent(params.runId, 'worker_exit', { taskId, exitCode: -1 });
		}

		return json({ ok: true });
	}

	return json({ error: `Unknown action: ${action}` }, { status: 400 });
};

/** GET /api/orchestration/[runId]/workers?taskId={id} — get worker output tail */
export const GET: RequestHandler = async ({ params, url }) => {
	const taskId = url.searchParams.get('taskId');
	if (!taskId) {
		return json({ error: 'Missing taskId query param' }, { status: 400 });
	}

	const lines = getOutputTail(params.runId, taskId);
	return json({ taskId, lines });
};
