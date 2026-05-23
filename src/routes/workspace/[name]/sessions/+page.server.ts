import type { PageServerLoad } from './$types';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { config } from '$lib/config.js';

async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const name = params.name;
	const devPath = resolve(config.resolved.devDir, name);

	if (!devPath.startsWith(config.resolved.devDir + '/')) {
		return { name, devPath: null };
	}

	const hasDev = await dirExists(devPath);
	return { name, devPath: hasDev ? devPath : null };
};
