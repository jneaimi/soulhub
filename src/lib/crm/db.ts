/**
 * CRM SQLite database — ecosystem-native personal CRM (ADR
 * 2026-05-11-crm-local-sqlite-transition).
 *
 * Schema (migration #1):
 *   contacts          — pipeline spine (one row per person)
 *   contact_emails    — one-to-many email addresses per contact
 *   interactions      — append-only touch log; cross-refs inbox messages.id
 *   stage_history     — append-only stage moves
 *   tags / contact_tags — many-to-many tagging
 *   contacts_fts      — FTS5 virtual table over name / company / role / notes
 *
 * Pattern mirrors src/lib/inbox/db.ts:
 *   - Lazy singleton (`getCrmDb()`)
 *   - WAL + foreign_keys=ON
 *   - Migrations gated by `user_version` pragma
 *
 * No encrypted fields. Contact PII is plain-text — per ADR Privacy posture,
 * full-disk encryption is the protection layer, not application-level
 * field encryption.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { soulHubDataDir } from '../paths.js';
import type {
	AttachNoteInput,
	AttachNoteResult,
	Contact,
	ContactEmail,
	ContactEmailMatch,
	ContactNote,
	ContactNoteKind,
	ContactPhone,
	ContactStage,
	ContactWithEmails,
	Interaction,
	InteractionChannel,
	InteractionDirection,
	NewContactInput,
	StageHistory,
	Tag,
} from './types.js';

let db: Database.Database | null = null;

function getDbPath(): string {
	return resolve(soulHubDataDir(), 'crm.db');
}

export function getCrmDb(): Database.Database {
	if (db) return db;

	db = new Database(getDbPath());

	// Performance + safety pragmas. foreign_keys is OFF by default in
	// SQLite — without it, the ON DELETE CASCADE clauses on contact_emails
	// / interactions / stage_history / contact_tags are silent no-ops.
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('temp_store = MEMORY');
	db.pragma('busy_timeout = 5000');
	db.pragma('wal_autocheckpoint = 1000');
	db.pragma('foreign_keys = ON');

	migrate(db);

	return db;
}

export function closeCrmDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function migrate(db: Database.Database): void {
	// Incremental migrations. A fresh install boots at user_version=0 and runs
	// every block below in sequence (1 → 2 → 3 → …), so new operators get the
	// full schema in one pass. Upgrades only run the unseen blocks. Every
	// statement uses IF NOT EXISTS so re-runs are idempotent.
	const version = db.pragma('user_version', { simple: true }) as number;

	if (version < 1) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS contacts (
				id TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				company TEXT,
				role TEXT,
				source TEXT,
				stage TEXT NOT NULL DEFAULT 'Lead',
				deal_type TEXT,
				deal_value REAL,
				deal_currency TEXT,
				notes TEXT,
				vault_note_path TEXT,
				next_followup_at INTEGER,
				last_interaction_at INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage);
			CREATE INDEX IF NOT EXISTS idx_contacts_followup ON contacts(next_followup_at) WHERE next_followup_at IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_contacts_last_interaction ON contacts(last_interaction_at);

			CREATE TABLE IF NOT EXISTS contact_emails (
				contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
				email TEXT NOT NULL,
				label TEXT,
				is_primary INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(contact_id, email)
			);

			CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_emails_unique ON contact_emails(email);
			CREATE INDEX IF NOT EXISTS idx_contact_emails_primary ON contact_emails(contact_id) WHERE is_primary = 1;

			CREATE TABLE IF NOT EXISTS interactions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
				timestamp INTEGER NOT NULL,
				channel TEXT NOT NULL,
				direction TEXT NOT NULL DEFAULT 'outbound',
				summary TEXT NOT NULL,
				message_id INTEGER,
				created_at INTEGER NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id, timestamp DESC);
			CREATE INDEX IF NOT EXISTS idx_interactions_message ON interactions(message_id) WHERE message_id IS NOT NULL;

			CREATE TABLE IF NOT EXISTS stage_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
				from_stage TEXT NOT NULL,
				to_stage TEXT NOT NULL,
				moved_at INTEGER NOT NULL,
				reason TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_stage_history_contact ON stage_history(contact_id, moved_at DESC);

			CREATE TABLE IF NOT EXISTS tags (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL UNIQUE
			);

			CREATE TABLE IF NOT EXISTS contact_tags (
				contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
				tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
				PRIMARY KEY(contact_id, tag_id)
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
				display_name, company, role, notes,
				content='contacts',
				content_rowid='rowid'
			);

			CREATE TRIGGER IF NOT EXISTS contacts_ai AFTER INSERT ON contacts BEGIN
				INSERT INTO contacts_fts(rowid, display_name, company, role, notes)
				VALUES (new.rowid, new.display_name, new.company, new.role, new.notes);
			END;

			CREATE TRIGGER IF NOT EXISTS contacts_ad AFTER DELETE ON contacts BEGIN
				INSERT INTO contacts_fts(contacts_fts, rowid, display_name, company, role, notes)
				VALUES ('delete', old.rowid, old.display_name, old.company, old.role, old.notes);
			END;

			CREATE TRIGGER IF NOT EXISTS contacts_au AFTER UPDATE ON contacts BEGIN
				INSERT INTO contacts_fts(contacts_fts, rowid, display_name, company, role, notes)
				VALUES ('delete', old.rowid, old.display_name, old.company, old.role, old.notes);
				INSERT INTO contacts_fts(rowid, display_name, company, role, notes)
				VALUES (new.rowid, new.display_name, new.company, new.role, new.notes);
			END;
		`);
		db.pragma(`user_version = 1`);
	}

	if (version < 2) {
		// Per ADR 2026-05-11-crm-local-sqlite-transition §D10.1 — junction
		// table linking contacts to vault notes. Many-to-many: a single
		// transcript can attach to multiple contacts, and one contact can
		// have many attached artifacts. ON DELETE CASCADE keeps the linkage
		// in sync with contact lifecycle; vault notes themselves are NEVER
		// auto-deleted (per Privacy posture / Delete semantics).
		db.exec(`
			CREATE TABLE IF NOT EXISTS contact_notes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
				vault_path TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'other',
				label TEXT,
				source_url TEXT,
				source_message_id INTEGER,
				attached_at INTEGER NOT NULL
			);

			CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_notes_unique ON contact_notes(contact_id, vault_path);
			CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes(contact_id, attached_at DESC);
			CREATE INDEX IF NOT EXISTS idx_contact_notes_path ON contact_notes(vault_path);
			CREATE INDEX IF NOT EXISTS idx_contact_notes_kind ON contact_notes(kind);
			CREATE INDEX IF NOT EXISTS idx_contact_notes_message ON contact_notes(source_message_id) WHERE source_message_id IS NOT NULL;
		`);
		db.pragma(`user_version = 2`);
	}

	if (version < 3) {
		// Phones — mirrors the contact_emails table exactly so the operator's
		// mental model stays "phones work the same way as emails". Global
		// UNIQUE on phone string + FK CASCADE + indexes parallel to emails.
		// Difference from emails: there's no inbox-bridge analogue (yet), so
		// the API allows removing the last phone — phones are non-essential.
		db.exec(`
			CREATE TABLE IF NOT EXISTS contact_phones (
				contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
				phone TEXT NOT NULL,
				label TEXT,
				is_primary INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(contact_id, phone)
			);

			CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_phones_unique ON contact_phones(phone);
			CREATE INDEX IF NOT EXISTS idx_contact_phones_primary ON contact_phones(contact_id) WHERE is_primary = 1;
		`);
		db.pragma(`user_version = 3`);
	}
}

// ─── helpers — contacts ────────────────────────────────────────────────────

/**
 * Generate the next CRM-YYYY-NNN id. Runs inside the caller's transaction
 * because two concurrent inserts would otherwise both see the same
 * COUNT(*) and collide on PRIMARY KEY. The PRIMARY KEY constraint is the
 * actual race protector; this just produces a sensible ID under contention.
 */
