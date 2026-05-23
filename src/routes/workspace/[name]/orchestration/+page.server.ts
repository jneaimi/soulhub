import type { PageServerLoad } from './$types';
import { resolve } from 'node:path';
import { config } from '$lib/config.js';
import { listRuns } from '$lib/orchestration/board.js';

export const load: PageServerLoad = async ({ params }) => {
	const name = params.name;
	const devPath = resolve(config.resolved.devDir, name);

	// Prevent path traversal
	if (!devPath.startsWith(config.resolved.devDir + '/')) {
		return { runs: [], projectName: name, projectPath: '' };
	}

	const allRuns = await listRuns(50);
	const runs = allRuns.filter((r) => r.projectName === name);

	return { runs, projectName: name, projectPath: devPath };
};
