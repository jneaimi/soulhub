import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { renderMarkdown, isRtl } from '$lib/vault/renderer.js';

/** Reject path traversal and invalid note paths */
function validateVaultPath(path: string): boolean {
	if (path.includes('..') || path.startsWith('/') || path.includes('\0')) return false;
	if (!path.endsWith('.md')) return false;
	return true;
}

/** GET /api/vault/notes/[...path] — Read a single note */
export const GET: RequestHandler = async ({ params }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const path = params.path;
	if (!path || !validateVaultPath(path)) {
		return json({ error: 'Invalid note path' }, { status: 400 });
	}

	try {
		const note = await engine.getNote(path);
		if (!note) {
			return json({ error: 'Note not found' }, { status: 404 });
		}

		const noteDir = note.path.substring(0, note.path.lastIndexOf('/')) || '';
		const rendered = await renderMarkdown(note.content, {
			vaultDir: engine.vaultDir,
			noteDir,
			links: note.links,
		});
		const contentIsRtl = isRtl(note.content);
		const titleIsRtl = isRtl(note.title);

		return json({
			path: note.path,
			title: note.title,
			meta: note.meta,
			content: note.content,
			rendered,
			contentIsRtl,
			titleIsRtl,
			links: note.links,
			backlinks: engine.getBacklinks(path).map(n => n.path),
			zone: note.path.split('/')[0] || 'inbox',
			mtime: note.mtime,
			size: note.size,
		});
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** PUT /api/vault/notes/[...path] — Update a note */
export const PUT: RequestHandler = async ({ params, request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const path = params.path;
	if (!path || !validateVaultPath(path)) {
		return json({ error: 'Invalid note path' }, { status: 400 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const { meta, content } = body as Record<string, unknown>;

	if (meta !== undefined && (typeof meta !== 'object' || Array.isArray(meta) || meta === null)) {
		return json({ error: 'meta must be an object' }, { status: 400 });
	}
	if (content !== undefined && typeof content !== 'string') {
		return json({ error: 'content must be a string' }, { status: 400 });
	}

	// Check for edit conflicts
	const ifMtime = request.headers.get('x-note-mtime');
	if (ifMtime) {
		// parseFloat, NOT parseInt: mtime is fileStat.mtimeMs — a fractional-
		// millisecond float (e.g. 1779711322350.0142). parseInt(…,10) truncates
		// the fraction, so the value never equals current.mtime and EVERY
		// conditional save 409s spuriously (hit the note editor + recipe skill).
		const clientMtime = parseFloat(ifMtime);
		const current = await engine.getNote(path);
		if (current && !isNaN(clientMtime) && current.mtime !== clientMtime) {
			return json({
				success: false,
				error: 'Note was modified externally. Reload to see the latest version.',
				conflict: true,
				serverMtime: current.mtime,
			}, { status: 409 });
		}
	}

	try {
		const result = await engine.updateNote(path, {
			meta: meta as Record<string, unknown> | undefined,
			content: content as string | undefined,
		});
		// Refused update (governance/validation) returns `{success:false}`;
		// surface it as 400 rather than a misleading 200.
		return json(result, { status: result.success ? 200 : 400 });
	} catch (err) {
		return json({ success: false, error: (err as Error).message }, { status: 400 });
	}
};

/** DELETE /api/vault/notes/[...path] — Archive a note (move to archive/) */
export const DELETE: RequestHandler = async ({ params }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const path = params.path;
	if (!path || !validateVaultPath(path)) {
		return json({ error: 'Invalid note path' }, { status: 400 });
	}

	try {
		const result = await engine.archiveNote(path);
		// Refused archive returns `{success:false}`; map to 400 not 200.
		return json(result, { status: result.success ? 200 : 400 });
	} catch (err) {
		return json({ success: false, error: (err as Error).message }, { status: 400 });
	}
};
