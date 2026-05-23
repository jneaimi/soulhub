/** ADR-044 — Inbox digest inline-button action primitives.
 *
 *  Pure-ish functions called from the Telegram callback handler when the
 *  operator taps an action button on an inbox-digest highlight. Four
 *  buckets of action, mirroring ADR-043's pattern:
 *
 *   - `archiveInboxMessage(id)`   → flip process_status to 'archived'.
 *     Removes the row from future digest fan-out without losing the
 *     audit trail. Reversible by re-flipping status.
 *   - `saveInboxToVault(id)`      → dispatchVaultSave with subject +
 *     preview as the note body. Marks process_status='saved'. The full
 *     body fetch is deferred to v2 (preview is enough for triage).
 *   - `muteInboxSender(addr)`     → insert a `sender_pattern → bulk`
 *     filter rule so future mail from this sender bypasses digests.
 *     Reversible via the existing filter-rule API.
 *   - `draftInboxReply(id)`       → dispatch the scribe agent with the
 *     mail context; returns the draft text. Outbound mail isn't wired
 *     yet, so the operator copies the draft + sends from their mail
 *     client manually (this is v1 of the reply roadmap).
 *
 *  All four record a row to `agent_actions` for audit. None are
 *  destructive at the data layer — every change is reversible via DB
 *  or git (vault saves).
 */

import { access as fsAccess } from 'node:fs/promises';
import { join, relative as pathRelative } from 'node:path';
import {
	getInboxDb,
	getMessage,
	insertFilterRule,
	recordAgentAction,
	getAccount,
	type InboxMessage,
} from './index.js';
import { fetchImapBodyWithAttachments } from './body.js';
import { getVaultEngine } from '../vault/index.js';
import { dispatchAgent } from '../agents/dispatch/index.js';
import { findContactByEmail, addInteraction } from '../crm/index.js';

export interface InboxActionResult {
	ok: boolean;
	error?: string;
	detail?: string;
}

/** Flip a message to `process_status='archived'`. Returns ok+detail with
 *  the prior status so the callback handler can log it. */
export async function archiveInboxMessage(
	messageId: number,
): Promise<InboxActionResult> {
	const db = getInboxDb();
	const row = db
		.prepare('SELECT process_status FROM messages WHERE id = ?')
		.get(messageId) as { process_status: string } | undefined;
	if (!row) return { ok: false, error: 'not-found', detail: `msg ${messageId} missing` };
	const prior = row.process_status;
	if (prior === 'archived') {
		return { ok: true, detail: `already archived` };
	}
	db.prepare('UPDATE messages SET process_status = ? WHERE id = ?').run(
		'archived',
		messageId,
	);
	recordAgentAction({
		tool: 'inbox-digest-archive',
		messageId,
		actor: 'operator-direct',
		args: { messageId },
		result: { ok: true, prior, next: 'archived' },
	});
	return { ok: true, detail: `${prior} → archived` };
}

/** Slugify a string into a filesystem-safe kebab-case segment. Strips
 *  non-alnum, collapses runs of `-`, trims trailing `-`, lower-cases.
 *  Exported because the draft-status probe re-derives draft paths and
 *  needs the same formula as draftInboxReply — keeping them in lockstep
 *  by shared helper, not by copy. */
export function slugify(input: string, max = 60): string {
	const slug = (input || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, max);
	return slug || 'untitled';
}

/** Deterministic draft vault path for an inbox message. Single source of
 *  truth — both draftInboxReply (writer) and /api/inbox/messages/[id]/
 *  draft-status (reader) call this so the path never drifts. */
export function draftPathFor(msg: {
	dateReceived: number;
	fromAddress: string | null;
	subject: string | null;
}): string {
	const dateIso = new Date(msg.dateReceived).toISOString().slice(0, 10);
	const yearMonth = dateIso.slice(0, 7);
	const senderSlug = slugify(msg.fromAddress?.split('@')[0] || 'unknown', 30);
	const subjectSlug = slugify(msg.subject || 'no-subject', 50);
	return `email/drafts/${yearMonth}/${dateIso}-${senderSlug}-${subjectSlug}-draft.md`;
}

/** Build the public vault URL for a note path. Mirrors `noteOpenUrl` in
 *  `vault-save/index.ts` — kept inline so this module doesn't take a
 *  dependency on the save dispatcher. */
