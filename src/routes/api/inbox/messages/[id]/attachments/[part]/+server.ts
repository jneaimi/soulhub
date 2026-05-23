import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAccount, getMessage, fetchImapAttachment } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/messages/[id]/attachments/[part]
 *
 * Fetches a single attachment by its IMAP body-structure part id (stored
 * in messages.attachmentsMeta during sync). Returns the raw bytes with
 * Content-Type from the upstream-reported MIME type and
 * Content-Disposition that triggers a browser download dialog.
 *
 * The DB stores attachment metadata (filename, size, mime, part) at sync
 * time without ever fetching the bytes — see ADR 2026-04-16. This endpoint
 * is the lazy fetch path.
 *
 * Filename in Content-Disposition uses RFC 5987's `filename*=UTF-8''…`
 * extension so non-ASCII filenames (Arabic, Japanese, emoji) round-trip
 * correctly across browsers; we also send a fallback `filename="…"` with
 * non-ASCII stripped for ancient clients.
 *
 * Response:
 *   200 binary, Content-Type from upstream
 *   400 invalid id / missing part
 *   404 message not found / no matching attachment
 *   501 outlook (graph id was hashed into messages.uid; plan Open #6)
 *   502 upstream fetch failed
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	const part = params.part;
	if (!Number.isInteger(id) || id <= 0) {
		return json({ error: 'Invalid id' }, { status: 400 });
	}
	if (!part) {
		return json({ error: 'Missing part' }, { status: 400 });
	}

	const message = getMessage(id);
	if (!message) {
		return json({ error: `Message ${id} not found` }, { status: 404 });
	}

	const account = getAccount(message.accountId);
	if (!account) {
		return json({ error: `Account ${message.accountId} not found (orphan message)` }, { status: 500 });
	}

	if (account.provider === 'outlook') {
		return json(
			{
				error:
					'Outlook attachment fetch is not yet implemented. Tracked in inbox-plan Open #6 — needs an external_id column to round-trip the Graph string id.',
			},
			{ status: 501 },
		);
	}

	// Verify the requested part actually exists in this message's metadata.
	// Cheap guard against probing for unrelated parts. mimeType / filename
	// come from the sync-time bodyStructure capture.
	const attMeta = (message.attachmentsMeta || []).find((a) => a.part === part);
	if (!attMeta) {
		return json({ error: `Part "${part}" not found on message ${id}` }, { status: 404 });
	}

	try {
		const { data, contentType } = await fetchImapAttachment(account, message, part);
		const filename = attMeta.filename || 'attachment';

		// Prefer the upstream-reported content type, but the DB's mimeType is
		// the authoritative value we vetted during sync — fall back to it if
		// the server's content type looks like the octet-stream default.
		const finalType = contentType === 'application/octet-stream' && attMeta.mimeType
			? attMeta.mimeType
			: contentType;

		return new Response(new Uint8Array(data), {
			status: 200,
			headers: {
				'Content-Type': finalType,
				'Content-Length': String(data.length),
				'Content-Disposition': buildContentDisposition(filename),
				// Inbox attachments don't change once captured — safe to cache
				// per-message-id+part for a short window. immutable would be
				// overstepping (Layer 2 may re-process), so just a modest TTL.
				'Cache-Control': 'private, max-age=300',
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[inbox-attachment:${account.id}] Failed to fetch part ${part} of message ${id}:`, msg);
		return json({ error: `Failed to fetch attachment: ${msg}` }, { status: 502 });
	}
};

/**
 * Build a Content-Disposition header that handles non-ASCII filenames per
 * RFC 5987. Emits both the legacy `filename="…"` (with non-ASCII stripped)
 * and the modern `filename*=UTF-8''…` form.
 */
function buildContentDisposition(filename: string): string {
	const safe = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
	const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
	return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
