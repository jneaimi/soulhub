/**
 * Inbox Sync Manager — background IMAP sync with auto-reconnect.
 *
 * Architecture:
 *   - One ImapFlow client per account (single connection)
 *   - IDLE for push notifications when mailbox is open
 *   - UID-based incremental sync (only fetch new messages)
 *   - Exponential backoff reconnect on close/error
 *   - SIGTERM-safe: logout all connections before exit
 *
 * Edge cases handled:
 *   - No auto-reconnect in imapflow → manual reconnect loop
 *   - IMAP IDLE 29-min RFC timeout → maxIdleTime=15min
 *   - OAuth2 token refresh → proactive refresh before reconnect
 *   - UIDVALIDITY change → clear and re-sync folder
 *   - fetchAll() memory risk → batched fetch with async iterator
 */

import { ImapFlow } from 'imapflow';
import { EventEmitter } from 'node:events';
import {
	getAccountCredential, listAccounts, updateAccountStatus,
	upsertMessages, getSyncState,
	upsertSyncState, getMessageCount, getInboxDb,
	getAccount, pruneOldMessages, deleteMessagesByFolder,
} from './db.js';
import { markAccountFailed, markAccountRecovered, clearAccountAlert } from './notifications.js';
import { getValidToken, resolveClientCredsForAccount, type OAuthTokens } from './oauth.js';
import {
	getValidOutlookToken, fetchMessagesDelta, DeltaExpiredError,
	type OutlookTokens, type GraphMessage,
} from './outlook.js';
import { encrypt } from './crypto.js';
import { config } from '../config.js';
import type { InboxAccount, InboxMessage, SyncState, AttachmentMeta } from './types.js';

const MAX_RECONNECT_DELAY = 5 * 60 * 1000; // 5 min cap
const INITIAL_RECONNECT_DELAY = 3_000; // 3 sec
const IDLE_TIMEOUT = 15 * 60 * 1000; // 15 min (RFC max is 29)
const INITIAL_SYNC_DAYS = 30;
const FETCH_BATCH_SIZE = 100;

interface AccountWorker {
	accountId: string;
	client: ImapFlow | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	reconnectDelay: number;
	stopping: boolean;
}

let workers: Map<string, AccountWorker> = new Map();
let emitter: EventEmitter | null = null;
let initialized = false;

// Kill switch: set INBOX_SYNC_DISABLED=1 in ~/.soul-hub/.env to stop the IMAP
// workers booting up. Diagnostic + temporary — used when the reconnect loop is
// misbehaving (see error.log inbox-sync storm 2026-05-04+).
//
// Read at call time, not module load — `$lib/secrets.js` (which populates
// process.env from ~/.soul-hub/.env) is imported AFTER `$lib/inbox` in
// hooks.server.ts, so a module-level const here captures undefined.
function isInboxSyncDisabled(): boolean {
	return process.env.INBOX_SYNC_DISABLED === '1';
}

export function getSyncEmitter(): EventEmitter {
	if (!emitter) {
		emitter = new EventEmitter();
		emitter.setMaxListeners(20);
	}
	return emitter;
}

/** Start sync for all configured accounts */
export async function startSync(): Promise<void> {
	if (initialized) return;
	initialized = true;

	if (isInboxSyncDisabled()) {
		console.log('[inbox-sync] Disabled via INBOX_SYNC_DISABLED=1 — no workers started');
		return;
	}

	const accounts = listAccounts();
	for (const account of accounts) {
		startAccountSync(account);
	}
	console.log(`[inbox-sync] Started sync for ${accounts.length} accounts`);
}

/** Stop all sync workers gracefully */
export async function stopSync(): Promise<void> {
	initialized = false;
	const logouts: Promise<void>[] = [];

	for (const [, worker] of workers) {
		worker.stopping = true;
		if (worker.reconnectTimer) {
			clearTimeout(worker.reconnectTimer);
			worker.reconnectTimer = null;
		}
		if (worker.client) {
			try { worker.client.removeAllListeners(); } catch {}
			logouts.push(
				worker.client.logout().catch(() => {})
			);
		}
	}

	await Promise.allSettled(logouts);
	workers.clear();
	console.log('[inbox-sync] All workers stopped');
}

