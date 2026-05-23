/**
 * Cross-DB bridge between crm.db and inbox.db (ADR
 * 2026-05-11-crm-local-sqlite-transition §D7 + §D8).
 *
 * Both DBs live in `~/.soul-hub/data/` and are opened via separate
 * better-sqlite3 connections. We do *not* ATTACH them — keeping the
 * lifecycles independent matters more than the marginal SQL ergonomics
 * we'd gain, and the dataset sizes (contacts in the hundreds, inbox rows
 * in the thousands) make app-side filtering cheap.
 *
 * Public surface:
 *   listMessagesForContact(contactId, opts?)       — inbox messages from any of a contact's emails
 *   enrichInboxRowsWithContact(messages)           — bulk contact match for a page of inbox rows
 *   findWebsiteLeads(opts?)                        — D8 lead-finder: inbox subject-filter minus known senders
 */

import { getInboxDb, rowToMessage, type InboxMessage, type FilterCategory } from '../inbox/index.js';
import { getCrmDb, listContactEmails, findContactByEmail } from './db.js';
import type { ContactEmailMatch } from './types.js';
import { operatorDomain } from '../branding.js';

export interface ListMessagesForContactOptions {
	/** Max rows to return. Hard cap at 200 to avoid runaway memory on a
	 *  contact whose email is also a list address. */
	limit?: number;
	/** Restrict to messages received after this epoch-ms. */
	since?: number;
	/** Restrict to a single process_status (default: any). */
	status?: 'new' | 'queued' | 'skipped' | 'processed';
}

/**
 * Inbox messages sent from any of a contact's emails. Empty array when
 * the contact has no email addresses or when no messages match.
 *
 * Used by Stage C/E to power the "Recent emails" section in the CRM
 * detail panel. The orchestrator can also call this via a future
 * `crm-list-emails` tool.
 */
export function listMessagesForContact(
	contactId: string,
	opts: ListMessagesForContactOptions = {},
): InboxMessage[] {
	const emails = listContactEmails(contactId);
	if (emails.length === 0) return [];

	const limit = Math.min(opts.limit ?? 50, 200);
	const lowered = emails.map((e) => e.email.toLowerCase());
	const placeholders = lowered.map(() => '?').join(', ');

	const where: string[] = [`LOWER(from_address) IN (${placeholders})`];
	const params: unknown[] = [...lowered];
	if (opts.since !== undefined) {
		where.push('date_received >= ?');
		params.push(opts.since);
	}
	if (opts.status) {
		where.push('process_status = ?');
		params.push(opts.status);
	}

	const inbox = getInboxDb();
	const rows = inbox.prepare(`
		SELECT * FROM messages
		WHERE ${where.join(' AND ')}
		ORDER BY date_received DESC
		LIMIT ?
	`).all(...params, limit) as Record<string, unknown>[];

	return rows.map(rowToMessage);
}

export interface InboxRowEnrichment {
	message: InboxMessage;
	contactMatch: ContactEmailMatch | null;
}

/**
 * Bulk contact-match for a page of inbox rows. Single SQL query against
 * contact_emails using the de-duplicated sender set — avoids N round-trips
 * when the future inbox UI renders the contact badge.
 */
