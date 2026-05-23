/** GET /api/crm/contacts/by-email?email=foo@bar.com
 *
 *  Exact-email lookup. Wraps `findContactByEmail` from the CRM module.
 *  Returns the matched contact (with emails inline) or `null`.
 *
 *  Why not just use the existing `?search=` mode: FTS5 chokes on `@`
 *  ("fts5: syntax error near @"). The L2 email-save flow already uses
 *  `findContactByEmail` server-side; this exposes the same path to the
 *  vault-note CRM card so it can do live state checks instead of
 *  trusting the (possibly stale) frontmatter snapshot.
 *
 *  ADR-044 Phase E.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { findContactByEmail, listContactEmails } from '$lib/crm/index.js';

export const GET: RequestHandler = async ({ url }) => {
	const email = url.searchParams.get('email')?.trim() ?? '';
	if (!email || !email.includes('@')) {
		return json({ error: 'email required (valid address)' }, { status: 400 });
	}

	const match = findContactByEmail(email);
	if (!match) {
		return json({ contact: null });
	}

	const contact = match.contact;
	return json({
		contact: {
			...contact,
			emails: listContactEmails(contact.id),
		},
	});
};
