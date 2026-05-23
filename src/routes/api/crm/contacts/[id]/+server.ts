/**
 * /api/crm/contacts/[id] — composite detail + partial update + delete.
 *
 *   GET    → contact + emails + tags + interactions + stage_history + notes
 *           + recent inbox via the Stage B bridge. One round-trip for the
 *           Stage E detail panel.
 *   PATCH  → updateContact (partial; subset of fields) + syncContactToVault.
 *           Stage / followup / email list have dedicated paths.
 *   DELETE → deleteContact (cascades) + archiveCrmFrontmatter on the vault
 *           note (per ADR §Delete semantics — note kept as operator archive
 *           but stripped of CRM linkage).
 *
 * Stage D consumer. ADR §D4 / §D7 / §"Delete semantics".
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getContact,
	updateContact,
	deleteContact,
	listContactEmails,
	listContactPhones,
	listContactTags,
	listInteractions,
	listStageHistory,
	listContactNotes,
	listMessagesForContact,
	syncContactToVault,
	archiveCrmFrontmatter,
	type ContactSource,
	type UpdateContactFields,
} from '$lib/crm/index.js';

const ALLOWED_SOURCES = new Set<ContactSource>([
	'Website', 'LinkedIn', 'Twitter', 'Email', 'Referral', 'Speaking',
]);

const RECENT_INBOX_LIMIT = 10;
const INTERACTIONS_LIMIT = 25;
const STAGE_HISTORY_LIMIT = 10;
const NOTES_LIMIT = 20;

export const GET: RequestHandler = async ({ params }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });

	const contact = getContact(contactId);
	if (!contact) return json({ error: `Contact ${contactId} not found` }, { status: 404 });

	const emails = listContactEmails(contactId);
	const phones = listContactPhones(contactId);
	const tags = listContactTags(contactId);
	const interactions = listInteractions(contactId, INTERACTIONS_LIMIT);
	const stageHistory = listStageHistory(contactId, STAGE_HISTORY_LIMIT);
	const notes = listContactNotes(contactId, NOTES_LIMIT);

	// Cross-DB inbox slice — top N most-recent messages from any of the
	// contact's emails. Wrapped in try/catch because the inbox DB might be
	// uninitialized on a fresh install where the operator hasn't connected
	// any account yet.
	let recentInbox: ReturnType<typeof listMessagesForContact> = [];
	try {
		recentInbox = listMessagesForContact(contactId, { limit: RECENT_INBOX_LIMIT });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[crm] inbox-bridge skipped for ${contactId}: ${message}`);
	}

	return json({
		contact,
		emails,
		phones,
		tags,
		interactions,
		stageHistory,
		notes,
		recentInbox,
	});
};

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

	const fields: UpdateContactFields = {};
	if (typeof body.displayName === 'string') {
		const trimmed = body.displayName.trim();
		if (trimmed.length === 0) {
			return json({ error: 'displayName cannot be empty' }, { status: 400 });
		}
		fields.displayName = trimmed;
	}
	if ('company' in body) fields.company = nullableString(body.company);
	if ('role' in body) fields.role = nullableString(body.role);
	if ('dealType' in body) fields.dealType = nullableString(body.dealType);
	if ('dealCurrency' in body) fields.dealCurrency = nullableString(body.dealCurrency);
	if ('notes' in body) fields.notes = nullableString(body.notes);
	if ('dealValue' in body) {
		if (body.dealValue === null) fields.dealValue = null;
		else if (typeof body.dealValue === 'number' && Number.isFinite(body.dealValue)) {
			fields.dealValue = body.dealValue;
		} else {
			return json({ error: 'dealValue must be a number or null' }, { status: 400 });
		}
	}
	if ('source' in body) {
		if (body.source === null) fields.source = null;
		else if (typeof body.source === 'string' && ALLOWED_SOURCES.has(body.source as ContactSource)) {
			fields.source = body.source as ContactSource;
		} else {
			return json({ error: `source must be one of ${[...ALLOWED_SOURCES].join(', ')} or null` }, { status: 400 });
		}
	}

	if (Object.keys(fields).length === 0) {
		return json({ error: 'no patchable fields provided' }, { status: 400 });
	}

	const updated = updateContact(contactId, fields);
	if (!updated) return json({ error: 'update failed' }, { status: 500 });

	const syncResult = await syncContactToVault(contactId);
	return json({ contact: updated, syncOk: syncResult.ok, syncError: syncResult.error });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });

	const contact = getContact(contactId);
	if (!contact) return json({ error: `Contact ${contactId} not found` }, { status: 404 });

	const archived = contact.vaultNotePath
		? await archiveCrmFrontmatter(contact.vaultNotePath)
		: { ok: true };

	const removed = deleteContact(contactId);
	return json({
		deleted: removed,
		vaultArchived: archived.ok,
		vaultArchiveError: 'error' in archived ? archived.error : undefined,
	});
};

function nullableString(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v !== 'string') return null;
	const trimmed = v.trim();
	return trimmed.length === 0 ? null : trimmed;
}
