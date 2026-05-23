import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** GET /api/vault/graph — Full knowledge graph */
export const GET: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const zone = url.searchParams.get('zone') || undefined;
	const project = url.searchParams.get('project') || undefined;

	try {
		const graph = await engine.getGraph({ zone, project });
		return json(graph);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
