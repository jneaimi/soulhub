/**
 * /api/crm/contacts/[id]/phones — add / promote / remove phone numbers.
 *
 *   POST   { phone, label?, isPrimary? }  → addContactPhone + syncContactToVault
 *   PATCH  { phone, makePrimary: true }   → setPrimaryPhone + syncContactToVault
 *   DELETE ?phone=+9715XXX                 → removeContactPhone + syncContactToVault
 *
 * Mirrors the emails endpoint exactly, with two differences:
 *
 *   1. Removing the LAST phone is allowed (returns 200). Phones are
 *      non-essential — no inbox-bridge analogue requires at-least-one,
 *      and the operator may genuinely want a phone-less contact archive.
 *      The emails endpoint refuses last-email-deletion with 422.
 *
 *   2. No phone-format validation v1 — we store the string as the
 *      operator typed it. The UI offers `tel:` links, which Safari/Android
 *      handle even for non-E.164 input.
 *
 * Stage F2 consumer. ADR 2026-05-11-crm-local-sqlite-transition §F2.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getContact,
	addContactPhone,
	removeContactPhone,
	setPrimaryPhone,
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

	if (typeof body.phone !== 'string' || body.phone.trim().length === 0) {
		return json({ error: 'phone required (non-empty string)' }, { status: 400 });
	}
	const phone = body.phone.trim();
	const label = typeof body.label === 'string' ? body.label : null;
	const isPrimary = !!body.isPrimary;

	try {
		const row = addContactPhone({ contactId, phone, label, isPrimary });
		const syncResult = await syncContactToVault(contactId);
		return json(
			{ ...row, syncOk: syncResult.ok, syncError: syncResult.error },
			{ status: 201 },
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = (err as { code?: string }).code ?? '';
		if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE constraint failed')) {
			return json({ error: 'phone already attached to a contact', detail: message }, { status: 409 });
		}
		return json({ error: 'addContactPhone failed', detail: message }, { status: 500 });
	}
};

/**
 * Promote an existing phone to primary. Body: `{ phone, makePrimary: true }`.
 * The DB helper demotes the prior primary atomically — exactly-one-primary
 * invariant survives. Returns 404 if the (contactId, phone) pair doesn't
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
	if (typeof body.phone !== 'string' || body.phone.trim().length === 0) {
		return json({ error: 'phone required (non-empty string)' }, { status: 400 });
	}
	if (body.makePrimary !== true) {
		return json({ error: 'only makePrimary:true is supported on PATCH today' }, { status: 400 });
	}

	const ok = setPrimaryPhone(contactId, body.phone);
	if (!ok) return json({ error: 'phone not attached to this contact' }, { status: 404 });

	const syncResult = await syncContactToVault(contactId);
	return json({ promoted: true, phone: body.phone, syncOk: syncResult.ok });
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });
	if (!getContact(contactId)) {
		return json({ error: `Contact ${contactId} not found` }, { status: 404 });
	}

	const phone = url.searchParams.get('phone');
	if (!phone) return json({ error: 'phone query param required' }, { status: 400 });

	const result = removeContactPhone(contactId, phone);
	if (!result.removed) {
		return json({ removed: false, error: 'phone not attached to this contact' }, { status: 404 });
	}

	const syncResult = await syncContactToVault(contactId);
	return json({
		removed: true,
		wasPrimary: result.wasPrimary,
		remaining: result.remaining,
		syncOk: syncResult.ok,
	});
};
