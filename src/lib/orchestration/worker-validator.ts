/**
 * Pre-merge worker validator.
 *
 * Runs the post-merge pipeline in validation-only mode (no repair cascade)
 * against a worker's worktree immediately after the worker commits. Lets us
 * catch broken code before it enters the merge phase — much cheaper than
 * debugging post-merge failures where 7 workers' changes are mixed.
 */

import { runPostMergePipeline } from './post-merge-pipeline.js';
import type { WorkerState, WorkerValidation } from './types.js';

export async function validateWorker(
	runId: string,
	worker: WorkerState,
	log: (line: string) => void,
): Promise<WorkerValidation> {
	const started = Date.now();

	const { allPassed, results } = await runPostMergePipeline(
		runId,
		worker.worktreePath,
		(line) => log(`[validate ${worker.taskId}] ${line}`),
		{ skipRepair: true, eventName: 'worker_validation_step' },
	);

	return {
		passed: allPassed,
		ranAt: new Date().toISOString(),
		durationMs: Date.now() - started,
		steps: results,
	};
}
