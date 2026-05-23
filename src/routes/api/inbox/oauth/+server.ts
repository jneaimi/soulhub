import type { RequestHandler } from './$types';
import { isRedirect, json, redirect } from '@sveltejs/kit';
import { getAuthUrl, resolveClientCredsByRef, resolveClientCredsForAccount } from '$lib/inbox/oauth.js';
import { getAccount, getOauthClient, getDefaultOauthClient } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/oauth — start Gmail OAuth2 flow
 *
 * Two modes:
 *
 *   1. ?client=<uuid> — first-time link with the named Connections client.
 *      State becomes `client:<uuid>`. If the client ref doesn't exist, 400.
 *      If neither client nor account is provided, falls back to the provider's
 *      Default Connections row (legacy single-client case).
 *
 *   2. ?account=<id> — re-link an existing account (Reauthorize). State
 *      becomes the account id. The account's `oauthClientRef` resolves the
 *      consent client.
 *
 * See ADR 2026-05-11-oauth-clients-as-first-class-connections.
 */
export const GET: RequestHandler = async ({ url }) => {
	const origin = url.origin;
	const redirectUri = `${origin}/api/inbox/oauth/callback`;
	const accountId = url.searchParams.get('account') || undefined;
	const clientRef = url.searchParams.get('client') || undefined;

	try {
		if (accountId) {
			const account = getAccount(accountId);
			if (!account) {
				return json({ error: 'Account not found' }, { status: 404 });
			}
			const creds = resolveClientCredsForAccount(account);
			const authUrl = getAuthUrl(redirectUri, creds, accountId);
			return redirect(302, authUrl);
		}

		// First-time link: explicit client ref, or fall back to Default.
		let chosenRef = clientRef;
		if (!chosenRef) {
			const def = getDefaultOauthClient('gmail');
			if (!def) {
				return json(
					{ error: 'No Gmail OAuth client configured. Add one via Settings → Connections.' },
					{ status: 412 },
				);
			}
			chosenRef = def.id;
		} else {
			const row = getOauthClient(chosenRef);
			if (!row) {
				return json({ error: `OAuth client not found: ${chosenRef}` }, { status: 404 });
			}
		}

		const creds = resolveClientCredsByRef(chosenRef);
		const authUrl = getAuthUrl(redirectUri, creds, `client:${chosenRef}`);
		return redirect(302, authUrl);
	} catch (err) {
		// SvelteKit's redirect() throws a Redirect sentinel — let it through.
		if (isRedirect(err)) throw err;
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to start OAuth flow' },
			{ status: 500 },
		);
	}
};
