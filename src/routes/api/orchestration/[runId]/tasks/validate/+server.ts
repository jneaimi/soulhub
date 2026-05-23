import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadRun, listRuns } from '$lib/orchestration/board.js';
import type { TaskNode } from '$lib/orchestration/types.js';

const PLATFORM_FILES = [
	'package.json',
	'package-lock.json',
	'pnpm-lock.yaml',
	'tsconfig.json',
	'vite.config.ts',
	'svelte.config.js',
	'.env',
];

const ENHANCES_RE = /^[\w-]+\/[\w-]+$/;

type CrossRunConflict = {
	file: string;
	ownedBy: {
		runId: string;
		taskId: string;
		taskName: string;
		status: string;
	};
	severity: 'block' | 'warn' | 'info';
};

function detectCycles(tasks: TaskNode[]): string[] {
	const errors: string[] = [];
	const taskMap = new Map(tasks.map((t) => [t.id, t]));
	const visited = new Set<string>();
	const stack = new Set<string>();

	function dfs(id: string, path: string[]): void {
		if (stack.has(id)) {
			const cycle = path.slice(path.indexOf(id)).concat(id);
			errors.push(`Circular dependency: ${cycle.join(' → ')}`);
			return;
		}
		if (visited.has(id)) return;

		stack.add(id);
		path.push(id);
		const task = taskMap.get(id);
		if (task) {
			for (const dep of task.dependsOn) {
				dfs(dep, [...path]);
			}
		}
		stack.delete(id);
		visited.add(id);
	}

	for (const task of tasks) {
		dfs(task.id, []);
	}

	return errors;
}

function filesOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	const aPrefix = a.endsWith('/') ? a : a + '/';
	const bPrefix = b.endsWith('/') ? b : b + '/';
	return a.startsWith(bPrefix) || b.startsWith(aPrefix);
}

/** POST /api/orchestration/[runId]/tasks/validate — validate entire plan */
export const POST: RequestHandler = async ({ params }) => {
	const run = await loadRun(params.runId);
	if (!run) {
		return json({ error: 'Run not found' }, { status: 404 });
	}

	const tasks = run.plan.tasks;
	const errors: string[] = [];
	const warnings: string[] = [];

	// 1. No duplicate task IDs
	const idCounts = new Map<string, number>();
	for (const task of tasks) {
		idCounts.set(task.id, (idCounts.get(task.id) || 0) + 1);
	}
	for (const [id, count] of idCounts) {
		if (count > 1) {
			errors.push(`Duplicate task ID: ${id} (appears ${count} times)`);
		}
	}

	// 2. All dependsOn references exist
	const taskIds = new Set(tasks.map((t) => t.id));
	for (const task of tasks) {
		for (const dep of task.dependsOn) {
			if (!taskIds.has(dep)) {
				errors.push(`Task "${task.id}" depends on unknown task: ${dep}`);
			}
		}
	}

	// 3. No circular dependencies
	errors.push(...detectCycles(tasks));

	// 4. Intra-run file ownership conflicts (warn)
	const fileOwners = new Map<string, string[]>();
	for (const task of tasks) {
		for (const file of task.fileOwnership) {
			const owners = fileOwners.get(file) || [];
			owners.push(task.id);
			fileOwners.set(file, owners);
		}
	}
	for (const [file, owners] of fileOwners) {
		if (owners.length > 1) {
			warnings.push(`File ownership conflict: "${file}" claimed by ${owners.join(', ')}`);
		}
	}

	// 5. Parent/child consistency
	for (const task of tasks) {
		if (task.parentTask && !taskIds.has(task.parentTask)) {
			errors.push(`Task "${task.id}" references unknown parent task: ${task.parentTask}`);
		}
	}

	// 6. All tasks have non-empty prompts
	for (const task of tasks) {
		if (!task.prompt || task.prompt.trim().length === 0) {
			errors.push(`Task "${task.id}" has an empty prompt`);
		}
	}

	// 7. Platform file warnings
	for (const task of tasks) {
		for (const file of task.fileOwnership) {
			const basename = file.split('/').pop() || file;
			if (PLATFORM_FILES.includes(basename)) {
				warnings.push(`Task "${task.name}" claims platform file "${file}" — this is shared infrastructure`);
			}
		}
	}

	// 8. enhances field validation
	const allRuns = await listRuns(999);
	const runById = new Map(allRuns.map((r) => [r.runId, r]));
	for (const task of tasks) {
		if (!task.enhances) continue;
		if (!ENHANCES_RE.test(task.enhances)) {
			errors.push(`Task "${task.id}" has invalid enhances format "${task.enhances}" — expected "runId/taskId"`);
			continue;
		}
		const [refRunId, refTaskId] = task.enhances.split('/');
		const refRun = runById.get(refRunId);
		if (!refRun) {
			warnings.push(`Task "${task.id}" enhances unknown run "${refRunId}"`);
			continue;
		}
		const refTask = refRun.plan.tasks.find((t) => t.id === refTaskId);
		if (!refTask) {
			warnings.push(`Task "${task.id}" enhances unknown task "${refTaskId}" in run ${refRunId.slice(0, 16)}`);
			continue;
		}
		const refWorker = refRun.workers[refTaskId];
		if (!refWorker || refWorker.status !== 'done') {
			warnings.push(`Task "${task.id}" enhances "${refTaskId}" which is not done (status: ${refWorker?.status || 'planned'})`);
		}
	}

	// 9. Cross-run conflict detection
	const crossRunConflicts: CrossRunConflict[] = [];
	const otherRuns = allRuns.filter((r) => r.projectName === run.projectName && r.runId !== run.runId);

	for (const otherRun of otherRuns) {
		for (const otherTask of otherRun.plan.tasks) {
			const otherWorker = otherRun.workers[otherTask.id];
			const otherStatus: string = otherWorker?.status || 'planned';

			for (const myTask of tasks) {
				for (const myFile of myTask.fileOwnership) {
					for (const otherFile of otherTask.fileOwnership) {
						if (!filesOverlap(myFile, otherFile)) continue;

						let severity: 'block' | 'warn' | 'info';
						if (otherStatus === 'running') {
							severity = 'block';
						} else if (otherStatus === 'done' || otherStatus === 'planned' || otherStatus === 'pending') {
							severity = 'warn';
						} else {
							severity = 'info';
						}

						crossRunConflicts.push({
							file: myFile,
							ownedBy: {
								runId: otherRun.runId,
								taskId: otherTask.id,
								taskName: otherTask.name,
								status: otherStatus,
							},
							severity,
						});
					}
				}
			}
		}
	}

	for (const conflict of crossRunConflicts) {
		const msg = `"${conflict.file}" overlaps with "${conflict.ownedBy.taskName}" in run ${conflict.ownedBy.runId.slice(0, 16)} (${conflict.ownedBy.status})`;
		if (conflict.severity === 'block') {
			errors.push(`CONFLICT: ${msg} — active run is editing this file`);
		} else {
			warnings.push(`Overlap: ${msg}`);
		}
	}

	return json({
		valid: errors.length === 0,
		errors,
		warnings,
		crossRunConflicts,
	});
};
