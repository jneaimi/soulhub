import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { saveInboxToVault } from '$lib/inbox/inline-actions.js';

/**
 * POST /api/inbox/messages/[id]/save
 *
 * Saves the inbox message to the vault under `email/<YYYY-MM>/`, mirroring
 * Telegram's "📥 Save to vault" button. Idempotent — if the row is already
 * `process_status='saved'` the handler short-circuits with ok:true and a
 * detail string. Same code path as the Telegram callback, so behavior on
 * dedup, CRM interaction logging, and vault content-similarity collisions
 * is identical across surfaces (ADR-044).
 */
export const POST: RequestHandler = async ({ params }) => {
	const messageId = Number(params.id);
	if (!Number.isFinite(messageId) || messageId <= 0) {
		return json({ error: 'invalid message id' }, { status: 400 });
	}

	const result = await saveInboxToVault(messageId);

	if (!result.ok) {
		const status =
			result.error === 'not-found'
				? 404
				: result.error === 'vault-engine-not-ready'
					? 503
					: 500;
		return json({ ...result, ok: false, messageId }, { status });
	}

	return json({ ...result, ok: true, messageId });
};