function noteOpenUrl(path: string): string {
	const base = process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400';
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${base}/vault?note=${encoded}&view=note`;
}

/** Save the mail's envelope + preview as a reference note in the
 *  `email/<YYYY-MM>/` zone. Source-based destination (NOT content-based)
 *  — the operator's intent when tapping Save is "stash this specific
 *  email," so we bypass dispatchVaultSave's smart-router and write
 *  directly via the engine. Auto-routed flows (finance/, security/) are
 *  unaffected — those run from the inbox-auto-route worker via the
 *  category rules. Marks process_status='saved' on success. */
export async function saveInboxToVault(
	messageId: number,
): Promise<InboxActionResult> {
	const msg = getMessage(messageId);
	if (!msg) return { ok: false, error: 'not-found' };

	// Idempotent short-circuit — guards against double-clicks racing
	// through this function in the same second (observed in agent_actions:
	// two `inbox-digest-save` rows for the same messageId at identical
	// timestamps). Without this, both calls do full body fetch + agent
	// work + would double-insert a CRM interaction. Vault content-similarity
	// dedup catches the file write itself, but CRM logging happens after.
	if (msg.processStatus === 'saved') {
		return { ok: true, detail: 'already saved (idempotent)' };
	}

	const engine = getVaultEngine();
	if (!engine) return { ok: false, error: 'vault-engine-not-ready' };

	const from = msg.fromName || msg.fromAddress || 'unknown sender';
	const dateIso = new Date(msg.dateReceived).toISOString().slice(0, 10);
	const yearMonth = dateIso.slice(0, 7); // YYYY-MM
	const senderSlug = slugify(msg.fromAddress?.split('@')[0] || 'unknown', 30);
	const subjectSlug = slugify(msg.subject || 'no-subject', 60);
	const filename = `${dateIso}-${senderSlug}-${subjectSlug}.md`;

	const title = msg.subject || `Mail from ${from}`;

	// ADR-044.E — CRM frontmatter for the vault-side "Save sender to CRM"
	// card. Lifted earlier in the flow so it's available for both the
	// frontmatter (here) and the auto-log step (below). The card reads
	// `crm_sender_status` from frontmatter and renders either:
	//   - 'in-crm'     → muted link to the contact page
	//   - 'not-in-crm' → "Add sender to CRM" affordance with editable form
	// On add, the API patches frontmatter to flip the status, making the
	// card replace itself with the muted link.
	const crmPreMatch = msg.fromAddress ? findContactByEmail(msg.fromAddress) : null;
	// Fetch full body + save attachments (same path as the Draft flow).
	// Save lands richer artifacts in the vault: full body content, not
	// the 300-char preview, plus saved attachment binaries linked from
	// the Source block.
	const bodyOutcome = await fetchBodyForDraft(msg);
	const saveAttachmentsBlock = formatAttachmentsList(
		bodyOutcome.savedAttachments,
		bodyOutcome.skippedAttachments,
		`email/${yearMonth}`,
	);
	// Resolve receiving account for traceability (which of the user's
	// inbox accounts this landed on — they want to know).
	const saveAccount = getAccount(msg.accountId);
	const saveReceivedAtAccount = saveAccount
		? `${saveAccount.email} (${saveAccount.provider}${saveAccount.label ? ' · ' + saveAccount.label : ''})`
		: msg.accountId;
	// Body matches the `reference.md` template's expected sections
	// (`## Source` + `## Content`) so the vault engine's
	// template-validation passes. Root vault governance enforces
	// `requireTemplate=true`. `## Original Email` is additive (allowed,
	// not required).
	const body = [
		`# ${title}`,
		``,
		`## Source`,
		``,
		`- **From**: ${from} <${msg.fromAddress}>`,
		`- **Received at account**: ${saveReceivedAtAccount}`,
		`- **To address (envelope)**: ${msg.toAddress || '(unknown)'}`,
		`- **Date**: ${dateIso}`,
		`- **Subject**: ${msg.subject}`,
		`- **Inbox message id**: ${messageId}`,
		`- **Body source**: ${bodyOutcome.source}${bodyOutcome.truncated ? ' (truncated)' : ''}`,
		`- **Captured via**: ADR-044 inline action`,
		`- **Attachments**:`,
		saveAttachmentsBlock,
		``,
		`## Original Email`,
		``,
		bodyOutcome.text ||
			'_(no body available — open the source mail client for the full body)_',
		``,
		`## Content`,
		``,
		`_(no operator notes yet — add your commentary or follow-up actions here)_`,
	].join('\n');

	// CRM frontmatter — flat keys (yaml stringifier handles them cleanly).
	// The card component branches on `crm_sender_status`.
	const crmMeta: Record<string, string> = {};
	if (crmPreMatch) {
		crmMeta.crm_sender_status = 'in-crm';
		crmMeta.crm_contact_id = crmPreMatch.contact.id;
		crmMeta.crm_contact_stage = crmPreMatch.contact.stage;
		crmMeta.crm_contact_display_name = crmPreMatch.contact.displayName;
	} else if (msg.fromAddress) {
		crmMeta.crm_sender_status = 'not-in-crm';
		crmMeta.crm_candidate_email = msg.fromAddress;
		crmMeta.crm_candidate_name = msg.fromName || msg.fromAddress.split('@')[0];
	}

	const outcome = await engine.createNote({
		zone: `email/${yearMonth}`,
		filename,
		meta: {
			type: 'reference',
			title,
			created: new Date().toISOString(),
			tags: ['inbox', 'email-save', msg.category ?? 'unclassified'],
			source_agent: 'orchestrator-v2-inbox-save',
			// ADR-044 Phase A — surface the source messageId in frontmatter
			// so vault-side UI can offer Draft Reply without parsing body
			// text. Numeric to keep YAML clean. Future-proof for when the
			// inbox prune lapses the source row out of the DB: the note
			// still records which message it came from.
			inbox_message_id: messageId,
			...crmMeta,
		},
		content: body,
	});

	// Idempotent Save: if the vault engine rejects because an existing
	// note has very similar content (operator already saved this mail
	// earlier, or saved a sibling in the same thread), treat that as
	// success — point them at the existing note and flip
	// process_status='saved' so the row falls out of future digests.
	// Same rationale as the attachment-already-exists path: the artifact
	// is in the vault, the goal of "stash this mail" is met.
	let savedPath: string;
	let dedupMatch = false;
	if (!('success' in outcome) || !outcome.success) {
		const err = 'error' in outcome ? outcome.error : 'unknown';
		const dupMatch = err.match(/Similar note exists at: (\S+)/);
		if (dupMatch) {
			savedPath = dupMatch[1];
			dedupMatch = true;
		} else {
			recordAgentAction({
				tool: 'inbox-digest-save',
				messageId,
				actor: 'operator-direct',
				args: { messageId },
				result: { ok: false, error: err },
			});
			return { ok: false, error: 'vault-save-failed', detail: err };
		}
	} else {
		savedPath = outcome.path;
	}

	const db = getInboxDb();
	db.prepare('UPDATE messages SET process_status = ? WHERE id = ?').run(
		'saved',
		messageId,
	);

	// ADR-044.B — if the sender matches a CRM contact, log this as an
	// inbound interaction. Bumps `contacts.last_interaction_at` and
	// surfaces the inbound on the contact's timeline. Failure here is
	// non-fatal — the vault save already succeeded; CRM-logging is a
	// best-effort enrichment. Reuses `crmPreMatch` computed earlier for
	// the frontmatter — no second DB hit.
	let crmInteractionId: number | null = null;
	if (crmPreMatch) {
		try {
			const summary = msg.subject
				? `Inbound mail: "${msg.subject.slice(0, 200)}"`
				: 'Inbound mail (no subject)';
			const interaction = addInteraction({
				contactId: crmPreMatch.contact.id,
				timestamp: msg.dateReceived,
				channel: 'email',
				direction: 'inbound',
				summary,
				messageId,
			});
			crmInteractionId = interaction.id;
		} catch (err) {
			console.warn(
				`[inbox-save] CRM-log failed for msg ${messageId}: ${(err as Error).message}`,
			);
		}
	}

	recordAgentAction({
		tool: 'inbox-digest-save',
		messageId,
		actor: 'operator-direct',
		args: { messageId },
		result: {
			ok: true,
			path: savedPath,
			crmInteractionId,
			...(dedupMatch ? { dedup: 'content-similarity' } : {}),
		},
	});
	const dedupTail = dedupMatch ? ' (already saved earlier)' : '';
	const crmTail = crmInteractionId
		? ` · 🤝 CRM interaction ${crmInteractionId} logged`
		: '';
	return { ok: true, detail: `saved → \`${savedPath}\`${dedupTail}${crmTail}` };
}

