import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun, saveRun, savePlan } from '$lib/orchestration/board.js';
import type { TaskNode, ProviderType, TaskPriority, TaskComplexity } from '$lib/orchestration/types.js';

const VALID_PROVIDERS: ProviderType[] = ['claude-code', 'codex', 'shell'];
const VALID_PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_COMPLEXITIES: TaskComplexity[] = ['small', 'medium', 'large'];
const ENHANCES_RE = /^[\w-]+\/[\w-]+$/;

/** GET /api/orchestration/[runId]/tasks/[taskId] — get single task */
export const GET: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	const task = run.plan.tasks.find((t) => t.id === params.taskId);
	if (!task) {
		return json({ error: 'Task not found' }, { status: 404 });
	}

	return json({ task });
};

/** PUT /api/orchestration/[runId]/tasks/[taskId] — update a task (partial) */
export const PUT: RequestHandler = async ({ params, request }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	if (run.status !== 'planning') {
		return json({ error: `Cannot update tasks when status is ${run.status}` }, { status: 400 });
	}

	const taskIndex = run.plan.tasks.findIndex((t) => t.id === params.taskId);
	if (taskIndex === -1) {
		return json({ error: 'Task not found' }, { status: 404 });
	}

	const body = await request.json();
	const existingIds = new Set(run.plan.tasks.map((t) => t.id));

	// Validate provided fields
	if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
		return json({ error: 'name must be a non-empty string', field: 'name' }, { status: 400 });
	}
	if (body.description !== undefined && (typeof body.description !== 'string' || body.description.trim() === '')) {
		return json({ error: 'description must be a non-empty string', field: 'description' }, { status: 400 });
	}
	if (body.prompt !== undefined && (typeof body.prompt !== 'string' || body.prompt.trim().length < 50)) {
		return json({ error: 'prompt must be at least 50 characters', field: 'prompt' }, { status: 400 });
	}
	if (body.provider !== undefined && !VALID_PROVIDERS.includes(body.provider)) {
		return json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`, field: 'provider' }, { status: 400 });
	}
	if (body.priority !== undefined && !VALID_PRIORITIES.includes(body.priority)) {
		return json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}`, field: 'priority' }, { status: 400 });
	}
	if (body.estimatedComplexity !== undefined && !VALID_COMPLEXITIES.includes(body.estimatedComplexity)) {
		return json({ error: `estimatedComplexity must be one of: ${VALID_COMPLEXITIES.join(', ')}`, field: 'estimatedComplexity' }, { status: 400 });
	}
	if (body.dependsOn !== undefined) {
		if (!Array.isArray(body.dependsOn)) {
			return json({ error: 'dependsOn must be an array of strings', field: 'dependsOn' }, { status: 400 });
		}
		for (const dep of body.dependsOn) {
			if (typeof dep !== 'string' || !existingIds.has(dep)) {
				return json({ error: `dependsOn references unknown task: ${dep}`, field: 'dependsOn' }, { status: 400 });
			}
			if (dep === params.taskId) {
				return json({ error: 'Task cannot depend on itself', field: 'dependsOn' }, { status: 400 });
			}
		}
	}
	if (body.parentTask !== undefined && body.parentTask !== null) {
		if (typeof body.parentTask !== 'string' || !existingIds.has(body.parentTask)) {
			return json({ error: `parentTask references unknown task: ${body.parentTask}`, field: 'parentTask' }, { status: 400 });
		}
	}
	if (body.maxIterations !== undefined) {
		if (typeof body.maxIterations !== 'number' || body.maxIterations < 1 || body.maxIterations > 20) {
			return json({ error: 'maxIterations must be a number between 1 and 20', field: 'maxIterations' }, { status: 400 });
		}
	}
	if (body.acceptanceCriteria !== undefined && !Array.isArray(body.acceptanceCriteria)) {
		return json({ error: 'acceptanceCriteria must be an array of strings', field: 'acceptanceCriteria' }, { status: 400 });
	}
	if (body.risks !== undefined && !Array.isArray(body.risks)) {
		return json({ error: 'risks must be an array of strings', field: 'risks' }, { status: 400 });
	}
	if (body.fileOwnership !== undefined && !Array.isArray(body.fileOwnership)) {
		return json({ error: 'fileOwnership must be an array of strings', field: 'fileOwnership' }, { status: 400 });
	}
	if (body.enhances !== undefined && body.enhances !== null && body.enhances !== '') {
		if (typeof body.enhances !== 'string' || !ENHANCES_RE.test(body.enhances)) {
			return json({ error: 'enhances must match format "runId/taskId"', field: 'enhances' }, { status: 400 });
		}
	}

	// Merge provided fields into existing task
	const existing = run.plan.tasks[taskIndex];
	const updatableKeys: (keyof TaskNode)[] = [
		'name', 'description', 'prompt', 'provider', 'dependsOn', 'parentTask',
		'priority', 'estimatedComplexity', 'acceptanceCriteria', 'risks',
		'fileOwnership', 'maxIterations', 'enhances',
	];

	for (const key of updatableKeys) {
		if (body[key] !== undefined) {
			// Allow clearing enhances by passing null or empty string
			if (key === 'enhances' && (body[key] === null || body[key] === '')) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(existing as any)[key] = undefined;
			} else {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(existing as any)[key] = body[key];
			}
		}
	}

	await saveRun(run);
	await savePlan(run);

	return json({ ok: true, task: existing });
};

/** DELETE /api/orchestration/[runId]/tasks/[taskId] — remove a task */
export const DELETE: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		// Idempotent — if run doesn't exist, task doesn't exist either
		return json({ ok: true });
	}

	if (run.status !== 'planning') {
		return json({ error: `Cannot delete tasks when status is ${run.status}` }, { status: 400 });
	}

	const taskId = params.taskId;

	// Remove the task itself
	run.plan.tasks = run.plan.tasks.filter((t) => t.id !== taskId);

	// Remove from other tasks' dependsOn arrays
	for (const task of run.plan.tasks) {
		task.dependsOn = task.dependsOn.filter((dep) => dep !== taskId);
		if (task.parentTask === taskId) {
			task.parentTask = undefined;
		}
	}

	await saveRun(run);
	await savePlan(run);

	return json({ ok: true });
};
