/**
 * /api/crm/contacts — list / search / create.
 *
 *   GET    ?search=q          → FTS5 search (limit 25 by default)
 *   GET    ?stage=&tagId=     → filtered list with limit/offset pagination
 *   POST                       → addContact + syncContactToVault
 *
 * Search and filter modes are mutually exclusive — the UI either presents
 * results for a query OR a paginated list. When `search` is set, `stage` /
 * `tagId` are ignored. Each contact ships with its emails inline so the
 * sidebar doesn't need an N+1 round-trip.
 *
 * Stage D consumer. ADR §D2 / §D4.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	addContact,
	listContacts,
	countContacts,
	searchContacts,
	listContactEmails,
	listContactPhones,
	syncContactToVault,
	CONTACT_STAGES,
	type ContactStage,
	type NewContactInput,
	type ContactSource,
} from '$lib/crm/index.js';

const ALLOWED_SOURCES = new Set<ContactSource>([
	'Website', 'LinkedIn', 'Twitter', 'Email', 'Referral', 'Speaking',
]);

export const GET: RequestHandler = async ({ url }) => {
	const search = url.searchParams.get('search');
	const stage = url.searchParams.get('stage');
	const tagIdRaw = url.searchParams.get('tagId');
	const limitRaw = url.searchParams.get('limit');
	const offsetRaw = url.searchParams.get('offset');

	const limit = clampInt(limitRaw, 50, 1, 200);
	const offset = clampInt(offsetRaw, 0, 0, 100_000);

	if (stage && !CONTACT_STAGES.includes(stage as ContactStage)) {
		return json({ error: `stage must be one of ${CONTACT_STAGES.join(', ')}` }, { status: 400 });
	}
	const tagId = tagIdRaw === null ? undefined : Number(tagIdRaw);
	if (tagIdRaw !== null && !Number.isFinite(tagId)) {
		return json({ error: 'tagId must be an integer' }, { status: 400 });
	}

	if (search && search.trim().length > 0) {
		// FTS5 grammar can throw on operator chars (`:`, `(`, `*`, etc.). Treat
		// any FTS5 syntax error as "no matches" so the UI doesn't crash on a
		// half-typed query.
		let contacts;
		try {
			contacts = searchContacts(search, limit);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return json({
				mode: 'search', contacts: [], total: 0,
				warning: `Search engine couldn't parse the query: ${message}`,
			});
		}
		const enriched = contacts.map((c) => ({
			...c,
			emails: listContactEmails(c.id),
			phones: listContactPhones(c.id),
		}));
		return json({ mode: 'search', contacts: enriched, total: enriched.length });
	}

	const options = {
		stage: (stage as ContactStage) ?? undefined,
		tagId,
		limit,
		offset,
	};
	const contacts = listContacts(options);
	const total = countContacts({ stage: options.stage, tagId: options.tagId });
	const enriched = contacts.map((c) => ({ ...c, emails: listContactEmails(c.id) }));
	return json({ mode: 'list', contacts: enriched, total, limit, offset });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const displayName = body.displayName;
	if (typeof displayName !== 'string' || displayName.trim().length === 0) {
		return json({ error: 'displayName required (non-empty string)' }, { status: 400 });
	}

	const stage = body.stage;
	if (stage !== undefined && (typeof stage !== 'string' || !CONTACT_STAGES.includes(stage as ContactStage))) {
		return json({ error: `stage must be one of ${CONTACT_STAGES.join(', ')}` }, { status: 400 });
	}
	const source = body.source;
	if (source !== undefined && source !== null && (typeof source !== 'string' || !ALLOWED_SOURCES.has(source as ContactSource))) {
		return json({ error: `source must be one of ${[...ALLOWED_SOURCES].join(', ')} or null` }, { status: 400 });
	}

	const emails = Array.isArray(body.emails) ? body.emails as Array<Record<string, unknown>> : [];
	for (const entry of emails) {
		if (typeof entry.email !== 'string' || entry.email.length === 0) {
			return json({ error: 'every emails[] entry needs an `email` string' }, { status: 400 });
		}
	}
	const phones = Array.isArray(body.phones) ? body.phones as Array<Record<string, unknown>> : [];
	for (const entry of phones) {
		if (typeof entry.phone !== 'string' || entry.phone.length === 0) {
			return json({ error: 'every phones[] entry needs a `phone` string' }, { status: 400 });
		}
	}

	const input: NewContactInput = {
		displayName: displayName.trim(),
		company: stringOrNull(body.company),
		role: stringOrNull(body.role),
		source: (source as ContactSource | null | undefined) ?? null,
		stage: (stage as ContactStage | undefined) ?? undefined,
		dealType: stringOrNull(body.dealType),
		dealValue: typeof body.dealValue === 'number' ? body.dealValue : null,
		dealCurrency: stringOrNull(body.dealCurrency),
		notes: stringOrNull(body.notes),
		vaultNotePath: stringOrNull(body.vaultNotePath),
		emails: emails.map((e) => ({
			email: e.email as string,
			label: typeof e.label === 'string' ? e.label : null,
			isPrimary: !!e.isPrimary,
		})),
		phones: phones.map((p) => ({
			phone: (p.phone as string).trim(),
			label: typeof p.label === 'string' ? p.label : null,
			isPrimary: !!p.isPrimary,
		})),
	};

	try {
		const created = addContact(input);
		const syncResult = await syncContactToVault(created.id);
		return json(
			{ ...created, syncOk: syncResult.ok, syncError: syncResult.error, syncPath: syncResult.path },
			{ status: 201 },
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = (err as { code?: string }).code ?? '';
		if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE constraint failed')) {
			// Disambiguate by which table fired the constraint.
			const isPhone = message.includes('contact_phones');
			const kind = isPhone ? 'phone' : 'email';
			return json(
				{ error: `duplicate ${kind} — already attached to a contact`, detail: message },
				{ status: 409 },
			);
		}
		return json({ error: 'addContact failed', detail: message }, { status: 500 });
	}
};

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
	if (raw === null) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.round(parsed)));
}

function stringOrNull(v: unknown): string | null {
	if (v === undefined || v === null) return null;
	if (typeof v !== 'string') return null;
	const trimmed = v.trim();
	return trimmed.length === 0 ? null : trimmed;
}