/** Start or restart sync for a single account */
export function startAccountSync(account: InboxAccount): void {
	if (isInboxSyncDisabled()) {
		console.log(`[inbox-sync:${account.id}] Skipped — INBOX_SYNC_DISABLED=1`);
		return;
	}

	// Stop existing worker if any
	const existing = workers.get(account.id);
	if (existing) {
		existing.stopping = true;
		if (existing.reconnectTimer) {
			clearTimeout(existing.reconnectTimer);
			existing.reconnectTimer = null;
		}
		if (existing.client) {
			try { existing.client.removeAllListeners(); } catch {}
			try { existing.client.close(); } catch {}
		}
	}

	const worker: AccountWorker = {
		accountId: account.id,
		client: null,
		reconnectTimer: null,
		reconnectDelay: INITIAL_RECONNECT_DELAY,
		stopping: false,
	};
	workers.set(account.id, worker);

	connectWorker(worker, account);
}

/** Stop sync for a single account */
export function stopAccountSync(accountId: string): void {
	const worker = workers.get(accountId);
	if (!worker) return;
	worker.stopping = true;
	if (worker.reconnectTimer) {
		clearTimeout(worker.reconnectTimer);
		worker.reconnectTimer = null;
	}
	if (worker.client) {
		try { worker.client.removeAllListeners(); } catch {}
		try { worker.client.close(); } catch {}
	}
	workers.delete(accountId);
	// Drop any pending alert state — prevents the in-memory Set from leaking
	// stale account ids as accounts come and go over the process lifetime.
	clearAccountAlert(accountId);
}

