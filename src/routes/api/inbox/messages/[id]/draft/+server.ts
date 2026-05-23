import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { draftInboxReply } from '$lib/inbox/inline-actions.js';

/**
 * POST /api/inbox/messages/[id]/draft
 *
 * Dispatches the mailwright agent to compose a reply draft, saves the
 * result as a vault note under `email/drafts/<YYYY-MM>/`, and flips the
 * source row to `process_status='drafted'`. Mirrors Telegram's "↩️ Draft
 * reply" button. Long-running (~30–60s) — the route awaits the full
 * dispatch and returns once the vault file is written. Idempotent on
 * prior 'drafted' state. ADR-044.
 */
export const POST: RequestHandler = async ({ params }) => {
	const messageId = Number(params.id);
	if (!Number.isFinite(messageId) || messageId <= 0) {
		return json({ error: 'invalid message id' }, { status: 400 });
	}

	const result = await draftInboxReply(messageId);

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
