/**
 * Lazy on-demand IMAP fetch for full message bodies and attachments.
 *
 * The sync worker deliberately stores only envelope + 500-char preview +
 * attachment metadata — see ADR 2026-04-16. Pulling full RFC822 bodies and
 * attachment bytes on every sync would bloat the DB and slow IDLE. Instead,
 * both are fetched on demand:
 *   - GET /api/inbox/messages/[id]/body         → fetchImapBody
 *   - GET /api/inbox/messages/[id]/attachments/[part] → fetchImapAttachment
 *
 * For v1 we open a fresh ImapFlow connection per request and buffer the
 * response in memory. Fine for operator-driven UI clicks; attachments are
 * bounded by the existing 25MB upload cap, which dwarfs typical mail
 * attachments. If Layer 2 / Layer 3 agents start hammering these endpoints,
 * switch to a per-account connection pool and streaming responses.
 *
 * Outlook (MS Graph) needs separate paths because the sync layer hashes the
 * Graph string id into messages.uid (lossy) — see plan Open #6. Until that
 * adds an external_id column, both Outlook body and attachment fetch are 501.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getValidToken, resolveClientCredsForAccount } from './oauth.js';
import { encrypt } from './crypto.js';
import { getAccountCredential, getInboxDb } from './db.js';
import type { InboxAccount, InboxMessage } from './types.js';

export interface MessageBody {
	text: string;
	html: string | null;
	fetchedAt: number;
}

export interface AttachmentBytes {
	data: Buffer;
	contentType: string;
}

/** Body + attachment binaries from a single IMAP fetch. Used by ADR-044
 *  mailwright draft path to surface both the original mail content and
 *  any attachments alongside the drafted reply, without forcing a second
 *  IMAP round-trip per attachment. */
export interface MessageBodyWithAttachments extends MessageBody {
	attachments: Array<{
		filename: string;
		mimeType: string;
		size: number;
		data: Buffer;
		isInline: boolean;
	}>;
}

/**
 * Build and connect an ImapFlow client using the account's stored credential.
 * OAuth2 tokens are refreshed if expired and the refreshed pair is persisted
 * back to the encrypted credential — same semantics as sync.ts:connectWorker.
 *
 * Caller owns the returned client and MUST call `client.logout()` (or close)
 * when done. The current callers wrap that in try/finally.
 */
async function connectImap(account: InboxAccount): Promise<ImapFlow> {
	const credential = getAccountCredential(account.id);
	if (!credential) throw new Error('Account has no stored credential');

	const clientConfig: Record<string, unknown> = {
		host: account.host || 'imap.mail.me.com',
		port: account.port || 993,
		secure: true,
		logger: false,
		tls: { rejectUnauthorized: true },
	};

	let parsedCred: { type?: string; accessToken?: string; refreshToken?: string; expiresAt?: number } | null = null;
	try { parsedCred = JSON.parse(credential); } catch { /* plain password */ }

	if (parsedCred?.type === 'oauth2' && parsedCred.refreshToken) {
		const tokens = await getValidToken(
			{
				accessToken: parsedCred.accessToken || '',
				refreshToken: parsedCred.refreshToken,
				expiresAt: parsedCred.expiresAt || 0,
			},
			resolveClientCredsForAccount(account),
		);
		// Persist refreshed tokens back to DB if changed.
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
		clientConfig.auth = { user: account.email, accessToken: tokens.accessToken };
	} else {
		clientConfig.auth = { user: account.email, pass: credential };
	}

	const client = new ImapFlow(clientConfig as unknown as ConstructorParameters<typeof ImapFlow>[0]);
	await client.connect();
	return client;
}

/**
 * Fetch the full body of an IMAP message and return parsed text + html.
 *
 * Throws on any upstream failure — callers surface as 502 in the endpoint.
 */
export async function fetchImapBody(
	account: InboxAccount,
	message: Pick<InboxMessage, 'uid' | 'folder'>,
): Promise<MessageBody> {
	const full = await fetchImapBodyWithAttachments(account, message);
	return { text: full.text, html: full.html, fetchedAt: full.fetchedAt };
}

/** Same as `fetchImapBody` but also returns parsed attachment binaries.
 *  Used by the ADR-044 draft path which embeds the original mail body
 *  + saves attachments alongside the draft. The IMAP fetch is identical
 *  — `simpleParser` always parses attachments; the difference is whether
 *  we return them. */
