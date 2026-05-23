import type { RequestHandler } from './$types';
import { isRedirect, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { exchangeOutlookCode, getOutlookUserEmail } from '$lib/inbox/outlook.js';
import {
	addAccount,
	getAccount,
	listAccounts,
	startAccountSync,
	stopAccountSync,
	updateAccountCredential,
	touchOauthClientUsage,
} from '$lib/inbox/index.js';
import {
	resolveClientCredsByRef,
	resolveClientCredsForAccount,
} from '$lib/inbox/oauth.js';

/**
 * GET /api/inbox/outlook/callback — Microsoft OAuth2 callback
 *
 * Three modes, distinguished by the `state` query param. Mirrors the
 * Gmail callback at /api/inbox/oauth/callback:
 *
 *   1. state = "client:<uuid>" — first-time link with a named Connection.
 *      Resolves creds by ref, exchanges the code, dedups by (outlook, email),
 *      creates the account with `oauth_client_ref=<uuid>`.
 *   2. state = "<8-hex>" matching an existing account id — Reauthorize.
 *      Uses the account's existing `oauth_client_ref` for the code exchange.
 *      Verifies the email matches and refuses with a hint if it doesn't.
 *   3. No state — legacy first-time link fallback. Uses the Default
 *      Outlook Connection. Logged as a deprecation hint.
 */
export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');
	const errorDesc = url.searchParams.get('error_description');
	const state = url.searchParams.get('state');

	if (error) {
		return redirect(302, `/inbox?error=${encodeURIComponent(errorDesc || error)}`);
	}

	if (!code) {
		return redirect(302, '/inbox?error=no_code');
	}

	const redirectUri = `${url.origin}/api/inbox/outlook/callback`;

	try {
		// ── Mode 2: Re-link existing account ──
		if (state && !state.startsWith('client:')) {
			const existing = getAccount(state);
			if (!existing) {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent('Account no longer exists')}`,
				);
			}
			if (existing.provider !== 'outlook') {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						`Account ${existing.id} is not an Outlook account`,
					)}`,
				);
			}
			const creds = resolveClientCredsForAccount(existing);
			const tokens = await exchangeOutlookCode(code, redirectUri, creds);
			const email = await getOutlookUserEmail(tokens.accessToken);

			if (existing.email !== email) {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						`Reauthorized with ${email} but account was ${existing.email}. Use the matching Microsoft account.`,
					)}`,
				);
			}

			const credential = JSON.stringify({
				type: 'outlook-oauth2',
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
			});
			updateAccountCredential(existing.id, credential);
			if (existing.oauthClientRef) touchOauthClientUsage(existing.oauthClientRef);
			stopAccountSync(existing.id);
			const refreshed = getAccount(existing.id);
			if (refreshed) startAccountSync(refreshed);
			return redirect(302, `/inbox?reauthorized=${encodeURIComponent(email)}`);
		}

		// ── Mode 1: First-time link via Connections client ──
		// state shape: "client:<uuid>"
		let clientRef: string | null = null;
		if (state && state.startsWith('client:')) {
			clientRef = state.slice('client:'.length);
		}

		if (!clientRef) {
			return redirect(
				302,
				`/inbox?error=${encodeURIComponent(
					'Missing OAuth client reference. Restart the Add Outlook flow.',
				)}`,
			);
		}

		const creds = resolveClientCredsByRef(clientRef); // throws if missing
		const tokens = await exchangeOutlookCode(code, redirectUri, creds);
		const email = await getOutlookUserEmail(tokens.accessToken);

		// Dedup on (outlook, email). Symmetric to the Gmail callback
		// (ADR 2026-05-11-multiple-gmail-accounts) — prevents the
		// duplicate-row + IDLE-storm pathology if the operator hits
		// "Sign in with Microsoft" again with an already-connected identity.
		const duplicate = listAccounts().find(
			(a) => a.provider === 'outlook' && a.email === email,
		);
		if (duplicate) {
			return redirect(
				302,
				`/inbox?error=${encodeURIComponent(
					`Outlook account ${email} is already connected. Use Reauthorize on the existing row if the tokens expired.`,
				)}`,
			);
		}

		const id = randomUUID().slice(0, 8);
		const credential = JSON.stringify({
			type: 'outlook-oauth2',
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
		});

		const account = addAccount(
			{ id, label: email, provider: 'outlook', email, host: 'outlook.office365.com', port: 993 },
			credential,
			clientRef,
		);
		touchOauthClientUsage(clientRef);
		startAccountSync(account);

		return redirect(302, '/inbox?added=outlook');
	} catch (err) {
		// Successful redirects in the try-block also land here.
		if (isRedirect(err)) throw err;
		const msg = err instanceof Error ? err.message : 'Outlook OAuth exchange failed';
		console.error('[inbox-outlook] Callback error:', msg);
		return redirect(302, `/inbox?error=${encodeURIComponent(msg)}`);
	}
};
