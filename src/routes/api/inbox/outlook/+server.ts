import type { RequestHandler } from './$types';
import { isRedirect, json, redirect } from '@sveltejs/kit';
import { getOutlookAuthUrl } from '$lib/inbox/outlook.js';
import {
	getAccount,
	getOauthClient,
	getDefaultOauthClient,
} from '$lib/inbox/index.js';
import {
	resolveClientCredsByRef,
	resolveClientCredsForAccount,
} from '$lib/inbox/oauth.js';

/**
 * GET /api/inbox/outlook — start Outlook OAuth2 flow
 *
 * Three modes (mirroring the Gmail handler at /api/inbox/oauth):
 *
 *   1. ?client=<uuid> — first-time link with the named Connections client.
 *      State becomes `client:<uuid>`. If the client ref doesn't exist, 404.
 *   2. ?account=<id> — re-link an existing account (Reauthorize). State
 *      becomes the account id; the account's `oauthClientRef` resolves
 *      the consent client.
 *   3. No params — falls back to the provider's Default Connections row
 *      (legacy single-client case). State becomes `client:<default-id>`.
 */
export const GET: RequestHandler = async ({ url }) => {
	const redirectUri = `${url.origin}/api/inbox/outlook/callback`;
	const accountId = url.searchParams.get('account') || undefined;
	const clientRef = url.searchParams.get('client') || undefined;

	try {
		// ── Mode 2: Re-link existing account ──
		if (accountId) {
			const account = getAccount(accountId);
			if (!account) {
				return json({ error: 'Account not found' }, { status: 404 });
			}
			if (account.provider !== 'outlook') {
				return json(
					{ error: `Account ${accountId} is not an Outlook account` },
					{ status: 400 },
				);
			}
			const creds = resolveClientCredsForAccount(account);
			const authUrl = getOutlookAuthUrl(redirectUri, creds, accountId);
			return redirect(302, authUrl);
		}

		// ── Mode 1: First-time link with explicit Connection ──
		// ── Mode 3: First-time link with Default Connection ──
		let chosenRef = clientRef;
		if (!chosenRef) {
			const def = getDefaultOauthClient('outlook');
			if (!def) {
				return json(
					{ error: 'No Outlook OAuth client configured. Add one via Settings → Connections.' },
					{ status: 412 },
				);
			}
			chosenRef = def.id;
		} else {
			const row = getOauthClient(chosenRef);
			if (!row) {
				return json({ error: `OAuth client not found: ${chosenRef}` }, { status: 404 });
			}
			if (row.provider !== 'outlook') {
				return json(
					{ error: `OAuth client ${chosenRef} is not an Outlook client` },
					{ status: 400 },
				);
			}
		}

		const creds = resolveClientCredsByRef(chosenRef);
		const authUrl = getOutlookAuthUrl(redirectUri, creds, `client:${chosenRef}`);
		return redirect(302, authUrl);
	} catch (err) {
		// SvelteKit's redirect() throws a Redirect sentinel — let it through.
		if (isRedirect(err)) throw err;
		return json(
			{ error: err instanceof Error ? err.message : 'Failed to start Outlook OAuth flow' },
			{ status: 500 },
		);
	}
};
