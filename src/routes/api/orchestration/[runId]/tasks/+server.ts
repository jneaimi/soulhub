import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun, saveRun, savePlan, listRuns } from '$lib/orchestration/board.js';
import type { TaskNode, ProviderType, TaskPriority, TaskComplexity } from '$lib/orchestration/types.js';

const ID_RE = /^[a-z0-9-]+$/;
const ENHANCES_RE = /^[\w-]+\/[\w-]+$/;
const VALID_PROVIDERS: ProviderType[] = ['claude-code', 'codex', 'shell'];
const VALID_PRIORITIES: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_COMPLEXITIES: TaskComplexity[] = ['small', 'medium', 'large'];

function filesOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	const aPrefix = a.endsWith('/') ? a : a + '/';
	const bPrefix = b.endsWith('/') ? b : b + '/';
	return a.startsWith(bPrefix) || b.startsWith(aPrefix);
}

function validateTaskBody(
	body: Record<string, unknown>,
	existingIds: Set<string>,
	isCreate: boolean,
): { error: string; field?: string } | null {
	if (isCreate) {
		if (!body.id || typeof body.id !== 'string') {
			return { error: 'id is required and must be a string', field: 'id' };
		}
		if (!ID_RE.test(body.id) || body.id.length > 40) {
			return { error: 'id must match /^[a-z0-9-]+$/ and be at most 40 chars', field: 'id' };
		}
		if (existingIds.has(body.id)) {
			return { error: `Duplicate task ID: ${body.id}`, field: 'id' };
		}
		if (!body.name || typeof body.name !== 'string' || body.name.trim() === '') {
			return { error: 'name is required and must be a non-empty string', field: 'name' };
		}
		if (!body.description || typeof body.description !== 'string' || body.description.trim() === '') {
			return { error: 'description is required and must be a non-empty string', field: 'description' };
		}
		if (!body.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length < 50) {
			return { error: 'prompt is required and must be at least 50 characters', field: 'prompt' };
		}
	} else {
		// Partial update — only validate provided fields
		if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
			return { error: 'name must be a non-empty string', field: 'name' };
		}
		if (body.description !== undefined && (typeof body.description !== 'string' || body.description.trim() === '')) {
			return { error: 'description must be a non-empty string', field: 'description' };
		}
		if (body.prompt !== undefined && (typeof body.prompt !== 'string' || body.prompt.trim().length < 50)) {
			return { error: 'prompt must be at least 50 characters', field: 'prompt' };
		}
	}

	if (body.provider !== undefined) {
		if (!VALID_PROVIDERS.includes(body.provider as ProviderType)) {
			return { error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}`, field: 'provider' };
		}
	}

	if (body.priority !== undefined) {
		if (!VALID_PRIORITIES.includes(body.priority as TaskPriority)) {
			return { error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}`, field: 'priority' };
		}
	}

	if (body.estimatedComplexity !== undefined) {
		if (!VALID_COMPLEXITIES.includes(body.estimatedComplexity as TaskComplexity)) {
			return { error: `estimatedComplexity must be one of: ${VALID_COMPLEXITIES.join(', ')}`, field: 'estimatedComplexity' };
		}
	}

	if (body.dependsOn !== undefined) {
		if (!Array.isArray(body.dependsOn)) {
			return { error: 'dependsOn must be an array of strings', field: 'dependsOn' };
		}
		for (const dep of body.dependsOn) {
			if (typeof dep !== 'string') {
				return { error: 'dependsOn entries must be strings', field: 'dependsOn' };
			}
			if (!existingIds.has(dep)) {
				return { error: `dependsOn references unknown task: ${dep}`, field: 'dependsOn' };
			}
		}
	}

	if (body.parentTask !== undefined && body.parentTask !== null) {
		if (typeof body.parentTask !== 'string') {
			return { error: 'parentTask must be a string', field: 'parentTask' };
		}
		if (!existingIds.has(body.parentTask)) {
			return { error: `parentTask references unknown task: ${body.parentTask}`, field: 'parentTask' };
		}
	}

	if (body.maxIterations !== undefined) {
		if (typeof body.maxIterations !== 'number' || body.maxIterations < 1 || body.maxIterations > 20) {
			return { error: 'maxIterations must be a number between 1 and 20', field: 'maxIterations' };
		}
	}

	if (body.acceptanceCriteria !== undefined && !Array.isArray(body.acceptanceCriteria)) {
		return { error: 'acceptanceCriteria must be an array of strings', field: 'acceptanceCriteria' };
	}

	if (body.risks !== undefined && !Array.isArray(body.risks)) {
		return { error: 'risks must be an array of strings', field: 'risks' };
	}

	if (body.fileOwnership !== undefined && !Array.isArray(body.fileOwnership)) {
		return { error: 'fileOwnership must be an array of strings', field: 'fileOwnership' };
	}

	if (body.enhances !== undefined && body.enhances !== null && body.enhances !== '') {
		if (typeof body.enhances !== 'string' || !ENHANCES_RE.test(body.enhances)) {
			return { error: 'enhances must match format "runId/taskId"', field: 'enhances' };
		}
	}

	return null;
}