function nextContactId(db: Database.Database): string {
	const year = new Date().getFullYear();
	const prefix = `CRM-${year}-`;
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE id LIKE ?`)
		.get(`${prefix}%`) as { n: number };
	const seq = String(row.n + 1).padStart(3, '0');
	return `${prefix}${seq}`;
}

/**
 * Insert a contact + its initial emails atomically. Returns the persisted
 * contact + email rows. ID generation collides only under concurrent
 * inserts within the same year, in which case better-sqlite3 throws on
 * the PRIMARY KEY violation and the caller can retry; for the
 * single-operator usage Soul Hub targets, this is rare enough to leave
 * unhandled.
 */
export function addContact(input: NewContactInput): ContactWithEmails {
	const db = getCrmDb();
	const now = Date.now();
	const stage = input.stage ?? 'Lead';

	const tx = db.transaction((): ContactWithEmails => {
		const id = nextContactId(db);

		db.prepare(`
			INSERT INTO contacts (
				id, display_name, company, role, source, stage,
				deal_type, deal_value, deal_currency, notes, vault_note_path,
				next_followup_at, last_interaction_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
		`).run(
			id,
			input.displayName,
			input.company ?? null,
			input.role ?? null,
			input.source ?? null,
			stage,
			input.dealType ?? null,
			input.dealValue ?? null,
			input.dealCurrency ?? null,
			input.notes ?? null,
			input.vaultNotePath ?? null,
			now,
			now,
		);

		const emails: ContactEmail[] = [];
		const inputEmails = input.emails ?? [];
		const primaryEmailCount = inputEmails.filter((e) => e.isPrimary).length;
		// If caller didn't designate exactly one primary, promote the first.
		const promoteFirstEmail = inputEmails.length > 0 && primaryEmailCount !== 1;

		for (let i = 0; i < inputEmails.length; i++) {
			const e = inputEmails[i];
			const isPrimary = promoteFirstEmail ? i === 0 : !!e.isPrimary;
			db.prepare(`
				INSERT INTO contact_emails (contact_id, email, label, is_primary, created_at)
				VALUES (?, ?, ?, ?, ?)
			`).run(id, e.email, e.label ?? null, isPrimary ? 1 : 0, now);
			emails.push({
				contactId: id,
				email: e.email,
				label: e.label ?? null,
				isPrimary,
				createdAt: now,
			});
		}

		const phones: ContactPhone[] = [];
		const inputPhones = input.phones ?? [];
		const primaryPhoneCount = inputPhones.filter((p) => p.isPrimary).length;
		// Same promote-first rule as emails — caller skips picking a primary,
		// the first phone gets the flag so the "exactly one primary per
		// contact" invariant holds on insert.
		const promoteFirstPhone = inputPhones.length > 0 && primaryPhoneCount !== 1;

		for (let i = 0; i < inputPhones.length; i++) {
			const p = inputPhones[i];
			const isPrimary = promoteFirstPhone ? i === 0 : !!p.isPrimary;
			db.prepare(`
				INSERT INTO contact_phones (contact_id, phone, label, is_primary, created_at)
				VALUES (?, ?, ?, ?, ?)
			`).run(id, p.phone, p.label ?? null, isPrimary ? 1 : 0, now);
			phones.push({
				contactId: id,
				phone: p.phone,
				label: p.label ?? null,
				isPrimary,
				createdAt: now,
			});
		}

		return {
			id,
			displayName: input.displayName,
			company: input.company ?? null,
			role: input.role ?? null,
			source: input.source ?? null,
			stage,
			dealType: input.dealType ?? null,
			dealValue: input.dealValue ?? null,
			dealCurrency: input.dealCurrency ?? null,
			notes: input.notes ?? null,
			vaultNotePath: input.vaultNotePath ?? null,
			nextFollowupAt: null,
			lastInteractionAt: null,
			createdAt: now,
			updatedAt: now,
			emails,
			phones,
		};
	});

	return tx();
}

export function getContact(id: string): Contact | null {
	const db = getCrmDb();
	const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToContact(row) : null;
}

export interface ListContactsOptions {
	stage?: ContactStage;
	tagId?: number;
	limit?: number;
	offset?: number;
}

export function listContacts(options: ListContactsOptions = {}): Contact[] {
	const db = getCrmDb();
	const where: string[] = [];
	const params: unknown[] = [];

	if (options.stage) {
		where.push('c.stage = ?');
		params.push(options.stage);
	}
	if (options.tagId !== undefined) {
		where.push('EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ?)');
		params.push(options.tagId);
	}
	const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
	const limit = options.limit ?? 100;
	const offset = options.offset ?? 0;

	const rows = db
		.prepare(`
			SELECT c.* FROM contacts c
			${whereClause}
			ORDER BY
				CASE WHEN c.next_followup_at IS NULL THEN 1 ELSE 0 END,
				c.next_followup_at ASC,
				c.last_interaction_at DESC
			LIMIT ? OFFSET ?
		`)
		.all(...params, limit, offset) as Record<string, unknown>[];
	return rows.map(rowToContact);
}

/**
 * FTS5 search over display_name / company / role / notes. Returns rows
 * ordered by FTS rank. Pass the raw query string; FTS5 handles tokenization.
 * Empty query returns an empty list (no implicit "match all").
 */
/**
 * Total count for the same filter set as `listContacts`. The UI uses this
 * to render pagination indicators ("12 of 240"). Mirrors listContacts'
 * WHERE-clause logic to stay in lockstep.
 */
export function countContacts(options: Omit<ListContactsOptions, 'limit' | 'offset'> = {}): number {
	const db = getCrmDb();
	const where: string[] = [];
	const params: unknown[] = [];
	if (options.stage) {
		where.push('c.stage = ?');
		params.push(options.stage);
	}
	if (options.tagId !== undefined) {
		where.push('EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id = ?)');
		params.push(options.tagId);
	}
	const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
	const row = db
		.prepare(`SELECT COUNT(*) AS total FROM contacts c ${whereClause}`)
		.get(...params) as { total: number };
	return row.total;
}

export function searchContacts(query: string, limit = 25): Contact[] {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const db = getCrmDb();
	// FTS5's MATCH operator is strict — escape any single quotes in user input.
	const ftsQuery = trimmed.replace(/'/g, "''");
	const rows = db
		.prepare(`
			SELECT c.* FROM contacts c
			JOIN contacts_fts f ON f.rowid = c.rowid
			WHERE contacts_fts MATCH ?
			ORDER BY rank
			LIMIT ?
		`)
		.all(ftsQuery, limit) as Record<string, unknown>[];
	return rows.map(rowToContact);
}

/**
 * Move a contact between stages, writing the transition into stage_history
 * atomically. Returns false when the contact doesn't exist or the stage
 * is unchanged (no-op).
 */
export function updateContactStage(
	contactId: string,
	toStage: ContactStage,
	reason?: string | null,
): boolean {
	const db = getCrmDb();
	const tx = db.transaction((): boolean => {
		const current = db
			.prepare('SELECT stage FROM contacts WHERE id = ?')
			.get(contactId) as { stage: ContactStage } | undefined;
		if (!current) return false;
		if (current.stage === toStage) return false;
		const now = Date.now();
		db.prepare('UPDATE contacts SET stage = ?, updated_at = ? WHERE id = ?')
			.run(toStage, now, contactId);
		db.prepare(`
			INSERT INTO stage_history (contact_id, from_stage, to_stage, moved_at, reason)
			VALUES (?, ?, ?, ?, ?)
		`).run(contactId, current.stage, toStage, now, reason ?? null);
		return true;
	});
	return tx();
}

export function setNextFollowup(contactId: string, dueAt: number | null): boolean {
	const db = getCrmDb();
	const now = Date.now();
	const result = db
		.prepare('UPDATE contacts SET next_followup_at = ?, updated_at = ? WHERE id = ?')
		.run(dueAt, now, contactId);
	return result.changes > 0;
}

/** Fields PATCH-able on a contact. `stage`, `next_followup_at`, and email
 *  list have dedicated mutation paths (`updateContactStage`, `setNextFollowup`,
 *  `addContactEmail`) — they're intentionally excluded here so callers must
 *  go through those (stage_history side-effects, primary-email invariant). */
export interface UpdateContactFields {
	displayName?: string;
	company?: string | null;
	role?: string | null;
	source?: import('./types.js').ContactSource | null;
	dealType?: string | null;
	dealValue?: number | null;
	dealCurrency?: string | null;
	notes?: string | null;
}

/**
 * Partial UPDATE of a contact row. Only writes provided fields. Returns the
 * fresh contact on success, or null when the id doesn't exist. Pass `null`
 * explicitly to clear an optional field; omitting the key leaves it untouched.
 *
 * Does NOT trigger vault-sync — caller decides (API layer always does, the
 * orchestrator tool path would too if we ever add one).
 */
export function updateContact(contactId: string, fields: UpdateContactFields): Contact | null {
	const keys = Object.keys(fields) as (keyof UpdateContactFields)[];
	if (keys.length === 0) return getContact(contactId);
	const colMap: Record<keyof UpdateContactFields, string> = {
		displayName: 'display_name',
		company: 'company',
		role: 'role',
		source: 'source',
		dealType: 'deal_type',
		dealValue: 'deal_value',
		dealCurrency: 'deal_currency',
		notes: 'notes',
	};
	const setClauses: string[] = [];
	const params: unknown[] = [];
	for (const key of keys) {
		setClauses.push(`${colMap[key]} = ?`);
		params.push(fields[key] ?? null);
	}
	const now = Date.now();
	setClauses.push('updated_at = ?');
	params.push(now);
	params.push(contactId);
	const db = getCrmDb();
	const result = db
		.prepare(`UPDATE contacts SET ${setClauses.join(', ')} WHERE id = ?`)
		.run(...params);
	if (result.changes === 0) return null;
	return getContact(contactId);
}

/**
 * Cascade through contact_emails + interactions + stage_history +
 * contact_tags via the FK ON DELETE CASCADE clauses. Returns true when a
 * row was removed.
 */
export function deleteContact(contactId: string): boolean {
	const db = getCrmDb();
	const result = db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
	return result.changes > 0;
}

// ─── helpers — emails ──────────────────────────────────────────────────────

export interface AddContactEmailInput {
	contactId: string;
	email: string;
	label?: string | null;
	isPrimary?: boolean;
}

/**
 * Add a secondary email to an existing contact. When `isPrimary` is true,
 * demotes any other primary on the same contact first (so the "exactly one
 * primary per contact" invariant holds at the application layer).
 *
 * Throws `SQLITE_CONSTRAINT_UNIQUE` if the email is already attached to
 * any contact (the UNIQUE index on contact_emails.email is global).
 */
export function addContactEmail(input: AddContactEmailInput): ContactEmail {
	const db = getCrmDb();
	const now = Date.now();
	const tx = db.transaction((): ContactEmail => {
		if (input.isPrimary) {
			db.prepare('UPDATE contact_emails SET is_primary = 0 WHERE contact_id = ?')
				.run(input.contactId);
		}
		db.prepare(`
			INSERT INTO contact_emails (contact_id, email, label, is_primary, created_at)
			VALUES (?, ?, ?, ?, ?)
		`).run(
			input.contactId,
			input.email,
			input.label ?? null,
			input.isPrimary ? 1 : 0,
			now,
		);
		return {
			contactId: input.contactId,
			email: input.email,
			label: input.label ?? null,
			isPrimary: !!input.isPrimary,
			createdAt: now,
		};
	});
	return tx();
}

export function setPrimaryEmail(contactId: string, email: string): boolean {
	const db = getCrmDb();
	const tx = db.transaction((): boolean => {
		const row = db
			.prepare('SELECT 1 FROM contact_emails WHERE contact_id = ? AND email = ?')
			.get(contactId, email);
		if (!row) return false;
		db.prepare('UPDATE contact_emails SET is_primary = 0 WHERE contact_id = ?')
			.run(contactId);
		db.prepare('UPDATE contact_emails SET is_primary = 1 WHERE contact_id = ? AND email = ?')
			.run(contactId, email);
		return true;
	});
	return tx();
}

export function listContactEmails(contactId: string): ContactEmail[] {
	const db = getCrmDb();
	const rows = db
		.prepare('SELECT * FROM contact_emails WHERE contact_id = ? ORDER BY is_primary DESC, created_at ASC')
		.all(contactId) as Record<string, unknown>[];
	return rows.map(rowToContactEmail);
}

/** Result of `removeContactEmail`. `remaining` lets the caller decide what
 *  to do when the contact has zero emails left (the API layer refuses; the
 *  helper itself doesn't enforce — see callers). */
export interface RemoveContactEmailResult {
	removed: boolean;
	wasPrimary: boolean;
	remaining: number;
}

/**
 * Remove a single email from a contact. Atomic — if the removed row was the
 * primary email AND another email exists, promotes the oldest remaining row
 * so the "exactly one primary" invariant survives. Returns `removed=false`
 * when the (contact_id, email) pair doesn't exist.
 *
 * The caller is responsible for refusing to remove the last email if the
 * UX requires at-least-one (the API layer does this; the orchestrator path
 * never hits it because no chat tool deletes emails today).
 */
export function removeContactEmail(contactId: string, email: string): RemoveContactEmailResult {
	const db = getCrmDb();
	const tx = db.transaction((): RemoveContactEmailResult => {
		const target = db
			.prepare('SELECT is_primary FROM contact_emails WHERE contact_id = ? AND email = ?')
			.get(contactId, email) as { is_primary: number } | undefined;
		if (!target) return { removed: false, wasPrimary: false, remaining: 0 };
		const wasPrimary = target.is_primary === 1;
		db.prepare('DELETE FROM contact_emails WHERE contact_id = ? AND email = ?').run(contactId, email);
		const remainingRows = db
			.prepare('SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY created_at ASC')
			.all(contactId) as { email: string }[];
		if (wasPrimary && remainingRows.length > 0) {
			db.prepare('UPDATE contact_emails SET is_primary = 1 WHERE contact_id = ? AND email = ?')
				.run(contactId, remainingRows[0].email);
		}
		return { removed: true, wasPrimary, remaining: remainingRows.length };
	});
	return tx();
}

/**
 * Case-insensitive lookup. Returns the contact + the matched email row,
 * or null if no contact has this email. Used by the inbox-bridge in Stage B
 * to drive the CRM-contact badge on inbox rows.
 */
export function findContactByEmail(email: string): ContactEmailMatch | null {
	const db = getCrmDb();
	const row = db
		.prepare(`
			SELECT c.*, ce.email AS matched_email, ce.label AS matched_label,
			       ce.is_primary AS matched_is_primary, ce.created_at AS matched_created_at
			FROM contacts c
			JOIN contact_emails ce ON ce.contact_id = c.id
			WHERE LOWER(ce.email) = LOWER(?)
			LIMIT 1
		`)
		.get(email) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		contact: rowToContact(row),
		matchedEmail: {
			contactId: row.id as string,
			email: row.matched_email as string,
			label: row.matched_label as string | null,
			isPrimary: (row.matched_is_primary as number) === 1,
			createdAt: row.matched_created_at as number,
		},
	};
}

// ─── helpers — phones ──────────────────────────────────────────────────────

export interface AddContactPhoneInput {
	contactId: string;
	phone: string;
	label?: string | null;
	isPrimary?: boolean;
}

/**
 * Add a phone number to an existing contact. Same semantics as
 * `addContactEmail`: when `isPrimary` is true, demotes any other primary
 * on the same contact first so the "exactly one primary per contact"
 * invariant holds at the application layer.
 *
 * Throws `SQLITE_CONSTRAINT_UNIQUE` if the phone is already attached to
 * any contact (the UNIQUE index on contact_phones.phone is global).
 */
export function addContactPhone(input: AddContactPhoneInput): ContactPhone {
	const db = getCrmDb();
	const now = Date.now();
	const tx = db.transaction((): ContactPhone => {
		if (input.isPrimary) {
			db.prepare('UPDATE contact_phones SET is_primary = 0 WHERE contact_id = ?')
				.run(input.contactId);
		}
		db.prepare(`
			INSERT INTO contact_phones (contact_id, phone, label, is_primary, created_at)
			VALUES (?, ?, ?, ?, ?)
		`).run(
			input.contactId,
			input.phone,
			input.label ?? null,
			input.isPrimary ? 1 : 0,
			now,
		);
		return {
			contactId: input.contactId,
			phone: input.phone,
			label: input.label ?? null,
			isPrimary: !!input.isPrimary,
			createdAt: now,
		};
	});
	return tx();
}

export function setPrimaryPhone(contactId: string, phone: string): boolean {
	const db = getCrmDb();
	const tx = db.transaction((): boolean => {
		const row = db
			.prepare('SELECT 1 FROM contact_phones WHERE contact_id = ? AND phone = ?')
			.get(contactId, phone);
		if (!row) return false;
		db.prepare('UPDATE contact_phones SET is_primary = 0 WHERE contact_id = ?')
			.run(contactId);
		db.prepare('UPDATE contact_phones SET is_primary = 1 WHERE contact_id = ? AND phone = ?')
			.run(contactId, phone);
		return true;
	});
	return tx();
}

export function listContactPhones(contactId: string): ContactPhone[] {
	const db = getCrmDb();
	const rows = db
		.prepare('SELECT * FROM contact_phones WHERE contact_id = ? ORDER BY is_primary DESC, created_at ASC')
		.all(contactId) as Record<string, unknown>[];
	return rows.map(rowToContactPhone);
}

/** Unlike `removeContactEmail`, removing the LAST phone is allowed —
 *  phones are non-essential (no inbox-bridge analogue), and the operator
 *  may genuinely want a phone-less contact. If the removed row was the
 *  primary AND another phone remains, the oldest remaining row gets
 *  promoted so the invariant survives. */
export interface RemoveContactPhoneResult {
	removed: boolean;
	wasPrimary: boolean;
	remaining: number;
}

export function removeContactPhone(contactId: string, phone: string): RemoveContactPhoneResult {
	const db = getCrmDb();
	const tx = db.transaction((): RemoveContactPhoneResult => {
		const target = db
			.prepare('SELECT is_primary FROM contact_phones WHERE contact_id = ? AND phone = ?')
			.get(contactId, phone) as { is_primary: number } | undefined;
		if (!target) return { removed: false, wasPrimary: false, remaining: 0 };
		const wasPrimary = target.is_primary === 1;
		db.prepare('DELETE FROM contact_phones WHERE contact_id = ? AND phone = ?').run(contactId, phone);
		const remainingRows = db
			.prepare('SELECT phone FROM contact_phones WHERE contact_id = ? ORDER BY created_at ASC')
			.all(contactId) as { phone: string }[];
		if (wasPrimary && remainingRows.length > 0) {
			db.prepare('UPDATE contact_phones SET is_primary = 1 WHERE contact_id = ? AND phone = ?')
				.run(contactId, remainingRows[0].phone);
		}
		return { removed: true, wasPrimary, remaining: remainingRows.length };
	});
	return tx();
}

/** Reverse lookup — given a phone string, return the contact + matched
 *  phone row. Used by future WhatsApp/SMS sender-to-contact linkage and
 *  by the orchestrator's `crm-find-contact` tool. */
export function findContactByPhone(phone: string): import('./types.js').ContactPhoneMatch | null {
	const db = getCrmDb();
	const row = db
		.prepare(`
			SELECT c.*, cp.phone AS matched_phone, cp.label AS matched_label,
			       cp.is_primary AS matched_is_primary, cp.created_at AS matched_created_at
			FROM contacts c
			JOIN contact_phones cp ON cp.contact_id = c.id
			WHERE cp.phone = ?
			LIMIT 1
		`)
		.get(phone) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		contact: rowToContact(row),
		matchedPhone: {
			contactId: row.id as string,
			phone: row.matched_phone as string,
			label: row.matched_label as string | null,
			isPrimary: (row.matched_is_primary as number) === 1,
			createdAt: row.matched_created_at as number,
		},
	};
}

export interface ListFollowupsOptions {
	/** Include contacts whose follow-up is overdue by up to this many days
	 *  (default: any overdue, including ancient stale rows). */
	overdueWindowDays?: number;
	/** Include contacts with follow-ups due within the next N days
	 *  (default: 3). */
	upcomingWindowDays?: number;
	/** Max rows. Default 50. */
	limit?: number;
}

/**
 * Follow-ups split into overdue + upcoming by `next_followup_at` relative
 * to now. Single SQL query — caller-side bucketing is cheaper than two
 * round-trips. Rows without `next_followup_at` are never returned.
 */
export function listFollowups(opts: ListFollowupsOptions = {}): {
	overdue: Contact[];
	upcoming: Contact[];
} {
	const db = getCrmDb();
	const now = Date.now();
	const upcomingWindowMs = (opts.upcomingWindowDays ?? 3) * 24 * 60 * 60 * 1000;
	const overdueFloor =
		opts.overdueWindowDays !== undefined
			? now - opts.overdueWindowDays * 24 * 60 * 60 * 1000
			: 0;
	const upcomingCeiling = now + upcomingWindowMs;
	const limit = opts.limit ?? 50;

	const rows = db
		.prepare(`
			SELECT * FROM contacts
			WHERE next_followup_at IS NOT NULL
			  AND next_followup_at >= ?
			  AND next_followup_at <= ?
			ORDER BY next_followup_at ASC
			LIMIT ?
		`)
		.all(overdueFloor, upcomingCeiling, limit) as Record<string, unknown>[];

	const overdue: Contact[] = [];
	const upcoming: Contact[] = [];
	for (const row of rows) {
		const contact = rowToContact(row);
		if ((contact.nextFollowupAt ?? 0) <= now) {
			overdue.push(contact);
		} else {
			upcoming.push(contact);
		}
	}
	return { overdue, upcoming };
}

// ─── helpers — interactions ────────────────────────────────────────────────

export interface AddInteractionInput {
	contactId: string;
	timestamp?: number;         // when it happened; defaults to now
	channel: InteractionChannel;
	direction?: InteractionDirection;
	summary: string;
	messageId?: number | null;
}

export function addInteraction(input: AddInteractionInput): Interaction {
	const db = getCrmDb();
	const now = Date.now();
	const ts = input.timestamp ?? now;
	const direction = input.direction ?? 'outbound';

	const tx = db.transaction((): Interaction => {
		const result = db.prepare(`
			INSERT INTO interactions (contact_id, timestamp, channel, direction, summary, message_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.contactId,
			ts,
			input.channel,
			direction,
			input.summary,
			input.messageId ?? null,
			now,
		);
		// Keep contacts.last_interaction_at fresh so list ordering stays meaningful.
		db.prepare(`
			UPDATE contacts
			SET last_interaction_at = MAX(COALESCE(last_interaction_at, 0), ?),
			    updated_at = ?
			WHERE id = ?
		`).run(ts, now, input.contactId);
		return {
			id: Number(result.lastInsertRowid),
			contactId: input.contactId,
			timestamp: ts,
			channel: input.channel,
			direction,
			summary: input.summary,
			messageId: input.messageId ?? null,
			createdAt: now,
		};
	});
	return tx();
}

