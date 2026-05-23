/**
 * /api/crm/contacts/[id]/followup — UI-driven follow-up date setter.
 *
 *   POST  { dueAt: number | null }  → setNextFollowup
 *
 * Pass `null` to clear the follow-up. Does NOT insert a heartbeat
 * commitment — that's the orchestrator path (`crm-set-followup` tool), which
 * gates on WhatsApp + reminders being enabled. The UI surface is for
 * operator browsing; if they want a WhatsApp ping, they should use chat.
 *
 * Stage E consumer.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getContact, setNextFollowup } from '$lib/crm/index.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });
	if (!getContact(contactId)) {
		return json({ error: `Contact ${contactId} not found` }, { status: 404 });
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const dueAt = body.dueAt;
	if (dueAt !== null && (typeof dueAt !== 'number' || !Number.isFinite(dueAt))) {
		return json({ error: 'dueAt must be a number (epoch ms) or null' }, { status: 400 });
	}

	const changed = setNextFollowup(contactId, dueAt as number | null);
	return json({ changed, nextFollowupAt: dueAt });
};
