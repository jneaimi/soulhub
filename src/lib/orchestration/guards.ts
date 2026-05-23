import type { WorkerState } from './types.js';

export const MAX_ITERATIONS = 8;
export const MAX_WORKERS = 4;

export function checkIterationLimit(state: WorkerState): boolean {
	return state.iterationCount >= (state as WorkerState & { maxIterations?: number }).maxIterations! || state.iterationCount >= MAX_ITERATIONS;
}

export function getReflectionPrompt(taskName: string, iterationCount: number, maxIterations: number): string {
	return [
		'STOP. You have used ' + iterationCount + '/' + maxIterations + ' iterations on task "' + taskName + '".',
		'Assess: are you making progress or looping on the same issue?',
		'If stuck, write a clear summary of what is blocking you to your status file and exit cleanly with /exit.',
		'If making progress, finish the remaining work in ' + (maxIterations - iterationCount) + ' iteration(s).',
	].join('\n');
}

export function validateFileOwnership(
	ownershipMap: Record<string, string>,
	filePath: string,
	taskId: string,
): { allowed: boolean; owner?: string } {
	const normalized = filePath.replace(/\\/g, '/');

	for (const [owned, owner] of Object.entries(ownershipMap)) {
		const normalizedOwned = owned.replace(/\\/g, '/');

		if (normalized === normalizedOwned || normalized.startsWith(normalizedOwned + '/')) {
			if (owner === taskId) return { allowed: true };
			return { allowed: false, owner };
		}
	}

	// Not claimed by anyone — allowed
	return { allowed: true };
}

export function canSpawnWorker(currentWorkerCount: number, maxWorkers?: number): boolean {
	return currentWorkerCount < (maxWorkers ?? MAX_WORKERS);
}