async function connectWorker(worker: AccountWorker, account: InboxAccount): Promise<void> {
	if (worker.stopping) return;

	// Outlook uses Graph API, not IMAP
	if (account.provider === 'outlook') {
		await connectOutlookWorker(worker, account);
		return;
	}

	const credential = getAccountCredential(account.id);
	if (!credential) {
		markAccountFailed(account, 'No credential found');
		return;
	}

	const clientConfig: Record<string, unknown> = {
		host: account.host || 'imap.mail.me.com',
		port: account.port || 993,
		secure: true,
		maxIdleTime: IDLE_TIMEOUT,
		logger: false,
		tls: {
			rejectUnauthorized: true,
		},
	};

	// Determine auth type: OAuth2 (JSON with type:oauth2) or plain password
	let parsedCred: { type?: string; accessToken?: string; refreshToken?: string; expiresAt?: number } | null = null;
	try { parsedCred = JSON.parse(credential); } catch { /* plain password */ }

	if (parsedCred?.type === 'oauth2' && parsedCred.refreshToken) {
		// OAuth2 — refresh token if expired before connecting. Pass the
		// per-account OAuth client override (if any) so accounts with their
		// own client credentials refresh against the correct client.
		try {
			const tokens = await getValidToken(
				{
					accessToken: parsedCred.accessToken || '',
					refreshToken: parsedCred.refreshToken,
					expiresAt: parsedCred.expiresAt || 0,
				},
				resolveClientCredsForAccount(account),
			);

			// Persist refreshed tokens back to DB (encrypted)
			if (tokens.accessToken !== parsedCred.accessToken) {
				const updatedCred = JSON.stringify({
					type: 'oauth2',
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					expiresAt: tokens.expiresAt,
				});
				const db = getInboxDb();
				db.prepare('UPDATE accounts SET encrypted_credential = ? WHERE id = ?')
					.run(encrypt(updatedCred), account.id);
			}

			clientConfig.auth = {
				user: account.email,
				accessToken: tokens.accessToken,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Token refresh failed';
			console.error(`[inbox-sync:${account.id}] OAuth2 refresh failed:`, msg);
			markAccountFailed(account, `OAuth2 refresh failed: ${msg}`);
			if (!worker.stopping) scheduleReconnect(worker, account);
			return;
		}
	} else {
		// Plain password (iCloud, generic IMAP)
		clientConfig.auth = {
			user: account.email,
			pass: credential,
		};
	}

	const client = new ImapFlow(clientConfig as unknown as ConstructorParameters<typeof ImapFlow>[0]);
	worker.client = client;

	updateAccountStatus(account.id, 'syncing');

	client.on('close', () => {
		if (worker.stopping) return;
		console.log(`[inbox-sync:${account.id}] Connection closed, scheduling reconnect (${worker.reconnectDelay}ms)`);
		updateAccountStatus(account.id, 'disconnected');
		scheduleReconnect(worker, account);
	});

	client.on('error', (err: Error) => {
		if (worker.stopping) return;
		console.error(`[inbox-sync:${account.id}] Error:`, err.message);
		markAccountFailed(account, err.message);
	});

	try {
		await client.connect();
		console.log(`[inbox-sync:${account.id}] Connected to ${account.host}`);

		// Reset reconnect delay on successful connection
		worker.reconnectDelay = INITIAL_RECONNECT_DELAY;

		// Perform initial/incremental sync
		await syncInbox(worker, account, client);

		markAccountRecovered(account);
		getSyncEmitter().emit('synced', account.id);

		// IDLE for push — client stays open listening for new messages
		// imapflow auto-starts IDLE when the mailbox is open and no commands are active

	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[inbox-sync:${account.id}] Connect/sync failed:`, msg);
		markAccountFailed(account, msg);

		if (!worker.stopping) {
			scheduleReconnect(worker, account);
		}
	}
}

function scheduleReconnect(worker: AccountWorker, account: InboxAccount): void {
	if (worker.stopping) return;
	// Idempotent: a single failed connect attempt fires both the 'close' event
	// AND rejects the connect() promise, so two paths race to schedule. Without
	// this guard, both stick — each spawns a new client on a fresh schedule,
	// each new client fails the same way, and the timer count grows ~2× per
	// cycle. That's the storm signature in the 2026-05-04 → 2026-05-10 logs.
	if (worker.reconnectTimer) return;

	worker.reconnectTimer = setTimeout(() => {
		worker.reconnectTimer = null;
		if (worker.stopping) return;
		// Detach handlers from the dead client so a late teardown event
		// (TCP close arriving after we've moved on) can't re-enter scheduleReconnect.
		if (worker.client) {
			try { worker.client.removeAllListeners(); } catch {}
		}
		worker.client = null;
		connectWorker(worker, account);
	}, worker.reconnectDelay);

	// Exponential backoff with cap
	worker.reconnectDelay = Math.min(worker.reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

async function syncInbox(
	worker: AccountWorker,
	account: InboxAccount,
	client: ImapFlow,
): Promise<void> {
	// Open INBOX
	const lock = await client.getMailboxLock('INBOX');

	try {
		const mailbox = client.mailbox;
		if (!mailbox) {
			console.warn(`[inbox-sync:${account.id}] No mailbox info after open`);
			return;
		}

		// imapflow returns mailbox.uidValidity as a BigInt. We store it as a
		// Number in sync_state (see Number() casts on upsert below). Coerce
		// at the source so the equality checks against syncState.uidValidity
		// don't silently always-fail — `2n !== 2` is true in JS, which would
		// re-trigger the "UIDVALIDITY changed" branch on every reconnect and
		// re-fetch the full mailbox every PM2 reload.
		const uidValidity = Number(mailbox.uidValidity || 0);
		const syncState = getSyncState(account.id, 'INBOX');

		// Check UIDVALIDITY — if changed, folder was rebuilt server-side and
		// the old uid <-> message mapping is invalid. Clear the stale rows
		// before re-syncing so they don't linger as orphans (messages that
		// no longer exist on the server but still show in the inbox list).
		if (syncState && syncState.uidValidity !== uidValidity) {
			console.log(`[inbox-sync:${account.id}] UIDVALIDITY changed (${syncState.uidValidity} → ${uidValidity}), clearing stale rows + full re-sync`);
			deleteMessagesByFolder(account.id, 'INBOX', syncState.uidValidity);
		}

		// Determine UID range to fetch
		let searchQuery: Record<string, unknown>;
		if (syncState && syncState.uidValidity === uidValidity && syncState.lastUid > 0) {
			// Incremental: fetch messages after last known UID
			searchQuery = { uid: `${syncState.lastUid + 1}:*` };
			console.log(`[inbox-sync:${account.id}] Incremental sync from UID ${syncState.lastUid + 1}`);
		} else {
			// Initial: fetch last N days
			const since = new Date();
			since.setDate(since.getDate() - INITIAL_SYNC_DAYS);
			searchQuery = { since };
			console.log(`[inbox-sync:${account.id}] Initial sync (last ${INITIAL_SYNC_DAYS} days)`);
		}

		// Fetch message UIDs first
		const uids = await client.search(searchQuery, { uid: true });
		if (!uids || uids.length === 0) {
			console.log(`[inbox-sync:${account.id}] No new messages`);
			upsertSyncState({
				accountId: account.id,
				folder: 'INBOX',
				lastUid: syncState?.lastUid || 0,
				uidValidity: Number(uidValidity),
				lastSync: Date.now(),
			});
			return;
		}

		console.log(`[inbox-sync:${account.id}] Fetching ${uids.length} messages`);

		// Fetch in batches to avoid memory pressure
		let maxUid = syncState?.lastUid || 0;
		const batch: Omit<InboxMessage, 'id'>[] = [];

		for await (const msg of client.fetch(
			{ uid: uids.join(',') },
			{
				uid: true,
				flags: true,
				envelope: true,
				bodyStructure: true,
				headers: ['message-id', 'in-reply-to', 'references'],
				size: true,
				internalDate: true,
				bodyParts: ['1'], // Fetch first text part for preview
			},
			{ uid: true },
		)) {
			if (worker.stopping) break;

			const envelope = msg.envelope || {};
			const from = envelope.from?.[0] || {};
			const to = envelope.to?.[0] || {};

			// Extract body preview from first text part
			let bodyPreview = '';
			const bodyParts = msg.bodyParts as Map<string, Buffer> | undefined;
			if (bodyParts) {
				const textPart = bodyParts.get('1');
				if (textPart) {
					bodyPreview = textPart.toString('utf-8').slice(0, 500).replace(/\r?\n/g, ' ').trim();
				}
			}

			// Extract Message-ID from headers (may be Map or Buffer depending on ImapFlow version)
			let messageId: string | null = null;
			let inReplyTo: string | null = null;
			const rawHeaders = msg.headers;
			if (rawHeaders instanceof Map) {
				messageId = rawHeaders.get('message-id')?.toString().trim().replace(/[<>]/g, '') || null;
				inReplyTo = rawHeaders.get('in-reply-to')?.toString().trim().replace(/[<>]/g, '') || null;
			} else if (Buffer.isBuffer(rawHeaders)) {
				const headerStr = rawHeaders.toString('utf-8');
				const midMatch = headerStr.match(/message-id:\s*<?([^>\r\n]+)>?/i);
				if (midMatch) messageId = midMatch[1].trim();
				const replyMatch = headerStr.match(/in-reply-to:\s*<?([^>\r\n]+)>?/i);
				if (replyMatch) inReplyTo = replyMatch[1].trim();
			}

			const attachmentsMeta = extractAttachmentMetadata(msg.bodyStructure);
			const hasAttachments = attachmentsMeta.length > 0;

			batch.push({
				accountId: account.id,
				uid: Number(msg.uid),
				uidValidity: Number(uidValidity),
				folder: 'INBOX',
				messageId,
				threadId: inReplyTo || messageId, // Simple threading: use in-reply-to as thread root
				inReplyTo,
				subject: envelope.subject || '',
				fromAddress: from.address || '',
				fromName: from.name || null,
				toAddress: to.address || '',
				dateSent: envelope.date ? new Date(envelope.date).getTime() : null,
				dateReceived: msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
				flags: Array.from(msg.flags || []),
				hasAttachments,
				bodyPreview,
				rawSize: msg.size || 0,
				syncedAt: Date.now(),
				attachmentsMeta,
				attachmentCount: attachmentsMeta.length,
				isFlagged: Array.from(msg.flags || []).some(f =>
					f === '\\Flagged' || f === 'Flagged' || f === '$Flagged'
				),
				processStatus: 'new',
				// Layer 2/3 outputs — NULL at sync time, populated later by the
				// filter (category/filterReason/filteredAt/headerSignals) and the
				// extractor/marker (processedAt/extractedData/extractedAt).
				category: null,
				filterReason: null,
				filteredAt: null,
				headerSignals: null,
				processedAt: null,
				extractedData: null,
				extractedAt: null,
			});

			if (Number(msg.uid) > maxUid) maxUid = Number(msg.uid);

			// Flush batch to SQLite
			if (batch.length >= FETCH_BATCH_SIZE) {
				upsertMessages(batch.splice(0));
			}
		}

		// Flush remaining
		if (batch.length > 0) {
			upsertMessages(batch);
		}

		// Update sync state
		upsertSyncState({
			accountId: account.id,
			folder: 'INBOX',
			lastUid: maxUid,
			uidValidity: Number(uidValidity),
			lastSync: Date.now(),
		});

		// Prune old messages based on retention policy
		const accountData = getAccount(account.id);
		if (accountData?.retentionDays && accountData.retentionDays > 0) {
			pruneOldMessages(account.id, accountData.retentionDays, {
				queuedNoMatchDays: config.inbox.autoRoute.queuedNoMatchPruneDays,
			});
		}

		const totalCount = getMessageCount(account.id);
		console.log(`[inbox-sync:${account.id}] Sync complete: ${uids.length} fetched, ${totalCount} total cached`);
	} finally {
		lock.release();
	}
}

// ── Outlook Graph API sync ──

const OUTLOOK_POLL_INTERVAL = 5 * 60 * 1000; // 5 min

async function connectOutlookWorker(worker: AccountWorker, account: InboxAccount): Promise<void> {
	const credential = getAccountCredential(account.id);
	if (!credential) {
		markAccountFailed(account, 'No credential found');
		return;
	}

	let parsedCred: { type?: string; accessToken?: string; refreshToken?: string; expiresAt?: number } | null = null;
	try { parsedCred = JSON.parse(credential); } catch {}

	if (parsedCred?.type !== 'outlook-oauth2' || !parsedCred.refreshToken) {
		markAccountFailed(account, 'Invalid Outlook credential format');
		return;
	}

	updateAccountStatus(account.id, 'syncing');

	try {
		// Refresh token if needed. Resolve OAuth client creds per-account
		// (Connections), falling back to the provider's Default Connection.
		const outlookCreds = resolveClientCredsForAccount(account);
		let tokens: OutlookTokens = {
			accessToken: parsedCred.accessToken || '',
			refreshToken: parsedCred.refreshToken,
			expiresAt: parsedCred.expiresAt || 0,
		};
		tokens = await getValidOutlookToken(tokens, outlookCreds);

		// Persist refreshed tokens
		const updatedCred = JSON.stringify({
			type: 'outlook-oauth2',
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
		});
		const db = getInboxDb();
		db.prepare('UPDATE accounts SET encrypted_credential = ? WHERE id = ?')
			.run(encrypt(updatedCred), account.id);

		// Get stored delta link for incremental sync (migration 10 — proper column).
		const deltaRow = db.prepare(
			`SELECT delta_link FROM sync_state WHERE account_id = ? AND folder = 'INBOX'`,
		).get(account.id) as { delta_link: string | null } | undefined;
		const deltaLink = deltaRow?.delta_link ?? undefined;

		let result;
		try {
			result = await fetchMessagesDelta(tokens.accessToken, deltaLink);
		} catch (err) {
			if (err instanceof DeltaExpiredError) {
				console.log(`[inbox-sync:${account.id}] Delta token expired, full re-sync`);
				result = await fetchMessagesDelta(tokens.accessToken); // no delta = full sync
			} else {
				throw err;
			}
		}

		// Convert Graph messages to our format and upsert. fetchMessagesDelta
		// returns the raw Graph response (`value` + `@odata.deltaLink`).
		if (result.value.length > 0) {
			const batch: Omit<InboxMessage, 'id'>[] = result.value.map((msg) => graphToInboxMessage(account.id, msg));
			upsertMessages(batch);
		}

		// Store new delta link on the account's INBOX row.
		const deltaLinkNext = result['@odata.deltaLink'];
		if (deltaLinkNext) {
			db.prepare(`
				INSERT INTO sync_state (account_id, folder, last_uid, uid_validity, last_sync, delta_link)
				VALUES (?, 'INBOX', 0, 0, ?, ?)
				ON CONFLICT(account_id, folder) DO UPDATE SET
					last_sync = excluded.last_sync,
					delta_link = excluded.delta_link
			`).run(account.id, Date.now(), deltaLinkNext);
		}

		markAccountRecovered(account);
		getSyncEmitter().emit('synced', account.id);

		// Prune old messages based on retention policy
		const accountData = getAccount(account.id);
		if (accountData?.retentionDays && accountData.retentionDays > 0) {
			pruneOldMessages(account.id, accountData.retentionDays, {
				queuedNoMatchDays: config.inbox.autoRoute.queuedNoMatchPruneDays,
			});
		}

		const totalCount = getMessageCount(account.id);
		console.log(`[inbox-sync:${account.id}] Outlook sync: ${result.value.length} messages, ${totalCount} total`);

		// Schedule next poll
		if (!worker.stopping) {
			worker.reconnectTimer = setTimeout(() => {
				if (!worker.stopping) connectOutlookWorker(worker, account);
			}, OUTLOOK_POLL_INTERVAL);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[inbox-sync:${account.id}] Outlook sync failed:`, msg);
		markAccountFailed(account, msg);

		if (!worker.stopping) {
			scheduleReconnect(worker, account);
		}
	}
}

