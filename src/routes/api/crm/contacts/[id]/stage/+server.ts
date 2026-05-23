/**
 * /api/crm/contacts/[id]/stage — move a contact between pipeline stages.
 *
 *   POST  { stage, reason? }  → updateContactStage (writes stage_history) +
 *                               syncContactToVault (managed frontmatter
 *                               carries `stage`).
 *
 * Idempotent: posting the contact's current stage returns 200 with
 * `changed: false` instead of writing a no-op history row.
 *
 * Stage D consumer. ADR §D2.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getContact,
	updateContactStage,
	syncContactToVault,
	CONTACT_STAGES,
	type ContactStage,
} from '$lib/crm/index.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });
	const contact = getContact(contactId);
	if (!contact) return json({ error: `Contact ${contactId} not found` }, { status: 404 });

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	if (typeof body.stage !== 'string' || !CONTACT_STAGES.includes(body.stage as ContactStage)) {
		return json({ error: `stage must be one of ${CONTACT_STAGES.join(', ')}` }, { status: 400 });
	}
	const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
		? body.reason.trim()
		: null;

	const changed = updateContactStage(contactId, body.stage as ContactStage, reason);
	if (!changed) {
		return json({ changed: false, contact, note: 'stage unchanged' });
	}

	const fresh = getContact(contactId);
	const syncResult = await syncContactToVault(contactId);
	return json({
		changed: true,
		contact: fresh,
		syncOk: syncResult.ok,
		syncError: syncResult.error,
	});
};