export function listInteractions(contactId: string, limit = 50): Interaction[] {
	const db = getCrmDb();
	const rows = db
		.prepare(`
			SELECT * FROM interactions
			WHERE contact_id = ?
			ORDER BY timestamp DESC
			LIMIT ?
		`)
		.all(contactId, limit) as Record<string, unknown>[];
	return rows.map(rowToInteraction);
}

// ─── helpers — tags ────────────────────────────────────────────────────────

/**
 * Idempotent tag upsert — returns the tag id whether the tag already
 * existed or was just inserted.
 */
export function addTag(name: string): Tag {
	const db = getCrmDb();
	const normalized = name.trim();
	const tx = db.transaction((): Tag => {
		const existing = db
			.prepare('SELECT id, name FROM tags WHERE name = ?')
			.get(normalized) as Tag | undefined;
		if (existing) return existing;
		const result = db.prepare('INSERT INTO tags (name) VALUES (?)').run(normalized);
		return { id: Number(result.lastInsertRowid), name: normalized };
	});
	return tx();
}

export function tagContact(contactId: string, tagId: number): boolean {
	const db = getCrmDb();
	const result = db
		.prepare('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)')
		.run(contactId, tagId);
	return result.changes > 0;
}

export function listContactTags(contactId: string): Tag[] {
	const db = getCrmDb();
	const rows = db
		.prepare(`
			SELECT t.id, t.name FROM tags t
			JOIN contact_tags ct ON ct.tag_id = t.id
			WHERE ct.contact_id = ?
			ORDER BY t.name ASC
		`)
		.all(contactId) as Tag[];
	return rows;
}