/** GET /api/orchestration/[runId]/tasks — list all tasks */
export const GET: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	return json({ tasks: run.plan.tasks });
};

/** POST /api/orchestration/[runId]/tasks — create a task */
export const POST: RequestHandler = async ({ params, request }) => {
	try {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	if (run.status !== 'planning') {
		return json({ error: `Cannot add tasks when status is ${run.status}` }, { status: 400 });
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const existingIds = new Set(run.plan.tasks.map((t) => t.id));

	const validationError = validateTaskBody(body, existingIds, true);
	if (validationError) {
		return json(validationError, { status: 400 });
	}

	const task: TaskNode = {
		id: body.id as string,
		name: body.name as string,
		description: body.description as string,
		prompt: body.prompt as string,
		provider: (body.provider as ProviderType) || 'claude-code',
		dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn as string[] : [],
		parentTask: (body.parentTask as string) || undefined,
		priority: (body.priority as TaskPriority) || 'medium',
		estimatedComplexity: (body.estimatedComplexity as TaskComplexity) || 'medium',
		acceptanceCriteria: Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria as string[] : [],
		risks: Array.isArray(body.risks) ? body.risks as string[] : [],
		fileOwnership: Array.isArray(body.fileOwnership) ? body.fileOwnership as string[] : [],
		maxIterations: (body.maxIterations as number) || 8,
		enhances: typeof body.enhances === 'string' && body.enhances.length > 0
			? body.enhances
			: undefined,
	};

	run.plan.tasks = [...run.plan.tasks, task];
	await saveRun(run);
	await savePlan(run);

	// Cross-run overlap warnings against active sibling runs
	const overlapWarnings: string[] = [];
	try {
		const allRuns = await listRuns(999);
		const otherActiveRuns = allRuns.filter(
			(r) =>
				r.projectName === run.projectName &&
				r.runId !== run.runId &&
				(r.status === 'running' || r.status === 'planning'),
		);

		for (const otherRun of otherActiveRuns) {
			for (const otherTask of otherRun.plan.tasks) {
				for (const myFile of task.fileOwnership) {
					for (const otherFile of otherTask.fileOwnership) {
						if (filesOverlap(myFile, otherFile)) {
							overlapWarnings.push(
								`"${myFile}" overlaps with "${otherTask.name}" in run ${otherRun.runId.slice(0, 16)}`,
							);
						}
					}
				}
			}
		}
	} catch { /* non-fatal — skip warnings on error */ }

	return json({
		ok: true,
		task,
		warnings: overlapWarnings.length > 0 ? overlapWarnings : undefined,
	});
	} catch (err) {
		return json({ error: (err as Error).message || 'Internal error creating task' }, { status: 500 });
	}
};