function graphToInboxMessage(accountId: string, msg: GraphMessage): Omit<InboxMessage, 'id'> {
	return {
		accountId,
		uid: hashStringToInt(msg.id), // Graph uses string IDs, we need int UIDs
		uidValidity: 1, // Not applicable for Graph
		folder: 'INBOX',
		messageId: msg.internetMessageId?.replace(/[<>]/g, '') || null,
		threadId: msg.conversationId || null,
		inReplyTo: null,
		subject: msg.subject || '',
		fromAddress: msg.from?.emailAddress?.address || '',
		fromName: msg.from?.emailAddress?.name || null,
		toAddress: msg.toRecipients?.[0]?.emailAddress?.address || '',
		dateSent: msg.sentDateTime ? new Date(msg.sentDateTime).getTime() : null,
		dateReceived: new Date(msg.receivedDateTime).getTime(),
		flags: msg.isRead ? ['\\Seen'] : [],
		hasAttachments: msg.hasAttachments || false,
		bodyPreview: (msg.bodyPreview || '').slice(0, 500),
		rawSize: 0,
		syncedAt: Date.now(),
		attachmentsMeta: [],
		attachmentCount: 0,
		isFlagged: false,
		processStatus: 'new',
		// Layer 2/3 outputs — NULL at sync time (see graphToInboxMessage's IMAP twin).
		category: null,
		filterReason: null,
		filteredAt: null,
		headerSignals: null,
		processedAt: null,
		extractedData: null,
		extractedAt: null,
	};
}

