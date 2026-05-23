import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** POST /api/vault/scaffold/:name — Scaffold a project zone */
export const POST: RequestHandler = async ({ params }) => {
	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	const name = params.name;
	if (!name || !/^[\w-]+$/.test(name)) {
		return json({ error: 'Invalid project name' }, { status: 400 });
	}

	try {
		const result = await engine.scaffoldProject(name);
		return json(result);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** GET /api/vault/scaffold/:name — Check if project zone exists */
export const GET: RequestHandler = async ({ params }) => {
	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	const name = params.name;
	const notes = engine.getNotes({ project: name, limit: 1 });
	return json({
		scaffolded: notes.length > 0,
		name
	});
};