/** Insert a `sender_pattern → bulk` filter rule so future mail from
 *  this sender goes straight to the bulk category (excluded from
 *  digests). Optionally flips the CURRENT message's process_status to
 *  `archived` so it falls out of digests + shows under /inbox's
 *  Archived filter. Without that flip, the user's intent ("don't
 *  bother me with this") only applies to FUTURE mail; the current row
 *  sits in `queued` looking un-actioned. Returns ok with the new rule
 *  id so the operator can reverse via the filter-rules UI/API. */
export async function muteInboxSender(
	fromAddress: string,
	messageId?: number,
): Promise<InboxActionResult> {
	if (!fromAddress || !fromAddress.includes('@')) {
		return { ok: false, error: 'invalid-address' };
	}
	const normalized = fromAddress.toLowerCase().trim();
	// Idempotent — if a user-created mute rule already exists for this
	// sender, return ok rather than inserting a duplicate.
	const db = getInboxDb();
	const existing = db
		.prepare(
			`SELECT id FROM filter_rules
			 WHERE match_type = 'sender_pattern'
			   AND match_value = ?
			   AND action_category = 'bulk'
			   AND enabled = 1
			 LIMIT 1`,
		)
		.get(normalized) as { id: number } | undefined;

	// Always flip the current msg to archived if provided — the operator
	// tapped Mute on THIS mail, so even when the rule is a duplicate
	// (already-muted sender), the current row should leave the queue.
	if (messageId !== undefined) {
		db.prepare('UPDATE messages SET process_status = ? WHERE id = ?').run(
			'archived',
			messageId,
		);
	}

	if (existing) {
		return { ok: true, detail: `already muted (rule ${existing.id})` };
	}
	const id = insertFilterRule({
		precedence: 50,
		matchType: 'sender_pattern',
		matchValue: normalized,
		actionCategory: 'bulk',
		reason: 'Muted via ADR-044 inline action',
		createdBy: 'user',
		enabled: true,
	});
	return { ok: true, detail: `rule ${id} created` };
}