export async function fetchImapBodyWithAttachments(
	account: InboxAccount,
	message: Pick<InboxMessage, 'uid' | 'folder'>,
): Promise<MessageBodyWithAttachments> {
	const client = await connectImap(account);
	try {
		const lock = await client.getMailboxLock(message.folder || 'INBOX');
		try {
			const result = await client.fetchOne(
				String(message.uid),
				{ source: true },
				{ uid: true },
			);
			if (!result || !result.source) {
				throw new Error('Message source not returned by server (possibly deleted upstream)');
			}
			const parsed = await simpleParser(result.source as Buffer);
			const attachments = (parsed.attachments ?? []).map((a) => ({
				filename: a.filename ?? 'unnamed',
				mimeType: a.contentType ?? 'application/octet-stream',
				size: a.size ?? (a.content?.length ?? 0),
				data: a.content as Buffer,
				isInline: a.contentDisposition === 'inline',
			}));
			return {
				text: parsed.text || '',
				html: typeof parsed.html === 'string' ? parsed.html : null,
				fetchedAt: Date.now(),
				attachments,
			};
		} finally {
			lock.release();
		}
	} finally {
		try { await client.logout(); } catch { /* best-effort close */ }
	}
}

/**
 * Fetch RFC822 headers for a batch of messages (BODY.PEEK[HEADER]).
 *
 * Used by the Layer 2 filter cold-start sweep to fill in `messages.header_signals`
 * for rows captured before the filter existed — Layer 1 stores only envelope +
 * preview, so header-based rules (List-Unsubscribe, List-ID, Precedence) have
 * nothing to read against until the headers are refetched.
 *
 * Cheaper than fetchImapBody (no body parsing, smaller IMAP payload). Throughput
 * is bounded by the per-account IMAP connection — sequential, no parallelism
 * inside a single fetch. Empirically ~50-100 msgs/sec on Gmail (well under
 * Apple iCloud's rate limit too).
 *
 * Returns a Map<uid, headersString>. UIDs not present in the response are
 * silently omitted (e.g. deleted upstream between sync and re-fetch); callers
 * should treat absence as "skip" not "error".
 *
 * Opens INBOX read-only. Caller passes UIDs from the messages table; this
 * function assumes those UIDs are valid under the current UIDVALIDITY (the
 * sync worker holds that invariant — a UIDVALIDITY change purges the rows).
 */
export async function fetchImapHeaders(
	account: InboxAccount,
	uids: number[],
): Promise<Map<number, string>> {
	const result = new Map<number, string>();
	if (uids.length === 0) return result;

	const client = await connectImap(account);
	try {
		const lock = await client.getMailboxLock('INBOX', { readOnly: true });
		try {
			// imapflow accepts a UID array directly as the sequence; setting
			// `headers: true` requests BODY.PEEK[HEADER] without marking \Seen.
			for await (const msg of client.fetch(
				uids,
				{ headers: true },
				{ uid: true },
			)) {
				if (msg.uid && msg.headers) {
					result.set(Number(msg.uid), msg.headers.toString('utf-8'));
				}
			}
		} finally {
			lock.release();
		}
	} finally {
		try { await client.logout(); } catch { /* best-effort close */ }
	}
	return result;
}

/**
 * Fetch a single attachment part by its IMAP part id (e.g. "2", "1.2").
 * Buffers the part into memory and returns it with the upstream-reported
 * content type. The caller (HTTP endpoint) is responsible for filename
 * resolution from messages.attachmentsMeta and Content-Disposition headers.
 *
 * Throws on any upstream failure — callers surface as 502.
 */
export async function fetchImapAttachment(
	account: InboxAccount,
	message: Pick<InboxMessage, 'uid' | 'folder'>,
	partId: string,
): Promise<AttachmentBytes> {
	const client = await connectImap(account);
	try {
		const lock = await client.getMailboxLock(message.folder || 'INBOX');
		try {
			const result = await client.download(String(message.uid), partId, { uid: true });
			if (!result || !result.content) {
				throw new Error(`Attachment part "${partId}" not returned by server`);
			}
			// Buffer the stream. For v1 we accept the memory cost over the
			// streaming-lifecycle complexity of keeping the ImapFlow connection
			// alive across the SvelteKit Response boundary.
			const chunks: Buffer[] = [];
			for await (const chunk of result.content) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const data = Buffer.concat(chunks);
			const meta = result.meta as { contentType?: string } | undefined;
			return {
				data,
				contentType: meta?.contentType || 'application/octet-stream',
			};
		} finally {
			lock.release();
		}
	} finally {
		try { await client.logout(); } catch { /* best-effort close */ }
	}
}