// ─── helpers — stage history ───────────────────────────────────────────────

export function listStageHistory(contactId: string, limit = 25): StageHistory[] {
	const db = getCrmDb();
	const rows = db
		.prepare(`
			SELECT * FROM stage_history
			WHERE contact_id = ?
			ORDER BY moved_at DESC
			LIMIT ?
		`)
		.all(contactId, limit) as Record<string, unknown>[];
	return rows.map(rowToStageHistory);
}

// ─── helpers — contact_notes (D10) ─────────────────────────────────────────

/** List a contact's attached vault notes, newest first. */
export function listContactNotes(contactId: string, limit = 50): ContactNote[] {
	const db = getCrmDb();
	const rows = db
		.prepare(`
			SELECT * FROM contact_notes
			WHERE contact_id = ?
			ORDER BY attached_at DESC
			LIMIT ?
		`)
		.all(contactId, limit) as Record<string, unknown>[];
	return rows.map(rowToContactNote);
}

/**
 * Idempotent attach. Returns `inserted: true` + the new row on first call,
 * `inserted: false` + the existing row on subsequent attempts with the
 * same (contact_id, vault_path) pair. Lets the orchestrator tool report
 * the prior `attached_at` instead of a silent no-op.
 */
export function attachNote(input: AttachNoteInput): AttachNoteResult {
	const db = getCrmDb();
	const now = Date.now();
	const kind = input.kind ?? 'other';

	const tx = db.transaction((): AttachNoteResult => {
		const result = db.prepare(`
			INSERT OR IGNORE INTO contact_notes
				(contact_id, vault_path, kind, label, source_url, source_message_id, attached_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.contactId,
			input.vaultPath,
			kind,
			input.label ?? null,
			input.sourceUrl ?? null,
			input.sourceMessageId ?? null,
			now,
		);

		const row = db.prepare(`
			SELECT * FROM contact_notes
			WHERE contact_id = ? AND vault_path = ?
		`).get(input.contactId, input.vaultPath) as Record<string, unknown>;

		return {
			inserted: result.changes > 0,
			row: rowToContactNote(row),
		};
	});

	return tx();
}

/** Detach a vault note from a contact. Returns true when a row was
 *  removed, false when no such linkage existed. */
export function detachNote(contactId: string, vaultPath: string): boolean {
	const db = getCrmDb();
	const result = db
		.prepare('DELETE FROM contact_notes WHERE contact_id = ? AND vault_path = ?')
		.run(contactId, vaultPath);
	return result.changes > 0;
}

/** Reverse lookup — every contact a given vault note is attached to.
 *  Used by Stage E's "linked contacts" panel on the vault note view + by
 *  future hygiene work (find dangling references). */
export function findContactsByVaultPath(vaultPath: string): Contact[] {
	const db = getCrmDb();
	const rows = db
		.prepare(`
			SELECT c.* FROM contacts c
			JOIN contact_notes cn ON cn.contact_id = c.id
			WHERE cn.vault_path = ?
			ORDER BY cn.attached_at DESC
		`)
		.all(vaultPath) as Record<string, unknown>[];
	return rows.map(rowToContact);
}

// ─── row converters ────────────────────────────────────────────────────────

function rowToContact(row: Record<string, unknown>): Contact {
	return {
		id: row.id as string,
		displayName: row.display_name as string,
		company: (row.company as string | null) ?? null,
		role: (row.role as string | null) ?? null,
		source: (row.source as Contact['source']) ?? null,
		stage: row.stage as ContactStage,
		dealType: (row.deal_type as string | null) ?? null,
		dealValue: (row.deal_value as number | null) ?? null,
		dealCurrency: (row.deal_currency as string | null) ?? null,
		notes: (row.notes as string | null) ?? null,
		vaultNotePath: (row.vault_note_path as string | null) ?? null,
		nextFollowupAt: (row.next_followup_at as number | null) ?? null,
		lastInteractionAt: (row.last_interaction_at as number | null) ?? null,
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number,
	};
}

function rowToContactEmail(row: Record<string, unknown>): ContactEmail {
	return {
		contactId: row.contact_id as string,
		email: row.email as string,
		label: (row.label as string | null) ?? null,
		isPrimary: (row.is_primary as number) === 1,
		createdAt: row.created_at as number,
	};
}

function rowToContactPhone(row: Record<string, unknown>): ContactPhone {
	return {
		contactId: row.contact_id as string,
		phone: row.phone as string,
		label: (row.label as string | null) ?? null,
		isPrimary: (row.is_primary as number) === 1,
		createdAt: row.created_at as number,
	};
}

function rowToInteraction(row: Record<string, unknown>): Interaction {
	return {
		id: row.id as number,
		contactId: row.contact_id as string,
		timestamp: row.timestamp as number,
		channel: row.channel as InteractionChannel,
		direction: row.direction as InteractionDirection,
		summary: row.summary as string,
		messageId: (row.message_id as number | null) ?? null,
		createdAt: row.created_at as number,
	};
}

function rowToStageHistory(row: Record<string, unknown>): StageHistory {
	return {
		id: row.id as number,
		contactId: row.contact_id as string,
		fromStage: row.from_stage as ContactStage,
		toStage: row.to_stage as ContactStage,
		movedAt: row.moved_at as number,
		reason: (row.reason as string | null) ?? null,
	};
}

function rowToContactNote(row: Record<string, unknown>): ContactNote {
	return {
		id: row.id as number,
		contactId: row.contact_id as string,
		vaultPath: row.vault_path as string,
		kind: row.kind as ContactNoteKind,
		label: (row.label as string | null) ?? null,
		sourceUrl: (row.source_url as string | null) ?? null,
		sourceMessageId: (row.source_message_id as number | null) ?? null,
		attachedAt: row.attached_at as number,
	};
}
