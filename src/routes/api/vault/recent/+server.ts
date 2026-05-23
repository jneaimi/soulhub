import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** GET /api/vault/recent — Recently modified notes */
export const GET: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const limitParam = url.searchParams.get('limit');
	const limit = Math.min(Math.max(1, parseInt(limitParam || '10', 10) || 10), 50);

	try {
		const notes = engine.getRecent(limit);
		return json({ notes });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
