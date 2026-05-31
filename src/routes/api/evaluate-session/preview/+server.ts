/** ADR-008 P2 — GET /api/evaluate-session/preview
 *
 *  Soul Hub route that exposes the post-call pendingPreview state.
 *  Apply to Soul Hub at: src/routes/api/evaluate-session/preview/+server.ts
 *
 *  The face app polls this via its own proxy at
 *  GET /api/evaluate-session/preview?sessionKey=<conversation_id>.
 *
 *  ADR-009 P2 — on an in-memory miss (e.g. soul-hub restarted between the
 *  post-call webhook and this poll), fall back to the durable preview store
 *  and re-warm the in-memory maps so the rest of the live flow (Accept /
 *  Amend / Back-to-draft) works exactly as if no restart had happened. */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pendingPreview, pendingTranscript } from '$lib/evaluate-session/index.js';
import { loadPending } from '$lib/evaluate-session/preview-store.js';

export const GET: RequestHandler = async ({ url }) => {
	const sessionKey = url.searchParams.get('sessionKey');
	if (!sessionKey) {
		return json({ ok: false, error: 'Missing sessionKey' }, { status: 400 });
	}

	let preview = pendingPreview.get(sessionKey) ?? null;

	// Cache miss → durable fallback. Rehydrate both maps so a subsequent
	// accept/amend (which read pendingPreview + pendingTranscript) succeed.
	if (!preview) {
		const record = loadPending(sessionKey);
		if (record) {
			preview = record.brief;
			pendingPreview.set(sessionKey, record.brief);
			pendingTranscript.set(sessionKey, record.transcript);
		}
	}

	return json({ ok: true, preview });
};
