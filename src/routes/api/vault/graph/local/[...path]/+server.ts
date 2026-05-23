import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** Reject path traversal and invalid note paths */
function validateVaultPath(path: string): boolean {
	if (path.includes('..') || path.startsWith('/') || path.includes('\0')) return false;
	if (!path.endsWith('.md')) return false;
	return true;
}

/** GET /api/vault/graph/local/[...path] — Local graph centered on a note */
export const GET: RequestHandler = async ({ params, url }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const path = params.path;
	if (!path || !validateVaultPath(path)) {
		return json({ error: 'Invalid note path' }, { status: 400 });
	}

	const depthParam = parseInt(url.searchParams.get('depth') || '2', 10) || 2;
	const depth = Math.min(Math.max(1, depthParam), 5);

	try {
		const graph = await engine.getLocalGraph(path, depth);
		return json(graph);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
