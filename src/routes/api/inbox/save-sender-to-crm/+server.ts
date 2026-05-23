/** ADR-044.E — Create a CRM contact from a saved email note + patch
 *  the note's frontmatter so the in-page card flips from "not-in-crm"
 *  to "in-crm" without a reload.
 *
 *  POST /api/inbox/save-sender-to-crm
 *
 *  Body: { notePath: string, displayName: string, email: string,
 *          company?: string, source?: ContactSource, stage?: ContactStage }
 *
 *  Flow:
 *    1. Validate the note exists AND has `crm_sender_status: 'not-in-crm'`.
 *       This is a guard against the card being submitted twice or against
 *       a note that wasn't created by the Save flow.
 *    2. addContact() — server-assigned CRM-YYYY-NNN id.
 *    3. updateNote() — patch frontmatter: flip status to 'in-crm',
 *       add `crm_contact_id`, `crm_contact_stage`, `crm_contact_display_name`,
 *       drop the candidate fields.
 *    4. syncContactToVault() runs in addContact's caller path — separate
 *       concern, handled by /api/crm/contacts.
 *
 *  Errors:
 *    400 — bad input (missing notePath / displayName / email)
 *    404 — note not found
 *    409 — already in CRM (status != 'not-in-crm') OR duplicate email at CRM layer
 *    500 — DB failure / vault write failure
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	addContact,
	syncContactToVault,
	CONTACT_STAGES,
	type ContactStage,
	type ContactSource,
	type NewContactInput,
} from '$lib/crm/index.js';
import { getVaultEngine } from '$lib/vault/index.js';

const ALLOWED_SOURCES = new Set<ContactSource>([
	'Website', 'LinkedIn', 'Twitter', 'Email', 'Referral', 'Speaking',
]);

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const notePath = typeof body.notePath === 'string' ? body.notePath.trim() : '';
	const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
	const email = typeof body.email === 'string' ? body.email.trim() : '';
	const company = typeof body.company === 'string' ? body.company.trim() : '';
	const stage = typeof body.stage === 'string' ? body.stage : 'Lead';
	const source = typeof body.source === 'string' ? body.source : 'Email';

	if (!notePath) return json({ error: 'notePath required' }, { status: 400 });
	if (!displayName) return json({ error: 'displayName required' }, { status: 400 });
	if (!email || !email.includes('@')) return json({ error: 'email required (valid address)' }, { status: 400 });
	if (!CONTACT_STAGES.includes(stage as ContactStage)) {
		return json({ error: `stage must be one of ${CONTACT_STAGES.join(', ')}` }, { status: 400 });
	}
	if (!ALLOWED_SOURCES.has(source as ContactSource)) {
		return json({ error: `source must be one of ${[...ALLOWED_SOURCES].join(', ')}` }, { status: 400 });
	}

	const engine = getVaultEngine();
	if (!engine) return json({ error: 'vault-engine-not-ready' }, { status: 500 });

	const note = engine.getNote(notePath);
	if (!note) return json({ error: 'note not found', notePath }, { status: 404 });

	const currentStatus = note.meta.crm_sender_status;
	if (currentStatus !== 'not-in-crm') {
		return json(
			{
				error: 'note is not in not-in-crm state',
				notePath,
				currentStatus: currentStatus ?? null,
			},
			{ status: 409 },
		);
	}

	const input: NewContactInput = {
		displayName,
		company: company || null,
		source: source as ContactSource,
		stage: stage as ContactStage,
		vaultNotePath: notePath,
		emails: [{ email, label: 'work', isPrimary: true }],
	};

	let created;
	try {
		created = addContact(input);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = (err as { code?: string }).code ?? '';
		if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE constraint failed')) {
			return json(
				{ error: 'duplicate email — already attached to a contact', detail: message },
				{ status: 409 },
			);
		}
		return json({ error: 'addContact failed', detail: message }, { status: 500 });
	}

	// Best-effort vault sync — surfaces the contact as a vault note too.
	// Failures here don't block the response; the contact exists in the
	// SQLite store regardless.
	const syncResult = await syncContactToVault(created.id).catch((err) => ({
		ok: false,
		error: err instanceof Error ? err.message : String(err),
		path: undefined as string | undefined,
	}));

	// Patch the email-save note's frontmatter so the card flips to
	// in-crm without a reload. Drop candidate fields; add contact ref.
	const patchedMeta = {
		...note.meta,
		crm_sender_status: 'in-crm',
		crm_contact_id: created.id,
		crm_contact_stage: created.stage,
		crm_contact_display_name: created.displayName,
		crm_candidate_email: undefined,
		crm_candidate_name: undefined,
		crm_candidate_company: undefined,
	};
	// updateNote merges shallow; explicit `undefined` doesn't delete the
	// key under matter's stringifier. Walk the result and prune undefined.
	const cleaned: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(patchedMeta)) {
		if (v !== undefined) cleaned[k] = v;
	}

	const updateResult = await engine.updateNote(notePath, { meta: cleaned });
	if (!('success' in updateResult) || !updateResult.success) {
		const err = 'error' in updateResult ? updateResult.error : 'unknown';
		// Contact was created but frontmatter patch failed. Surface that
		// the operator can refresh the page to see the updated state.
		return json(
			{
				contactId: created.id,
				stage: created.stage,
				displayName: created.displayName,
				notePatched: false,
				notePatchError: err,
				syncOk: syncResult.ok,
				syncPath: syncResult.path,
			},
			{ status: 200 },
		);
	}

	return json(
		{
			contactId: created.id,
			stage: created.stage,
			displayName: created.displayName,
			notePatched: true,
			syncOk: syncResult.ok,
			syncPath: syncResult.path,
		},
		{ status: 201 },
	);
};