/** Hash a string ID to a stable integer for the UID column */
function hashStringToInt(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & 0x7FFFFFFF; // Keep positive 31-bit int
	}
	return hash || 1;
}

function extractAttachmentMetadata(structure: unknown): AttachmentMeta[] {
	const attachments: AttachmentMeta[] = [];

	function traverse(node: unknown) {
		if (!node) return;
		const s = node as Record<string, unknown>;

		const disposition = s.disposition as string | undefined;
		const type = s.type as string || '';

		if (disposition === 'attachment' || disposition === 'inline') {
			const params = s.dispositionParameters as Record<string, string> | undefined;
			const typeParams = s.parameters as Record<string, string> | undefined;
			const filename = params?.filename || typeParams?.name || 'unnamed';
			const size = (s.size as number) || 0;

			if (size > 0 || disposition === 'attachment') {
				attachments.push({
					filename,
					size,
					mimeType: type,
					part: s.part as string | undefined,
					isInline: disposition === 'inline',
				});
			}
		} else if (!disposition && type && !type.startsWith('text/') && !type.startsWith('multipart/')) {
			const typeParams = s.parameters as Record<string, string> | undefined;
			const filename = typeParams?.name || 'unnamed';
			const size = (s.size as number) || 0;
			if (size > 0) {
				attachments.push({
					filename,
					size,
					mimeType: type,
					part: s.part as string | undefined,
					isInline: false,
				});
			}
		}

		if (Array.isArray(s.childNodes)) {
			for (const child of s.childNodes) {
				traverse(child);
			}
		}
	}

	traverse(structure);
	return attachments;
}

/** Get sync status for all accounts */
export function getSyncStatus(): { accountId: string; connected: boolean; stopping: boolean }[] {
	return [...workers.entries()].map(([id, w]) => ({
		accountId: id,
		connected: w.client !== null && !w.stopping,
		stopping: w.stopping,
	}));
}
