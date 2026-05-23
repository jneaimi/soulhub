/**
 * /api/crm/contacts/[id]/emails — add / promote / remove email addresses.
 *
 *   POST   { email, label?, isPrimary? }  → addContactEmail + syncContactToVault
 *   DELETE ?email=foo@bar                 → removeContactEmail + syncContactToVault
 *
 * Removing the LAST email on a contact is refused with 422 — every contact
 * must keep at least one email or the inbox-bridge can never link inbound
 * messages back to the row. The operator can delete the whole contact via
 * the parent DELETE if they really want a zero-email archive.
 *
 * Primary-email invariant: addContactEmail auto-demotes other rows when
 * `isPrimary: true`. removeContactEmail auto-promotes the oldest remaining
 * row when the deleted row was the primary. Both behaviors live in db.ts.
 *
 * Stage D consumer. ADR §D2.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getContact,
	addContactEmail,
	removeContactEmail,
	setPrimaryEmail,
	syncContactToVault,
} from '$lib/crm/index.js';

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

	if (typeof body.email !== 'string' || body.email.trim().length === 0) {
		return json({ error: 'email required (non-empty string)' }, { status: 400 });
	}
	const email = body.email.trim();
	const label = typeof body.label === 'string' ? body.label : null;
	const isPrimary = !!body.isPrimary;

	try {
		const row = addContactEmail({ contactId, email, label, isPrimary });
		const syncResult = await syncContactToVault(contactId);
		return json(
			{ ...row, syncOk: syncResult.ok, syncError: syncResult.error },
			{ status: 201 },
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = (err as { code?: string }).code ?? '';
		if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE constraint failed')) {
			return json({ error: 'email already attached to a contact', detail: message }, { status: 409 });
		}
		return json({ error: 'addContactEmail failed', detail: message }, { status: 500 });
	}
};

/**
 * Promote an existing email to primary. Body: `{ email, makePrimary: true }`.
 * The DB helper demotes the prior primary atomically — exactly-one-primary
 * invariant survives. Returns 404 if the (contactId, email) pair doesn't
 * exist on this contact.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
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
	if (typeof body.email !== 'string' || body.email.trim().length === 0) {
		return json({ error: 'email required (non-empty string)' }, { status: 400 });
	}
	if (body.makePrimary !== true) {
		return json({ error: 'only makePrimary:true is supported on PATCH today' }, { status: 400 });
	}

	const ok = setPrimaryEmail(contactId, body.email);
	if (!ok) return json({ error: 'email not attached to this contact' }, { status: 404 });

	const syncResult = await syncContactToVault(contactId);
	return json({ promoted: true, email: body.email, syncOk: syncResult.ok });
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });
	if (!getContact(contactId)) {
		return json({ error: `Contact ${contactId} not found` }, { status: 404 });
	}

	const email = url.searchParams.get('email');
	if (!email) return json({ error: 'email query param required' }, { status: 400 });

	const result = removeContactEmail(contactId, email);
	if (!result.removed) {
		return json({ removed: false, error: 'email not attached to this contact' }, { status: 404 });
	}
	if (result.remaining === 0) {
		// We already deleted the row in the transaction — re-add it so the
		// at-least-one invariant survives the user's mistake. Cleaner UX
		// than asking the operator to re-create the contact.
		try {
			addContactEmail({ contactId, email, isPrimary: true });
		} catch {
			// Best-effort rollback; if even this fails, the row is gone and
			// the operator can re-add manually.
		}
		return json(
			{ removed: false, error: 'cannot remove the last email on a contact' },
			{ status: 422 },
		);
	}

	const syncResult = await syncContactToVault(contactId);
	return json({
		removed: true,
		wasPrimary: result.wasPrimary,
		remaining: result.remaining,
		syncOk: syncResult.ok,
	});
};