/** Best-effort base64 detection + decode for body previews that arrive
 *  raw-encoded from some senders (Google security alerts ship the body
 *  as quoted-printable/base64 MIME parts; L1 sync stores them raw in
 *  bodyPreview). Heuristic: ≥80% of non-whitespace chars are base64
 *  alphabet AND length ≥ 32. Returns decoded text if it round-trips
 *  cleanly to UTF-8; otherwise returns the original. */
function maybeDecodeBase64(text: string): string {
	if (!text || text.length < 32) return text;
	const stripped = text.replace(/\s+/g, '');
	if (stripped.length < 32) return text;
	const b64chars = /[A-Za-z0-9+/=]/g;
	const matches = stripped.match(b64chars);
	if (!matches || matches.length / stripped.length < 0.8) return text;
	try {
		const decoded = Buffer.from(stripped, 'base64').toString('utf-8');
		// Sanity check — must be mostly printable ASCII/UTF-8, and the
		// round-trip can't shrink to garbage (a single replacement-char-
		// heavy decode means we guessed wrong).
		// eslint-disable-next-line no-control-regex
		const printable = decoded.replace(/[^\x20-\x7E -￿\n\r\t]/g, '');
		if (printable.length / decoded.length < 0.85) return text;
		return decoded;
	} catch {
		return text;
	}
}

/** Cap on the full-body text we pass to mailwright. Most replies need
 *  the first few paragraphs at most — capping protects the agent's
 *  context window and reduces token spend. */
const FULL_BODY_CHAR_CAP = 8000;

/** Max per-attachment size we embed into the vault. Anything larger
 *  gets listed with metadata only (operator opens the original mail
 *  to view). Below the vault engine's 16 MB hard cap. */
const ATTACHMENT_EMBED_MAX_BYTES = 10 * 1024 * 1024;

interface SavedAttachment {
	filename: string;
	mimeType: string;
	size: number;
	vaultPath: string;
}

interface SkippedAttachment {
	filename: string;
	mimeType: string;
	size: number;
	reason: 'too-large' | 'inline' | 'save-failed';
	error?: string;
}

interface BodyFetchOutcome {
	text: string;
	source: 'imap-full' | 'preview-only';
	truncated: boolean;
	/** Attachments saved to the vault under `email/attachments/<YYYY-MM>/<msg-id>/`.
	 *  Empty for non-IMAP accounts or mail with no attachments. */
	savedAttachments: SavedAttachment[];
	/** Attachments we did NOT save (too large, inline-only, write failed).
	 *  Listed in the source block so the operator knows they exist. */
	skippedAttachments: SkippedAttachment[];
}

/** Sanitize a filename so it's safe to write under a vault zone:
 *  - No path separators (vault writeAsset enforces)
 *  - No leading dot
 *  - Must have an extension (vault writeAsset enforces)
 *  - Truncate very long names to keep the link tidy */
function sanitizeAttachmentFilename(name: string): string {
	let n = (name || 'attachment')
		.replace(/[\\/]+/g, '_')
		.replace(/[^A-Za-z0-9._\- ]+/g, '_')
		.replace(/\s+/g, '_')
		.replace(/^\.+/, '');
	if (!/\.[A-Za-z0-9]+$/.test(n)) {
		n += '.bin';
	}
	// Cap total length — overlong filenames don't survive every FS gracefully.
	if (n.length > 120) {
		const extMatch = n.match(/\.[A-Za-z0-9]+$/);
		const ext = extMatch ? extMatch[0] : '';
		n = n.slice(0, 120 - ext.length) + ext;
	}
	return n;
}

/** Fetch the full email body + attachments via IMAP. Saves any non-inline
 *  attachments under `email/attachments/<YYYY-MM>/<msg-id>/` (capped at
 *  10 MB per file). Falls back to preview-only for non-IMAP providers
 *  (Outlook Graph) or on fetch failure — attachments are then
 *  listed-only via `attachmentsMeta` from L1 sync. */
