/**
 * One-way DB → markdown frontmatter sync for CRM contacts.
 * (ADR 2026-05-11-crm-local-sqlite-transition §D3 + impl step 5.)
 *
 * The DB is canonical for structured fields (stage, deal_*, follow-up
 * dates, tags). The vault note is canonical for prose. This module is
 * the one-way bridge: every CRM write that changes a managed field can
 * call `syncContactToVault(contactId)` to push the updated frontmatter
 * into the operator's vault note without touching the prose body.
 *
 * Frontmatter contract (managed keys — these MAY be overwritten):
 *   type, created, tags          ← required by GLOBAL_REQUIRED_FIELDS
 *   crm_id, stage, company       ← always written
 *   emails: [{email, label, primary}]
 *   phones: [{phone, label, primary}]   ← Stage F2; mirrors emails shape
 *   last_synced                  ← ISO timestamp; refreshed every sync
 *
 * Operator-edited frontmatter keys outside this set are preserved by the
 * vault engine's merge semantics (updateNote merges meta over existing).
 * Prose body is preserved by passing `content: undefined` to updateNote
 * (it falls back to `existing.content`).
 *
 * Reverse direction (markdown → DB) is explicitly NOT supported here.
 * Operator edits to frontmatter `tags`, `stage`, etc. are NOT propagated
 * back; the next DB write overwrites them. Documented in ADR §D3.
 */

import {
	getContact,
	listContactEmails,
	listContactNotes,
	listContactPhones,
	listContactTags,
	getCrmDb,
} from './db.js';
import { getVaultEngine } from '../vault/index.js';
import type { Contact, ContactEmail, ContactNote, ContactPhone, Tag } from './types.js';

/** Per ADR §D10.3, cap `related_notes` in the frontmatter at the most-recent
 *  N entries. DB stays authoritative for the full list; the markdown is the
 *  recent slice. A contact with 50+ attachments would otherwise bloat the
 *  frontmatter and slow vault-engine parsing. */
const RELATED_NOTES_FRONTMATTER_CAP = 20;

/** Zone under the vault root that holds CRM contact notes. */
const CRM_CONTACTS_ZONE = 'knowledge/crm/contacts';

export interface SyncContactResult {
	ok: boolean;
	/** Vault-relative path of the synced note. Present on success. */
	path?: string;
	/** What actually happened on disk. */
	action?: 'created' | 'updated';
	/** Populated when `ok === false`. */
	error?: string;
}

/**
 * Sync a CRM contact's managed state into its vault note.
 *
 * If the contact has no `vault_note_path` set, derive one from the
 * display-name slug and either create the note (when the file doesn't
 * exist) or attach to the existing one. Either way, the DB row's
 * `vault_note_path` is updated so subsequent syncs are stable.
 *
 * Returns ok=true even when the contact has nothing to write yet
 * (e.g., the operator deleted the contact between read and sync). All
 * vault engine failures bubble up as `{ ok: false, error }`.
 */
export async function syncContactToVault(contactId: string): Promise<SyncContactResult> {
	const contact = getContact(contactId);
	if (!contact) {
		return { ok: false, error: `Contact ${contactId} not found` };
	}

	const vault = getVaultEngine();
	if (!vault) {
		return { ok: false, error: 'Vault engine not initialized' };
	}

	const emails = listContactEmails(contactId);
	const phones = listContactPhones(contactId);
	const tags = listContactTags(contactId);
	const notes = listContactNotes(contactId, RELATED_NOTES_FRONTMATTER_CAP);
	const targetPath = contact.vaultNotePath ?? defaultContactPath(contact.displayName);

	const managedMeta = buildManagedFrontmatter(contact, emails, phones, tags, notes);
	const existing = vault.getNote(targetPath);

	if (existing) {
		const result = await vault.updateNote(targetPath, { meta: managedMeta });
		if (!result.success) return { ok: false, error: result.error };
		await persistVaultPath(contactId, result.path);
		return { ok: true, path: result.path, action: 'updated' };
	}

	const result = await vault.createNote({
		zone: CRM_CONTACTS_ZONE,
		filename: targetPath.split('/').pop() ?? `${slugifyName(contact.displayName)}.md`,
		meta: managedMeta,
		content: buildScaffoldContent(contact),
	});
	if (!result.success) return { ok: false, error: result.error };
	await persistVaultPath(contactId, result.path);
	return { ok: true, path: result.path, action: 'created' };
}

/** Default vault-relative path for a contact. The slug matches the
 *  vault-save brain convention so paths are stable across rename. */
export function defaultContactPath(displayName: string): string {
	return `${CRM_CONTACTS_ZONE}/${slugifyName(displayName)}.md`;
}

/**
 * Strip CRM-managed frontmatter keys from a vault note while preserving the
 * prose body. Implements the ADR §"Delete semantics" behavior: when a CRM
 * row is deleted, the vault note stays as an operator-archive entry but
 * loses its DB linkage so the keeper agent doesn't flag it as a broken CRM
 * link and the active CRM index can't find it.
 *
 * Removes: `crm_id`, `stage`, `emails`, `related_notes`, `last_synced`,
 * `tags` (per ADR — operator can re-add).
 * Keeps:   `type: contact`, `created`, `company`, `role`, plus any
 *          operator-curated keys outside the managed set.
 * Adds:    `crm_archived_at` (ISO timestamp) for traceability.
 *
 * No-op when the path resolves to nothing (the operator may have already
 * deleted the note manually).
 */
