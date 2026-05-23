/**
 * /api/crm/contacts/[id]/notes — vault-note attachments per ADR §D10.
 *
 *   GET    → list attachments newest-first
 *   POST   → attach (validates the vault path exists)
 *   DELETE → detach by ?vault_path=...
 *
 * Stage E UI consumer. The orchestrator's `crm-attach-note` tool wraps the
 * same primitives directly (no HTTP), so any change here keeps both
 * surfaces in lockstep.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getContact,
	listContactNotes,
	attachNote,
	detachNote,
	syncContactToVault,
	CONTACT_NOTE_KINDS,
	type ContactNoteKind,
} from '$lib/crm/index.js';
import { getVaultEngine } from '$lib/vault/index.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });

	const contact = getContact(contactId);
	if (!contact) return json({ error: `Contact ${contactId} not found` }, { status: 404 });

	const rawLimit = url.searchParams.get('limit');
	const parsed = rawLimit ? Number(rawLimit) : 50;
	const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.round(parsed))) : 50;

	const notes = listContactNotes(contactId, limit);
	return json({ contactId, notes });
};

export const POST: RequestHandler = async ({ params, request }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });

	const contact = getContact(contactId);
	if (!contact) return json({ error: `Contact ${contactId} not found` }, { status: 404 });

	let body: {
		vaultPath?: unknown;
		kind?: unknown;
		label?: unknown;
		sourceUrl?: unknown;
		sourceMessageId?: unknown;
	};
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	if (typeof body.vaultPath !== 'string' || body.vaultPath.length === 0) {
		return json({ error: 'vaultPath required (string)' }, { status: 400 });
	}
	if (body.kind !== undefined && (typeof body.kind !== 'string' || !CONTACT_NOTE_KINDS.includes(body.kind as ContactNoteKind))) {
		return json(
			{ error: `kind must be one of ${CONTACT_NOTE_KINDS.join(', ')}` },
			{ status: 400 },
		);
	}

	// Vault-existence validation (same guard as the orchestrator tool).
	const vault = getVaultEngine();
	if (!vault) return json({ error: 'vault engine not initialized' }, { status: 503 });
	const note = vault.getNote(body.vaultPath);
	if (!note) {
		return json({ error: `No vault note at ${body.vaultPath}` }, { status: 404 });
	}

	const result = attachNote({
		contactId,
		vaultPath: body.vaultPath,
		kind: body.kind as ContactNoteKind | undefined,
		label: typeof body.label === 'string' ? body.label : undefined,
		sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : undefined,
		sourceMessageId: typeof body.sourceMessageId === 'number' ? body.sourceMessageId : undefined,
	});

	const syncResult = await syncContactToVault(contactId);
	return json(
		{ ...result, syncOk: syncResult.ok, syncError: syncResult.error, syncPath: syncResult.path },
		{ status: result.inserted ? 201 : 200 },
	);
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });

	const vaultPath = url.searchParams.get('vault_path');
	if (!vaultPath) return json({ error: 'vault_path query param required' }, { status: 400 });

	const removed = detachNote(contactId, vaultPath);
	if (!removed) {
		return json({ removed: false, error: 'not attached' }, { status: 404 });
	}

	// Refresh frontmatter so `related_notes` reflects the detach.
	const syncResult = await syncContactToVault(contactId);
	return json({ removed: true, syncOk: syncResult.ok });
};
