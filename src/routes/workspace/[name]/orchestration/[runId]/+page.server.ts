import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { loadRun } from '$lib/orchestration/board.js';

export const load: PageServerLoad = async ({ params }) => {
	const run = await loadRun(params.runId);

	if (!run) {
		error(404, 'Orchestration run not found');
	}

	return { run, projectName: params.name, projectPath: run.projectPath };
};
