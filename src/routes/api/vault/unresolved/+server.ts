import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** GET /api/vault/unresolved — Links that don't resolve to any note */
export const GET: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	try {
		const unresolved = engine.getUnresolved();
		return json({ unresolved });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
