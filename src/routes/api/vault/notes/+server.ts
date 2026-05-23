import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import type { SearchQuery } from '$lib/vault/types.js';

/** GET /api/vault/notes — List/search notes */
export const GET: RequestHandler = async ({ url }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const limitParam = parseInt(url.searchParams.get('limit') || '20', 10) || 20;
	const offsetParam = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

	// Parse multi-value params (comma-separated)
	const typeParam = url.searchParams.get('type');
	const types = typeParam ? typeParam.split(',').map(t => t.trim()).filter(Boolean) : [];

	const tagsParam = url.searchParams.get('tags');
	const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

	const query: SearchQuery = {
		q: url.searchParams.get('q') || undefined,
		type: types.length > 1 ? types : types.length === 1 ? types[0] : undefined,
		tags: tags.length > 0 ? tags : undefined,
		zone: url.searchParams.get('zone') || undefined,
		project: url.searchParams.get('project') || undefined,
		limit: Math.min(Math.max(1, limitParam), 100),
		offset: Math.max(0, offsetParam),
	};

	try {
		const results = engine.getNotes(query);
		return json({ results, total: results.length });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** POST /api/vault/notes — Create a new note */
export const POST: RequestHandler = async ({ request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const { zone, filename, meta, content, opts } = body as Record<string, unknown>;

	// Validation
	if (!zone || typeof zone !== 'string') {
		return json({ success: false, error: 'zone is required and must be a string' }, { status: 400 });
	}
	if (/\.\./.test(zone) || zone.startsWith('/') || zone.includes('\0') || !/^[\w\-./]+$/.test(zone)) {
		return json({ success: false, error: 'Invalid zone path' }, { status: 400 });
	}
	if (!filename || typeof filename !== 'string') {
		return json({ success: false, error: 'filename is required and must be a string' }, { status: 400 });
	}
	if (!filename.endsWith('.md')) {
		return json({ success: false, error: 'filename must end with .md' }, { status: 400 });
	}
	if (filename.includes('..') || filename.includes('/')) {
		return json({ success: false, error: 'filename must not contain ".." or "/"' }, { status: 400 });
	}
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
		return json({ success: false, error: 'meta is required and must be an object' }, { status: 400 });
	}
	if (typeof content !== 'string') {
		return json({ success: false, error: 'content is required and must be a string' }, { status: 400 });
	}

	// ADR-005 S0 — optional per-call audit attribution. Shape mirrors
	// UpdateNoteOpts (ADR-003 S4). Server-side tools like proposeAdr
	// pass `{actor: 'proposeAdr', actorContext: '...'}` so the audit log
	// + git commit show the TOOL rather than the note's declared author.
	// Unknown fields ignored; non-string fields filtered.
	let createOpts: { actor?: string; actorContext?: string } | undefined;
	if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
		const o = opts as Record<string, unknown>;
		const actor = typeof o.actor === 'string' ? o.actor : undefined;
		const actorContext = typeof o.actorContext === 'string' ? o.actorContext : undefined;
		if (actor || actorContext) createOpts = { actor, actorContext };
	}

	try {
		const result = await engine.createNote(
			{
				zone: zone as string,
				filename: filename as string,
				meta: meta as Record<string, unknown>,
				content: content as string,
			},
			createOpts,
		);
		// A structured `{success:false}` from createNote is a refused write
		// (validation/governance), not a 201. Map it to 400 so status-code
		// clients see the failure; the body still carries the reason.
		return json(result, { status: result.success ? 201 : 400 });
	} catch (err) {
		return json({ success: false, error: (err as Error).message }, { status: 400 });
	}
};
