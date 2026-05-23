import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** POST /api/vault/move — Move a note between zones.
 *
 *  Body: { path: string, targetZone: string }
 *
 *  Wraps `engine.moveNote`. Preserves the filename; only the parent directory
 *  changes. Refuses on target-already-exists (no silent clobber). Used by the
 *  keeper to auto-fix misplaced notes — bash `mv` is blocked by the ADR-046
 *  Pass-2 hook, so the keeper has no shell-based alternative.
 */
export const POST: RequestHandler = async ({ request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ success: false, error: 'Vault not initialized' }, { status: 503 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const { path, targetZone } = body as Record<string, unknown>;

	if (!path || typeof path !== 'string') {
		return json({ success: false, error: 'path is required and must be a string' }, { status: 400 });
	}
	if (path.includes('..') || path.startsWith('/') || path.includes('\0') || !path.endsWith('.md')) {
		return json({ success: false, error: 'Invalid path' }, { status: 400 });
	}
	if (!targetZone || typeof targetZone !== 'string') {
		return json({ success: false, error: 'targetZone is required and must be a string' }, { status: 400 });
	}
	if (/\.\./.test(targetZone) || targetZone.startsWith('/') || targetZone.includes('\0') || !/^[\w\-./]+$/.test(targetZone)) {
		return json({ success: false, error: 'Invalid targetZone' }, { status: 400 });
	}

	try {
		const result = await engine.moveNote(path, targetZone);
		const status = result.success ? 200 : 400;
		return json(result, { status });
	} catch (err) {
		return json({ success: false, error: (err as Error).message }, { status: 500 });
	}
};