export async function archiveCrmFrontmatter(vaultPath: string): Promise<SyncContactResult> {
	const vault = getVaultEngine();
	if (!vault) return { ok: false, error: 'Vault engine not initialized' };
	const note = vault.getNote(vaultPath);
	if (!note) return { ok: true, path: vaultPath, action: 'updated' };

	const existing = note.meta as Record<string, unknown>;
	const stripped: Record<string, unknown> = {};
	const STRIP_KEYS = new Set(['crm_id', 'stage', 'emails', 'phones', 'related_notes', 'last_synced', 'tags']);
	for (const [k, v] of Object.entries(existing)) {
		if (!STRIP_KEYS.has(k)) stripped[k] = v;
	}
	stripped.crm_archived_at = new Date().toISOString();
	// Vault engine requires `tags` per GLOBAL_REQUIRED_FIELDS — give it an
	// empty array rather than letting the validator reject the write.
	stripped.tags = [];

	const result = await vault.updateNote(vaultPath, { meta: stripped });
	if (!result.success) return { ok: false, error: result.error };
	return { ok: true, path: result.path, action: 'updated' };
}

// ─── internals ─────────────────────────────────────────────────────────────

function buildManagedFrontmatter(
	contact: Contact,
	emails: ContactEmail[],
	phones: ContactPhone[],
	tags: Tag[],
	notes: ContactNote[],
): Record<string, unknown> {
	const now = new Date();
	// IMPORTANT: js-yaml (via gray-matter) throws on `undefined` values. We
	// MUST omit keys we don't want to write rather than setting them to
	// `undefined`. Empty arrays + null are fine.
	const meta: Record<string, unknown> = {
		// GLOBAL_REQUIRED_FIELDS — always present on every vault note.
		type: 'contact',
		created: contact.createdAt
			? new Date(contact.createdAt).toISOString().slice(0, 10)
			: now.toISOString().slice(0, 10),
		tags: tags.map((t) => t.name),
		// CRM-managed keys.
		crm_id: contact.id,
		stage: contact.stage,
		last_synced: now.toISOString(),
	};

	if (contact.company) meta.company = contact.company;
	if (contact.role) meta.role = contact.role;

	meta.emails = emails.map((e) => {
		const entry: Record<string, unknown> = {
			email: e.email,
			primary: e.isPrimary,
		};
		if (e.label) entry.label = e.label;
		return entry;
	});

	// Stage F2 — phones array mirrors the emails shape. Always-write (even
	// empty) so a removed phone clears the key from frontmatter on next sync
	// rather than leaving a stale entry behind. Same reasoning as related_notes.
	meta.phones = phones.map((p) => {
		const entry: Record<string, unknown> = {
			phone: p.phone,
			primary: p.isPrimary,
		};
		if (p.label) entry.label = p.label;
		return entry;
	});

	// D10.3 — `related_notes` array (most-recent N by attached_at DESC).
	// ALWAYS write the key — vault engine merges meta over existing, so
	// omitting it on detach would leave stale entries in the markdown. An
	// empty array is the right "no attachments" representation.
	meta.related_notes = notes.map((n) => {
		const entry: Record<string, unknown> = {
			path: n.vaultPath,
			kind: n.kind,
			attached_at: new Date(n.attachedAt).toISOString(),
		};
		if (n.label) entry.label = n.label;
		if (n.sourceUrl) entry.source_url = n.sourceUrl;
		return entry;
	});

	return meta;
}

function buildScaffoldContent(contact: Contact): string {
	// Minimal body — the Stage F template (impl step 19) will replace this
	// with the canonical layout. Until then, a heading + a context line lets
	// the operator start writing prose immediately.
	const company = contact.company ? ` — ${contact.company}` : '';
	return `# ${contact.displayName}${company}\n\n*Prose notes go here. Stage / emails / tags live in frontmatter and are DB-canonical.*\n`;
}

/** Slug a display name into a kebab-case filename stem. Mirrors
 *  vault-save/index.ts:slugify so paths sort consistently across surfaces. */
function slugifyName(input: string): string {
	const normalized = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	const truncated = normalized.slice(0, 60).replace(/-+$/, '');
	return truncated || 'contact';
}

/** Persist the resolved vault path back to the contact row so subsequent
 *  syncs target the same file. Idempotent — no-op when path is unchanged. */
async function persistVaultPath(contactId: string, vaultPath: string): Promise<void> {
	const db = getCrmDb();
	db.prepare(`
		UPDATE contacts
		SET vault_note_path = ?, updated_at = ?
		WHERE id = ? AND (vault_note_path IS NULL OR vault_note_path != ?)
	`).run(vaultPath, Date.now(), contactId, vaultPath);
}
