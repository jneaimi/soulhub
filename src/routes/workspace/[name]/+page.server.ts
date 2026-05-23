import type { PageServerLoad } from './$types';
import { resolve, join } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { config } from '$lib/config.js';
import type { SoulHubConfig } from '$lib/project/schema.js';

async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

async function loadProjectConfig(devPath: string): Promise<SoulHubConfig | null> {
	try {
		const raw = await readFile(join(devPath, '.soul-hub.json'), 'utf-8');
		return JSON.parse(raw) as SoulHubConfig;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ params }) => {
	const name = params.name;
	const devPath = resolve(config.resolved.devDir, name);

	// Prevent path traversal
	if (!devPath.startsWith(config.resolved.devDir + '/')) {
		return { name, devPath: null, cwd: process.env.HOME ?? '/tmp', projectConfig: null };
	}

	const hasDev = await dirExists(devPath);

	const vaultProjectDir = resolve(config.resolved.vaultDir, 'projects', name);
	const hasVaultZone = await dirExists(vaultProjectDir);

	const projectConfig = hasDev ? await loadProjectConfig(devPath) : null;
	const setupComplete = projectConfig?.stack?.framework != null;

	return {
		name,
		devPath: hasDev ? devPath : null,
		cwd: hasDev ? devPath : process.env.HOME ?? '/tmp',
		projectConfig,
		setupComplete,
		hasVaultZone,
		vaultDir: config.resolved.vaultDir,
		vaultProjectName: name,
		soulHubRoot: process.cwd(),
	};
};
