import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	listRoots,
	addRoot,
	removeRoot,
	updateRoot,
	RootValidationError,
	DENIED_PATTERNS,
} from '$lib/explorer-roots.js';

/** Map a RootValidationError code to a stable HTTP status. */
function statusForCode(code: RootValidationError['code']): number {
	switch (code) {
		case 'invalid_path': return 400;
		case 'not_directory': return 400;
		case 'denied': return 403;
		case 'overlap': return 409;
		case 'duplicate': return 409;
	}
}

/** GET — list all configured roots + the deny patterns (for UI hint text). */
export const GET: RequestHandler = async () => {
	return json({
		roots: listRoots(),
		denied: DENIED_PATTERNS,
	});
};

/** POST — add a new root. Body: { name, path, showHidden? } */
export const POST: RequestHandler = async ({ request }) => {
	let body: any;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	try {
		const root = addRoot({
			name: String(body.name || ''),
			path: String(body.path || ''),
			showHidden: body.showHidden === true,
		});
		return json({ root }, { status: 201 });
	} catch (err) {
		if (err instanceof RootValidationError) {
			return json({ error: err.message, code: err.code }, { status: statusForCode(err.code) });
		}
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** PATCH — update a root (rename or toggle showHidden). Body: { id, name?, showHidden? } */
export const PATCH: RequestHandler = async ({ request }) => {
	let body: any;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const id = String(body.id || '');
	if (!id) return json({ error: 'Missing id' }, { status: 400 });

	try {
		const root = updateRoot(id, {
			name: body.name !== undefined ? String(body.name) : undefined,
			showHidden: body.showHidden !== undefined ? body.showHidden === true : undefined,
		});
		if (!root) return json({ error: 'Root not found' }, { status: 404 });
		return json({ root });
	} catch (err) {
		if (err instanceof RootValidationError) {
			return json({ error: err.message, code: err.code }, { status: statusForCode(err.code) });
		}
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** DELETE — remove a root by id. Query: ?id=<id> */
export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'Missing id parameter' }, { status: 400 });
	const removed = removeRoot(id);
	if (!removed) return json({ error: 'Root not found' }, { status: 404 });
	return json({ ok: true });
};
