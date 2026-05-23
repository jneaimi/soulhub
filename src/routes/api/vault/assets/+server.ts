/** POST /api/vault/assets — Slice 0. Upload a binary asset (image, voice,
 *  video, document) into a vault zone. Multipart form-data:
 *
 *    zone:      string (required, e.g. "inbox/assets")
 *    filename:  string (required, e.g. "2026-05-03-voice.ogg")
 *    file:      binary (required, the asset bytes)
 *    agent:     string (optional, for rate-limit + audit)
 *    context:   string (optional, source chat JID / message ID)
 *
 *  Mirrors POST /api/vault/notes — same validation discipline (zone,
 *  filename pattern, rate limit, traversal guard) but for binaries. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

export const POST: RequestHandler = async ({ request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch (err) {
		return json({ error: `Invalid multipart body: ${(err as Error).message}` }, { status: 400 });
	}

	const zone = form.get('zone');
	const filename = form.get('filename');
	const file = form.get('file');
	const agent = form.get('agent');
	const context = form.get('context');

	if (typeof zone !== 'string' || !zone.trim()) {
		return json({ error: 'Missing required field: zone' }, { status: 400 });
	}
	if (typeof filename !== 'string' || !filename.trim()) {
		return json({ error: 'Missing required field: filename' }, { status: 400 });
	}
	if (!(file instanceof File)) {
		return json({ error: 'Missing required field: file (must be a file part)' }, { status: 400 });
	}

	const arrayBuffer = await file.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);

	const result = await engine.writeAsset({
		zone: zone.trim(),
		filename: filename.trim(),
		buffer,
		mimetype: file.type || 'application/octet-stream',
		agent: typeof agent === 'string' && agent.trim() ? agent.trim() : undefined,
		context: typeof context === 'string' && context.trim() ? context.trim() : undefined,
	});

	if (!result.success) {
		// 400 for client-side mistakes (zone, filename, size); 429 for rate
		// limits; 500 only for unexpected I/O failures.
		const status = result.error.startsWith('Rate limit')
			? 429
			: result.error.includes('write failed')
				? 500
				: 400;
		return json({ error: result.error }, { status });
	}

	return json({ ok: true, path: result.path });
};
