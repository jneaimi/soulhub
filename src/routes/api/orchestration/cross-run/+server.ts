import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listRuns } from '$lib/orchestration/board.js';

/**
 * GET /api/orchestration/cross-run?project={name}&exclude={runId}
 *
 * Brief summary of all runs for `project`, excluding `exclude`.
 * Used by PMs to check ownership overlap before creating tasks.
 */
export const GET: RequestHandler = async ({ url }) => {
	const project = url.searchParams.get('project');
	const exclude = url.searchParams.get('exclude') || '';

	if (!project) {
		return json({ error: 'project query param is required' }, { status: 400 });
	}

	const all = await listRuns(999);
	const filtered = all
		.filter((r) => r.projectName === project && r.runId !== exclude)
		.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

	const runs = filtered.map((r) => ({
		runId: r.runId,
		goal: r.plan.goal,
		status: r.status,
		createdAt: r.createdAt,
		tasks: r.plan.tasks.map((t) => {
			const w = r.workers[t.id];
			return {
				id: t.id,
				name: t.name,
				status: w?.status || 'planned',
				fileOwnership: t.fileOwnership,
				completedAt: w?.completedAt,
				priority: t.priority,
				estimatedComplexity: t.estimatedComplexity,
			};
		}),
	}));

	return json({ runs });
};
