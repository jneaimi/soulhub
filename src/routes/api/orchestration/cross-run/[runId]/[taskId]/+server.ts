import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun } from '$lib/orchestration/board.js';

const ID_RE = /^[\w-]+$/;

/**
 * GET /api/orchestration/cross-run/{runId}/{taskId}
 *
 * Full detail of a specific task from another run + worker state if any.
 */
export const GET: RequestHandler = async ({ params }) => {
	if (!ID_RE.test(params.runId) || !ID_RE.test(params.taskId)) {
		return json({ error: 'Invalid runId or taskId' }, { status: 400 });
	}

	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	const task = run.plan.tasks.find((t) => t.id === params.taskId);
	if (!task) {
		return json({ error: 'Task not found' }, { status: 404 });
	}

	const worker = run.workers[task.id];

	return json({
		runId: run.runId,
		projectName: run.projectName,
		runStatus: run.status,
		task,
		worker: worker
			? {
					status: worker.status,
					branch: worker.branch,
					startedAt: worker.startedAt,
					completedAt: worker.completedAt,
					error: worker.error,
					iterationCount: worker.iterationCount,
				}
			: null,
	});
};