export function enrichInboxRowsWithContact(messages: InboxMessage[]): InboxRowEnrichment[] {
	if (messages.length === 0) return [];

	const senders = new Set<string>();
	for (const m of messages) {
		if (m.fromAddress) senders.add(m.fromAddress.toLowerCase());
	}
	if (senders.size === 0) {
		return messages.map((m) => ({ message: m, contactMatch: null }));
	}

	const placeholders = Array.from(senders).map(() => '?').join(', ');
	const crm = getCrmDb();
	const rows = crm.prepare(`
		SELECT c.*, ce.email AS matched_email, ce.label AS matched_label,
		       ce.is_primary AS matched_is_primary, ce.created_at AS matched_created_at,
		       LOWER(ce.email) AS lower_email
		FROM contacts c
		JOIN contact_emails ce ON ce.contact_id = c.id
		WHERE LOWER(ce.email) IN (${placeholders})
	`).all(...Array.from(senders)) as Record<string, unknown>[];

	// Index by lowered email so we can join client-side per message.
	const byEmail = new Map<string, ContactEmailMatch>();
	for (const row of rows) {
		byEmail.set(row.lower_email as string, {
			contact: {
				id: row.id as string,
				displayName: row.display_name as string,
				company: (row.company as string | null) ?? null,
				role: (row.role as string | null) ?? null,
				source: (row.source as never) ?? null,
				stage: row.stage as never,
				dealType: (row.deal_type as string | null) ?? null,
				dealValue: (row.deal_value as number | null) ?? null,
				dealCurrency: (row.deal_currency as string | null) ?? null,
				notes: (row.notes as string | null) ?? null,
				vaultNotePath: (row.vault_note_path as string | null) ?? null,
				nextFollowupAt: (row.next_followup_at as number | null) ?? null,
				lastInteractionAt: (row.last_interaction_at as number | null) ?? null,
				createdAt: row.created_at as number,
				updatedAt: row.updated_at as number,
			},
			matchedEmail: {
				contactId: row.id as string,
				email: row.matched_email as string,
				label: (row.matched_label as string | null) ?? null,
				isPrimary: (row.matched_is_primary as number) === 1,
				createdAt: row.matched_created_at as number,
			},
		});
	}

	return messages.map((m) => ({
		message: m,
		contactMatch: m.fromAddress ? (byEmail.get(m.fromAddress.toLowerCase()) ?? null) : null,
	}));
}

export interface WebsiteLeadsOptions {
	/** Subject substring to match. Defaults to the operator's site tag. */
	subjectContains?: string;
	/** Max rows to return. Default 50. */
	limit?: number;
}

export interface WebsiteLeadCandidate {
	messageId: number;
	accountId: string;
	fromAddress: string;
	fromName: string | null;
	subject: string;
	dateReceived: number;
	bodyPreview: string;
	category: FilterCategory | null;
}

/**
 * Find inbox rows that look like fresh website leads — subject contains a
 * configurable tag (default derived from SOUL_HUB_DOMAIN) AND the sender is not already
 * a CRM contact. The orchestrator surfaces these via the future
 * `crm-find-website-leads` tool (ADR §D8) and offers to convert each into
 * a contact.
 *
 * App-side filter for the "not in CRM" check: pull the entire
 * contact_emails set (small; bounded by the operator's roster size) into
 * a Set and reject inbox rows whose `from_address` is present.
 */
export function findWebsiteLeads(opts: WebsiteLeadsOptions = {}): WebsiteLeadCandidate[] {
	const subjectContains = opts.subjectContains ?? `[${operatorDomain()}]`;
	const limit = Math.min(opts.limit ?? 50, 200);

	// 1. Build the "already known" sender set from CRM.
	const crm = getCrmDb();
	const knownRows = crm.prepare('SELECT LOWER(email) AS e FROM contact_emails').all() as { e: string }[];
	const known = new Set(knownRows.map((r) => r.e));

	// 2. Query inbox for the subject tag, broad — then filter app-side. The
	//    extra reads here are negligible at our volume and avoid a fragile
	//    NOT IN (?, ?, …) with a long parameter list.
	const inbox = getInboxDb();
	const rows = inbox.prepare(`
		SELECT id, account_id, from_address, from_name, subject, date_received, body_preview, category
		FROM messages
		WHERE subject LIKE ?
		  AND process_status IN ('new', 'queued')
		ORDER BY date_received DESC
		LIMIT ?
	`).all(`%${subjectContains}%`, limit * 2) as Record<string, unknown>[];

	const result: WebsiteLeadCandidate[] = [];
	for (const row of rows) {
		const sender = (row.from_address as string | null)?.toLowerCase() ?? '';
		if (sender && known.has(sender)) continue;
		result.push({
			messageId: row.id as number,
			accountId: row.account_id as string,
			fromAddress: row.from_address as string,
			fromName: (row.from_name as string | null) ?? null,
			subject: row.subject as string,
			dateReceived: row.date_received as number,
			bodyPreview: row.body_preview as string,
			category: (row.category as FilterCategory | null) ?? null,
		});
		if (result.length >= limit) break;
	}
	return result;
}

/** Convenience wrapper — single-shot "is this inbox sender a CRM contact?"
 *  Delegates to `findContactByEmail` in the CRM db module. Kept here so
 *  the inbox-bridge module has the full surface a caller would expect. */
export function isCrmContact(email: string): boolean {
	return findContactByEmail(email) !== null;
}

