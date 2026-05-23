import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve, dirname } from 'node:path';
import { getVaultEngine } from '$lib/vault/index.js';
import { config } from '$lib/config.js';

const PIPELINES_DIR = resolve(dirname(config.resolved.catalogDir), 'pipelines');

/** GET /api/vault — Vault overview (stats + zones + resolved paths) */
export const GET: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	try {
		const stats = engine.getStats();
		const zones = engine.getZones().map(({ rawGovernance: _, ...z }) => z);
		return json({
			stats,
			zones,
			paths: {
				vaultDir: config.resolved.vaultDir,
				pipelinesDir: PIPELINES_DIR,
			},
		});
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
