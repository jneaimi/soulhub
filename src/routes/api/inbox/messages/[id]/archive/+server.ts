import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { archiveInboxMessage } from '$lib/inbox/inline-actions.js';

/**
 * POST /api/inbox/messages/[id]/archive
 *
 * Flips the row to `process_status='archived'`, mirroring Telegram's
 * "📁 Archive" button. Idempotent on prior 'archived' state. ADR-044.
 */
export const POST: RequestHandler = async ({ params }) => {
	const messageId = Number(params.id);
	if (!Number.isFinite(messageId) || messageId <= 0) {
		return json({ error: 'invalid message id' }, { status: 400 });
	}

	const result = await archiveInboxMessage(messageId);

	if (!result.ok) {
		const status = result.error === 'not-found' ? 404 : 500;
		return json({ ...result, ok: false, messageId }, { status });
	}

	return json({ ...result, ok: true, messageId });
};
