import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { addAccount, listAccounts, removeAccount, getAccount, updateAccountSettings, updateAccountCredential, startAccountSync, stopAccountSync, pruneOldMessages, getOauthClient } from '$lib/inbox/index.js';
import type { InboxProvider } from '$lib/inbox/index.js';

const VALID_PROVIDERS: InboxProvider[] = ['icloud', 'gmail', 'outlook', 'imap'];

const PROVIDER_DEFAULTS: Record<string, { host: string; port: number }> = {
	icloud: { host: 'imap.mail.me.com', port: 993 },
	gmail: { host: 'imap.gmail.com', port: 993 },
	outlook: { host: 'outlook.office365.com', port: 993 },
};

/**
 * GET /api/inbox/accounts — list all email accounts
 */
export const GET: RequestHandler = async () => {
	const accounts = listAccounts();
	return json({ accounts });
};

/**
 * POST /api/inbox/accounts — add a new email account
 *   { provider, email, label?, credential, host?, port? }
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const provider = body.provider as string;
	const email = body.email as string;
	const credential = body.credential as string;
	const label = (body.label as string) || email;

	if (!provider || !VALID_PROVIDERS.includes(provider as InboxProvider)) {
		return json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` }, { status: 400 });
	}
	if (!email || !email.includes('@')) {
		return json({ error: 'valid email is required' }, { status: 400 });
	}
	if (!credential) {
		return json({ error: 'credential is required (password or OAuth token)' }, { status: 400 });
	}

	const defaults = PROVIDER_DEFAULTS[provider];
	const host = (body.host as string) || defaults?.host;
	const port = (body.port as number) || defaults?.port;

	if (!host) {
		return json({ error: 'host is required for custom IMAP provider' }, { status: 400 });
	}

	// Dedup on (provider, email). Re-adding an existing account would
	// produce two rows competing for IMAP IDLE on the same mailbox — the
	// storm pathology the 2026-05-10 cascade post-mortem catalogued. Same
	// guard pattern as the Gmail OAuth callback (see ADR
	// 2026-05-11-multiple-gmail-accounts) and Outlook callback. The
	// UNIQUE(provider, email) index (migration #3) enforces this at the
	// storage layer too; this earlier check just produces a friendlier
	// error message.
	const duplicate = listAccounts().find(
		(a) => a.provider === provider && a.email === email,
	);
	if (duplicate) {
		const fix =
			provider === 'gmail' || provider === 'outlook'
				? 'Use Reauthorize on the existing account if its tokens expired.'
				: 'Open the existing account\'s settings (gear icon) and use Reset password.';
		return json(
			{ error: `Account ${email} is already connected. ${fix}` },
			{ status: 409 },
		);
	}

	const id = randomUUID().slice(0, 8);

	try {
		const account = addAccount(
			{ id, label, provider: provider as InboxProvider, email, host, port },
			credential,
		);

		// Start sync worker for the new account
		startAccountSync(account);

		return json({ ok: true, account }, { status: 201 });
	} catch (err) {
		return json(
			{ error: `Failed to add account: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 },
		);
	}
};

/**
 * DELETE /api/inbox/accounts — remove an email account
 *   { id }
 */
export const DELETE: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const id = body.id as string;
	if (!id) {
		return json({ error: 'id is required' }, { status: 400 });
	}

	const account = getAccount(id);
	if (!account) {
		return json({ error: `Account "${id}" not found` }, { status: 404 });
	}

	stopAccountSync(id);
	removeAccount(id);
	return json({ ok: true, removed: id });
};

/**
 * PATCH /api/inbox/accounts — update account settings
 *   { id, label?, retentionDays?, credential? }
 *
 * When credential is provided, the encrypted_credential column is replaced,
 * status is reset to disconnected, last_error cleared, and the sync worker
 * restarted so the user immediately sees whether the new credential works.
 */
export const PATCH: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const id = body.id as string;
	if (!id) return json({ error: 'id is required' }, { status: 400 });

	const account = getAccount(id);
	if (!account) return json({ error: `Account "${id}" not found` }, { status: 404 });

	const hasSettings =
		body.label !== undefined ||
		typeof body.retentionDays === 'number' ||
		body.oauthClientRef !== undefined;
	const credential = typeof body.credential === 'string' ? body.credential.trim() : '';
	const hasCredential = credential.length > 0;

	if (!hasSettings && !hasCredential) {
		return json({ error: 'No valid fields to update' }, { status: 400 });
	}

	// Validate oauthClientRef if present. The UI typically pairs a Change
	// with a reauthorize cycle, but the PATCH itself just persists the FK;
	// the next refresh attempt picks up the new client.
	let nextOauthClientRef: string | null | undefined = undefined;
	if (body.oauthClientRef !== undefined) {
		if (body.oauthClientRef === null) {
			nextOauthClientRef = null;
		} else if (typeof body.oauthClientRef === 'string') {
			const ref = body.oauthClientRef.trim();
			if (!ref) {
				return json({ error: 'oauthClientRef cannot be empty string; use null to clear' }, { status: 400 });
			}
			const client = getOauthClient(ref);
			if (!client) {
				return json({ error: `OAuth client not found: ${ref}` }, { status: 404 });
			}
			if (client.provider !== account.provider) {
				return json(
					{ error: `OAuth client provider (${client.provider}) doesn't match account provider (${account.provider})` },
					{ status: 400 },
				);
			}
			nextOauthClientRef = ref;
		} else {
			return json({ error: 'oauthClientRef must be a string or null' }, { status: 400 });
		}
	}

	// Track whether retention actually changed so we know to run an
	// immediate prune. Without this the new value sits inert until the next
	// sync cycle fires — confusing UX, especially for an account in error
	// state where sync may not fire for a long time (G2 in the retention
	// punch list).
	const newRetention = typeof body.retentionDays === 'number' ? body.retentionDays : undefined;
	const retentionChanged = newRetention !== undefined && newRetention !== account.retentionDays;
	let pruned: number | null = null;

	if (hasSettings) {
		updateAccountSettings(id, {
			label: body.label as string | undefined,
			retentionDays: newRetention,
			oauthClientRef: nextOauthClientRef,
		});

		// Immediate prune on retention change. pruneOldMessages already
		// short-circuits on retentionDays <= 0 (the "never delete" sentinel),
		// so passing 0 here is a safe no-op.
		if (retentionChanged && newRetention !== undefined) {
			pruned = pruneOldMessages(id, newRetention);
		}
	}

	if (hasCredential) {
		try {
			updateAccountCredential(id, credential);
		} catch (err) {
			return json(
				{ error: `Failed to update credential: ${err instanceof Error ? err.message : String(err)}` },
				{ status: 500 },
			);
		}

		const refreshed = getAccount(id);
		if (refreshed) {
			stopAccountSync(id);
			startAccountSync(refreshed);
		}
	}

	const refreshed = getAccount(id);
	return json({ ok: true, account: refreshed, pruned });
};
