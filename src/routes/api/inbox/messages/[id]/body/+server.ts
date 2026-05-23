import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAccount, getMessage, fetchImapBody } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/messages/[id]/body
 *
 * Returns the parsed text + html body of an inbox message. Body is fetched
 * lazily from the upstream IMAP server on every request — not cached. If
 * Layer 2 / Layer 3 hammers this endpoint we'll add a small per-account
 * connection pool or a body_text column; for v1 the cost is acceptable
 * because reads are operator-driven (UI clicks).
 *
 * Outlook returns 501 because messages.uid stores a hash of the Graph
 * string id and the original is lost. Proper Outlook body fetch lands
 * with plan Open #6 (external_id column).
 *
 * Response shape:
 *   200 { text, html, fetchedAt }
 *   400 invalid id
 *   404 message not found
 *   501 outlook not implemented
 *   502 upstream fetch failed (server error message in `error`)
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'Invalid id' }, { status: 400 });
	}

	const message = getMessage(id);
	if (!message) {
		return json({ error: `Message ${id} not found` }, { status: 404 });
	}

	const account = getAccount(message.accountId);
	if (!account) {
		return json({ error: `Account ${message.accountId} not found (orphan message)` }, { status: 500 });
	}

	if (account.provider === 'outlook') {
		return json(
			{
				error:
					'Outlook body fetch is not yet implemented. Tracked in inbox-plan Open #6 — needs an external_id column to round-trip the Graph string id, which the current schema loses via hashing.',
			},
			{ status: 501 },
		);
	}

	try {
		const body = await fetchImapBody(account, message);
		return json(body);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[inbox-body:${account.id}] Failed to fetch body for message ${id}:`, msg);
		return json({ error: `Failed to fetch body: ${msg}` }, { status: 502 });
	}
};
