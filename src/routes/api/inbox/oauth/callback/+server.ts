import type { RequestHandler } from './$types';
import { isRedirect, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import {
	exchangeCode, resolveClientCredsByRef, resolveClientCredsForAccount,
} from '$lib/inbox/oauth.js';
import {
	addAccount,
	getAccount,
	listAccounts,
	startAccountSync,
	stopAccountSync,
	updateAccountCredential,
	touchOauthClientUsage,
} from '$lib/inbox/index.js';

/**
 * GET /api/inbox/oauth/callback — Google OAuth2 callback
 *
 * Two modes, distinguished by the `state` query param:
 *
 *   1. state = "client:<uuid>" — first-time link with a named Connections
 *      client. The callback resolves the client by ref, exchanges the code,
 *      dedups by (provider, email), and creates the account with
 *      `oauth_client_ref=<uuid>`.
 *
 *   2. state = "<8-hex>" matching an existing account id — Reauthorize. The
 *      account's existing `oauth_client_ref` is used to resolve creds for the
 *      code exchange.
 *
 * See ADR 2026-05-11-oauth-clients-as-first-class-connections.
 */
export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	const error = url.searchParams.get('error');
	const state = url.searchParams.get('state');

	if (error) {
		return redirect(302, `/inbox?error=${encodeURIComponent(error)}`);
	}
	if (!code) {
		return redirect(302, '/inbox?error=no_code');
	}
	if (!state) {
		return redirect(
			302,
			`/inbox?error=${encodeURIComponent('Missing state in OAuth callback')}`,
		);
	}

	const origin = url.origin;
	const redirectUri = `${origin}/api/inbox/oauth/callback`;

	try {
		// ── Mode 1: First-time link via Connections client ──
		if (state.startsWith('client:')) {
			const clientRef = state.slice('client:'.length);
			const creds = resolveClientCredsByRef(clientRef); // throws if missing

			const tokens = await exchangeCode(code, redirectUri, creds);
			const email = await fetchUserEmail(tokens.accessToken);

			const duplicate = listAccounts().find(
				(a) => a.provider === 'gmail' && a.email === email,
			);
			if (duplicate) {
				return redirect(
					302,
					`/inbox?error=${encodeURIComponent(
						`Gmail account ${email} is already connected. Use Reauthorize on the existing row if the tokens expired.`,
					)}`,
				);
			}

			const credential = JSON.stringify({
				type: 'oauth2',
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
			});

			const id = randomUUID().slice(0, 8);
			const account = addAccount(
				{ id, label: email, provider: 'gmail', email, host: 'imap.gmail.com', port: 993 },
				credential,
				clientRef,
			);
			touchOauthClientUsage(clientRef);
			startAccountSync(account);
			return redirect(302, '/inbox?added=gmail');
		}

		// ── Mode 2: Re-link existing account ──
		const existing = getAccount(state);
		if (!existing) {
			return redirect(302, `/inbox?error=${encodeURIComponent('Account no longer exists')}`);
		}
		const creds = resolveClientCredsForAccount(existing);
		const tokens = await exchangeCode(code, redirectUri, creds);
		const email = await fetchUserEmail(tokens.accessToken);

		if (existing.email !== email) {
			return redirect(
				302,
				`/inbox?error=${encodeURIComponent(
					`Reauthorized with ${email} but account was ${existing.email}. Use the matching Google account.`,
				)}`,
			);
		}

		const credential = JSON.stringify({
			type: 'oauth2',
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
	} catch (err) {
		// Successful redirects in the try-block also land here.
		if (isRedirect(err)) throw err;
		const msg = err instanceof Error ? err.message : 'OAuth exchange failed';
		console.error('[inbox-oauth] Callback error:', msg);
		return redirect(302, `/inbox?error=${encodeURIComponent(msg)}`);
	}
};

/**
 * Fetch the Google-authenticated user's email via the userinfo endpoint.
 * Requires openid + userinfo.email scopes (configured in oauth.ts).
 * Falls back to "gmail-user" on failure — same behavior as before.
 */
async function fetchUserEmail(accessToken: string): Promise<string> {
	try {
		const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (res.ok) {
			const userInfo = await res.json();
			return userInfo.email || 'gmail-user';
		}
	} catch {
		/* fall through */
	}
	return 'gmail-user';
}
