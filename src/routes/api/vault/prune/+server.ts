import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** POST /api/vault/prune — Prune old notes from a zone */
export const POST: RequestHandler = async ({ request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const { zone, maxAgeDays, typeFilter } = body as Record<string, unknown>;

	if (!zone || typeof zone !== 'string') {
		return json({ error: 'zone is required and must be a string' }, { status: 400 });
	}
	if (typeof maxAgeDays !== 'number' || maxAgeDays < 1) {
		return json({ error: 'maxAgeDays is required and must be a positive number' }, { status: 400 });
	}
	if (typeFilter !== undefined && typeof typeFilter !== 'string') {
		return json({ error: 'typeFilter must be a string if provided' }, { status: 400 });
	}

	try {
		const result = await engine.pruneZone(zone, maxAgeDays, typeFilter as string | undefined);
		return json(result);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