async function fetchBodyForDraft(msg: InboxMessage): Promise<BodyFetchOutcome> {
	const previewClean = maybeDecodeBase64(msg.bodyPreview ?? '').trim();
	const account = getAccount(msg.accountId);
	const imapProviders = new Set(['gmail', 'icloud', 'imap']);

	// Non-IMAP path: degrade to preview-only. Surface attachments from
	// L1 sync metadata as "skipped" so the operator still knows what's
	// attached (just can't open from vault).
	if (!account || !imapProviders.has(account.provider)) {
		const skipped: SkippedAttachment[] = (msg.attachmentsMeta ?? [])
			.filter((a) => !a.isInline)
			.map((a) => ({
				filename: a.filename,
				mimeType: a.mimeType,
				size: a.size,
				reason: 'save-failed' as const,
				error: 'non-IMAP account (Outlook Graph fetch not wired)',
			}));
		return {
			text: previewClean,
			source: 'preview-only',
			truncated: false,
			savedAttachments: [],
			skippedAttachments: skipped,
		};
	}

	try {
		const body = await fetchImapBodyWithAttachments(account, msg);
		const raw = (body.text || '').trim();
		const truncated = raw.length > FULL_BODY_CHAR_CAP;
		const text = truncated
			? raw.slice(0, FULL_BODY_CHAR_CAP) + '\n\n…(truncated)'
			: raw;

		// Save attachments under email/attachments/<YYYY-MM>/<msg-id>/
		const engine = getVaultEngine();
		const saved: SavedAttachment[] = [];
		const skipped: SkippedAttachment[] = [];
		if (engine && body.attachments.length > 0) {
			const dateIso = new Date(msg.dateReceived).toISOString().slice(0, 10);
			const yearMonth = dateIso.slice(0, 7);
			const zone = `email/attachments/${yearMonth}/msg-${msg.id}`;
			for (const att of body.attachments) {
				if (att.isInline) {
					skipped.push({
						filename: att.filename,
						mimeType: att.mimeType,
						size: att.size,
						reason: 'inline',
					});
					continue;
				}
				if (att.size > ATTACHMENT_EMBED_MAX_BYTES) {
					skipped.push({
						filename: att.filename,
						mimeType: att.mimeType,
						size: att.size,
						reason: 'too-large',
					});
					continue;
				}
				const safeName = sanitizeAttachmentFilename(att.filename);
				const result = await engine.writeAsset({
					zone,
					filename: safeName,
					buffer: att.data,
					mimetype: att.mimeType,
					agent: 'orchestrator-v2-inbox-draft',
					context: `msg-${msg.id}`,
				});
				if ('success' in result && result.success) {
					saved.push({
						filename: safeName,
						mimeType: att.mimeType,
						size: att.size,
						vaultPath: result.path,
					});
					continue;
				}
				// Idempotency: if the file already exists at the same path,
				// treat it as saved. Re-drafting a mail with the same
				// attachment shouldn't error — the binary is already in the
				// vault, the link is valid, the draft note just needs to
				// reference it. The vault engine raises this two ways:
				// `File already exists:` (createNote path) and
				// `Asset already exists:` (writeAsset path) — match both.
				const errMsg = 'error' in result ? result.error : 'unknown';
				if (
					errMsg.startsWith('File already exists:') ||
					errMsg.startsWith('Asset already exists:')
				) {
					const existingPath = `${zone}/${safeName}`;
					saved.push({
						filename: safeName,
						mimeType: att.mimeType,
						size: att.size,
						vaultPath: existingPath,
					});
					continue;
				}
				skipped.push({
					filename: att.filename,
					mimeType: att.mimeType,
					size: att.size,
					reason: 'save-failed',
					error: errMsg,
				});
			}
		}

		return {
			text: text || previewClean,
			source: raw ? 'imap-full' : 'preview-only',
			truncated,
			savedAttachments: saved,
			skippedAttachments: skipped,
		};
	} catch (err) {
		console.warn(
			`[inbox-draft] fetchImapBodyWithAttachments failed for msg ${msg.id}: ${(err as Error).message}`,
		);
		const skipped: SkippedAttachment[] = (msg.attachmentsMeta ?? [])
			.filter((a) => !a.isInline)
			.map((a) => ({
				filename: a.filename,
				mimeType: a.mimeType,
				size: a.size,
				reason: 'save-failed' as const,
				error: (err as Error).message,
			}));
		return {
			text: previewClean,
			source: 'preview-only',
			truncated: false,
			savedAttachments: [],
			skippedAttachments: skipped,
		};
	}
}

