import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** GET /api/vault/orphans — Notes with no incoming or outgoing links */
export const GET: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	try {
		const orphans = await engine.getOrphans();
		return json({ orphans });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
