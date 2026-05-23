import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import {
	saveRun,
	listRuns,
} from '$lib/orchestration/board.js';
import type { OrchestrationRun } from '$lib/orchestration/types.js';

/** POST /api/orchestration — create a new orchestration run */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { projectName, projectPath, goal } = body;

	if (!projectName || !projectPath || !goal) {
		return json({ error: 'Missing projectName, projectPath, or goal' }, { status: 400 });
	}

	const runId = `orch-${Date.now()}-${randomUUID().slice(0, 8)}`;

	const run: OrchestrationRun = {
		runId,
		projectName,
		projectPath,
		status: 'planning',
		plan: { goal, tasks: [], createdAt: new Date().toISOString() },
		workers: {},
		createdAt: new Date().toISOString(),
		mergeLog: [],
		failureSummaries: [],
		conflictReports: [],
	};

	await saveRun(run);

	return json({ runId, status: 'planning' }, { status: 201 });
};

/** GET /api/orchestration?project={name} — list runs for a project */
export const GET: RequestHandler = async ({ url }) => {
	const project = url.searchParams.get('project');
	const all = await listRuns(50);

	const runs = project
		? all.filter((r) => r.projectName === project)
		: all;

	return json({ runs });
};