/** Build the markdown attachment list for the Source block. Emits paths
 *  RELATIVE to the note's zone (e.g. `../attachments/2026-05/msg-7/file.pdf`
 *  for a Save note at `email/2026-05/...md`). Relative paths are the
 *  trigger the vault renderer (`src/lib/vault/renderer.ts:rewriteAttachmentLink`)
 *  uses to detect attachment links — absolute paths starting with `/` are
 *  explicitly skipped, so clicks would open a new tab instead of the
 *  side drawer. Each segment is URI-encoded individually (spaces, etc.),
 *  but `..` segments are preserved literally so the resolver climbs out
 *  of the note's directory cleanly. */
function formatAttachmentsList(
	saved: SavedAttachment[],
	skipped: SkippedAttachment[],
	noteZone: string,
): string {
	const lines: string[] = [];
	for (const s of saved) {
		const sizeKb = Math.round(s.size / 1024);
		const rel = pathRelative(noteZone, s.vaultPath);
		const encoded = rel
			.split('/')
			.map((seg) => (seg === '..' ? '..' : encodeURIComponent(seg)))
			.join('/');
		lines.push(
			`  - [${s.filename}](${encoded}) · ${s.mimeType} · ${sizeKb} KB`,
		);
	}
	for (const s of skipped) {
		const sizeKb = Math.round(s.size / 1024);
		const tag =
			s.reason === 'too-large'
				? '(too large to embed)'
				: s.reason === 'inline'
				? '(inline)'
				: `(not saved: ${s.error ?? s.reason})`;
		lines.push(`  - \`${s.filename}\` · ${s.mimeType} · ${sizeKb} KB · ${tag}`);
	}
	if (lines.length === 0) return '  - (none)';
	return lines.join('\n');
}

/** Module-scope in-flight registry — `messageId → Promise<result>` for
 *  drafts currently being composed by mailwright. Concurrent callers
 *  (e.g. operator clicks Draft in Telegram, then on /inbox within the
 *  ~30–60s mailwright takes) JOIN the running promise instead of each
 *  starting a fresh dispatch. The `processStatus='drafted'` flip only
 *  happens AFTER mailwright completes, so this map closes the gap
 *  between dispatch-start and DB-state-flip during which two requests
 *  would both observe `processStatus !== 'drafted'` and race.
 *
 *  Process-restart-safe: if soul-hub crashes mid-draft, the map drops
 *  with the process. Any partial file is left in vault (mailwright may
 *  or may not have written by then); the next caller bypasses the map
 *  (empty) and runs a fresh dispatch — which is idempotent thanks to
 *  `processStatus === 'drafted'` if the prior run actually flipped it. */
const draftsInFlight = new Map<
	number,
	Promise<InboxActionResult & { vaultPath?: string; openUrl?: string }>
>();

/** Dispatch the dedicated `mailwright` agent (claude-cli-flag, one-shot)
 *  to draft a reply for the given inbox message. The agent writes the
 *  draft directly to a vault note at `email/drafts/<YYYY-MM>/...` —
 *  we just hand it the target path + the metadata block and verify
 *  the file exists afterwards. No transcript parsing.
 *
 *  Why a dedicated agent (not scribe, not AI SDK):
 *   - scribe (PTY) is multi-skill and produces a full TUI transcript;
 *     overkill for one-shot file-write and noisy to parse.
 *   - AI SDK direct can't load `/stop-slop` or `/arabic` skills, which
 *     are non-negotiable for brand-voice quality.
 *   - mailwright (claude-cli-flag) is single-purpose: read context,
 *     run audit, write file, print path. Clean handoff via fs. */
