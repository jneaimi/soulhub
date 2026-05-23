import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** GET /api/vault/templates — Available templates */
export const GET: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	try {
		const templates = engine.getTemplates();
		return json({ templates });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** POST /api/vault/templates — Create or update a template */
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

	const { name, content } = body as Record<string, unknown>;
	if (!name || typeof name !== 'string' || !/^[\w-]+$/.test(name)) {
		return json({ error: 'name is required (alphanumeric + hyphens only)' }, { status: 400 });
	}
	if (!content || typeof content !== 'string') {
		return json({ error: 'content is required and must be a string' }, { status: 400 });
	}

	try {
		const template = await engine.saveTemplate(name, content);
		return json({ template }, { status: 201 });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** DELETE /api/vault/templates — Delete a template */
export const DELETE: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const name = url.searchParams.get('name');
	if (!name) {
		return json({ error: 'name query parameter is required' }, { status: 400 });
	}

	try {
		const deleted = await engine.deleteTemplate(name);
		if (!deleted) {
			return json({ error: `Template "${name}" not found` }, { status: 404 });
		}
		return json({ success: true });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
