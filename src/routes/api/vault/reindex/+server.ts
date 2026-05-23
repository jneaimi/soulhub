import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** POST /api/vault/reindex — Force reindex */
export const POST: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	try {
		const stats = await engine.reindex();
		return json({ stats });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