export async function draftInboxReply(
	messageId: number,
): Promise<InboxActionResult & { vaultPath?: string; openUrl?: string }> {
	const msg = getMessage(messageId);
	if (!msg) return { ok: false, error: 'not-found' };

	const engine = getVaultEngine();
	if (!engine) return { ok: false, error: 'vault-engine-not-ready' };

	// Idempotent short-circuit — without this, repeated button clicks
	// each dispatch a fresh mailwright run (observed 8× on a single
	// messageId during operator testing). Each run costs API spend and
	// overwrites the same deterministic vault path. The slug formula
	// in draftPathFor() is the single source of truth, shared with the
	// /draft-status probe so reader + writer never drift.
	if (msg.processStatus === 'drafted') {
		return {
			ok: true,
			detail: 'already drafted (idempotent)',
			vaultPath: draftPathFor(msg),
		};
	}

	// In-flight join — if another caller is already running mailwright
	// for this exact messageId, await ITS promise instead of dispatching
	// again. Without this guard, two clicks within mailwright's 30–60s
	// runtime both observe `processStatus !== 'drafted'` (terminal flip
	// only happens AFTER mailwright completes) and both spawn an agent,
	// burning ~$0.20 each AND racing each other to write the same file.
	// All concurrent callers receive the SAME result object when the
	// in-flight dispatch completes.
	const existing = draftsInFlight.get(messageId);
	if (existing) {
		return existing;
	}

	// Wrap the entire dispatch in a promise stored in draftsInFlight so
	// concurrent callers (within the same process) join this run rather
	// than starting a parallel mailwright. The promise is registered
	// synchronously below — anyone arriving in the same tick sees it.
	const promise: Promise<InboxActionResult & { vaultPath?: string; openUrl?: string }> = (async () => {
	const from = msg.fromName || msg.fromAddress || 'sender';

	// Pull the full body + attachments via IMAP (Gmail/iCloud); degrades
	// to bodyPreview-only for Outlook/Graph or on fetch failure.
	// Attachments are pre-saved to email/attachments/<YYYY-MM>/<msg-id>/
	// so the draft note's links resolve immediately.
	const bodyOutcome = await fetchBodyForDraft(msg);

	// Resolve the receiving account — the operator has multiple inbox
	// accounts (Gmail × 2, iCloud), and needs to know which one this
	// landed on so they can reply from the right `From:` address.
	const account = getAccount(msg.accountId);
	const receivedAtAccount = account
		? `${account.email} (${account.provider}${account.label ? ' · ' + account.label : ''})`
		: msg.accountId;

	// Pre-compute the target vault path. mailwright receives this verbatim
	// in its task prompt and writes the file there. dateIso + yearMonth
	// are still needed inline below for the body composition (Source
	// block + attachments folder), so we derive them once and let
	// draftPathFor compose the final relPath from the same inputs.
	const dateIso = new Date(msg.dateReceived).toISOString().slice(0, 10);
	const yearMonth = dateIso.slice(0, 7);
	const relPath = draftPathFor(msg);
	const absPath = join(engine.vaultDir, relPath);

	// Build attachments block with paths relative to the draft note's zone.
	// e.g. `../../attachments/2026-05/msg-7/file.pdf` — the leading `..`s
	// are how the vault renderer detects this as an attachment link and
	// wires the side-drawer click handler.
	const attachmentsBlock = formatAttachmentsList(
		bodyOutcome.savedAttachments,
		bodyOutcome.skippedAttachments,
		`email/drafts/${yearMonth}`,
	);

	// Pre-build the Source block — mailwright pastes this VERBATIM under
	// `## Source`, so the metadata stays consistent across drafts and
	// doesn't depend on the agent's interpretation of the task.
	const sourceBlock = [
		`- **In reply to**: ${from} <${msg.fromAddress}>`,
		`- **Received at account**: ${receivedAtAccount}`,
		`- **To address (envelope)**: ${msg.toAddress || '(unknown)'}`,
		`- **Original subject**: ${msg.subject}`,
		`- **Received**: ${dateIso}`,
		`- **Inbox message id**: ${messageId}`,
		`- **Drafted by**: mailwright agent`,
		`- **Status**: draft — review + copy + send manually from your mail client`,
		`- **Attachments**:`,
		attachmentsBlock,
	].join('\n');

	const nowIso = new Date().toISOString();
	const titleRe = `Re: ${(msg.subject || '(no subject)').replace(/"/g, '\\"')}`;

	const task = [
		`# Email reply draft task`,
		``,
		`Draft a reply to the email below, run the audit pass, and save the result as a vault note.`,
		``,
		`## Email context`,
		``,
		`- **From**: ${from} <${msg.fromAddress}>`,
		`- **Subject**: ${msg.subject}`,
		`- **Date**: ${dateIso}`,
		`- **Inbox message id**: ${messageId}`,
		`- **Category**: ${msg.category ?? 'unclassified'}`,
		`- **Body source**: ${bodyOutcome.source}${bodyOutcome.truncated ? ' (truncated at 8000 chars)' : ''}`,
		`- **Attachments saved to vault**: ${bodyOutcome.savedAttachments.length}`,
		`- **Attachments skipped**: ${bodyOutcome.skippedAttachments.length}`,
		``,
		`### Attachments (already saved to vault — DO NOT regenerate these links)`,
		``,
		attachmentsBlock,
		``,
		`> If the email has attachments, acknowledge them by name in your reply ` +
			`("re: the invoice you attached" / "thanks for the contract draft, I'll review and come back"). ` +
			`You cannot open or process binary attachments — do NOT pretend to have read them. ` +
			`Outbound mail isn't wired yet, so the operator will attach files themselves when they send.`,
		``,
		`### Full body`,
		``,
		bodyOutcome.text ||
			'(no body available — write a brief acknowledgement asking the sender to share more context)',
		``,
		`## Target vault path (write here, exact)`,
		``,
		`\`${relPath}\``,
		``,
		`Absolute path: \`${absPath}\``,
		``,
		`## Required file structure`,
		``,
		`The file MUST have this exact frontmatter (vault governance requires the \`reference\` template):`,
		``,
		`\`\`\`yaml`,
		`---`,
		`type: draft`,
		`title: "${titleRe}"`,
		`created: ${nowIso}`,
		`tags:`,
		`  - inbox`,
		`  - email-draft`,
		`  - ${msg.category ?? 'unclassified'}`,
		`source_agent: mailwright`,
		`---`,
		`\`\`\``,
		``,
		`Followed by, IN THIS EXACT ORDER (top-down — the operator reads the reply first, not the original mail):`,
		``,
		`1. \`# ${titleRe}\` (H1)`,
		``,
		`2. \`## Content\` containing your drafted reply body (NOT the original mail). ` +
			`This section comes FIRST so the operator sees what they're about to send ` +
			`without scrolling past the original email. The reply should stand on its own; ` +
			`the operator will paste it into their mail client and send.`,
		``,
		`3. \`## Source\` with EXACTLY this block pasted verbatim (do not regenerate):`,
		``,
		`\`\`\``,
		sourceBlock,
		`\`\`\``,
		``,
		`4. \`## Original Email\` containing the ORIGINAL incoming mail body verbatim ` +
			`(the "### Full body" content above this section, no edits). Paste it as plain ` +
			`markdown text — do NOT wrap in a fenced code block (the body already has ` +
			`paragraph structure; code blocks render monospace which hurts readability). ` +
			`This sits LAST as reference material — the operator can scroll to it if they ` +
			`need to reread context, but the draft reply they care about is already at the top.`,
		``,
		`After writing the file, print only the absolute path on stdout. Nothing else.`,
	].join('\n');

	let runId: string | undefined;
	try {
		const generator = dispatchAgent('mailwright', task, {
			mode: 'production',
			sourceMessage: `inbox-reply-draft:msg-${messageId}`,
		});
		let result: Awaited<ReturnType<typeof generator.next>>;
		do {
			result = await generator.next();
		} while (!result.done);
		const dispatch = result.value;
		runId = dispatch.runId;
		if (dispatch.status !== 'success' && dispatch.status !== 'goal_achieved') {
			recordAgentAction({
				tool: 'inbox-digest-reply-draft',
				messageId,
				actor: 'operator-direct',
				args: { messageId, agent: 'mailwright' },
				result: { ok: false, status: dispatch.status, runId, error: dispatch.error },
			});
			return {
				ok: false,
				error: 'agent-failed',
				detail: `mailwright ${dispatch.status}${dispatch.error ? ': ' + dispatch.error : ''}`,
			};
		}
	} catch (err) {
		recordAgentAction({
			tool: 'inbox-digest-reply-draft',
			messageId,
			actor: 'operator-direct',
			args: { messageId, agent: 'mailwright' },
			result: { ok: false, error: (err as Error).message },
		});
		return {
			ok: false,
			error: 'dispatch-failed',
			detail: (err as Error).message,
		};
	}

	// File existence is our success signal. If the agent finished but
	// didn't write to the expected path, that's a failure — we don't
	// silently accept a missing artifact.
	try {
		await fsAccess(absPath);
	} catch {
		recordAgentAction({
			tool: 'inbox-digest-reply-draft',
			messageId,
			actor: 'operator-direct',
			args: { messageId, agent: 'mailwright', expectedPath: relPath },
			result: { ok: false, error: 'file-not-written', runId },
		});
		return {
			ok: false,
			error: 'file-not-written',
			detail: `mailwright finished but no file at ${relPath}`,
		};
	}

	// Flip the source message to `drafted` so it falls out of future
	// digests and shows under the /inbox "Drafted" filter alongside
	// other replied items. Without this, the row stays `queued` and
	// (modulo dedup) would still feel un-actioned in the UI.
	const draftDb = getInboxDb();
	draftDb.prepare('UPDATE messages SET process_status = ? WHERE id = ?').run(
		'drafted',
		messageId,
	);

	recordAgentAction({
		tool: 'inbox-digest-reply-draft',
		messageId,
		actor: 'operator-direct',
		args: { messageId, agent: 'mailwright' },
		result: { ok: true, runId, vaultPath: relPath },
	});
	return {
		ok: true,
		vaultPath: relPath,
		openUrl: noteOpenUrl(relPath),
		detail: `mailwright runId=${runId ?? 'unknown'}`,
	};
	})();

	draftsInFlight.set(messageId, promise);
	try {
		return await promise;
	} finally {
		// Always release — success, failure, and thrown errors all flow
		// through here so the map can't accumulate stuck entries.
		draftsInFlight.delete(messageId);
	}
}
