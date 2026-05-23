import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getMessage } from '$lib/inbox/index.js';
import { draftPathFor } from '$lib/inbox/inline-actions.js';

/**
 * GET /api/inbox/messages/[id]/draft-status
 *
 * Read-only probe used by EmailDraftCard (Phase B) to initialize its
 * mount state. POST /draft has a side effect (dispatches mailwright if
 * not already drafted) so it's the wrong tool for "tell me whether a
 * draft exists." This GET returns:
 *
 *   { messageId, processStatus, drafted, vaultPath? }
 *
 * Path derivation is via `draftPathFor` — shared with draftInboxReply
 * so reader + writer stay in lockstep.
 */
export const GET: RequestHandler = async ({ params }) => {
	const messageId = Number(params.id);
	if (!Number.isFinite(messageId) || messageId <= 0) {
		return json({ error: 'invalid message id' }, { status: 400 });
	}

	const msg = getMessage(messageId);
	if (!msg) {
		return json({ ok: false, error: 'not-found', messageId }, { status: 404 });
	}

	const drafted = msg.processStatus === 'drafted';
	return json({
		ok: true,
		messageId,
		processStatus: msg.processStatus,
		drafted,
		...(drafted ? { vaultPath: draftPathFor(msg) } : {}),
	});
};
