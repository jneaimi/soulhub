import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getDefaultOauthClient, listOauthClients } from '$lib/inbox/index.js';

/**
 * GET /api/inbox/oauth/status — is Gmail OAuth configured?
 *
 * After ADR 2026-05-11-oauth-clients-as-first-class-connections, "configured"
 * means at least one Connections row exists for Gmail. `defaultConfigured`
 * reports whether one of them is marked default — the UI surfaces a hint when
 * clients exist but none is default (rare; mostly a post-deletion state).
 *
 * The endpoint never echoes secrets; only counts and redirect URI.
 */
export const GET: RequestHandler = async ({ url }) => {
	const gmailClients = listOauthClients('gmail');
	const defaultClient = getDefaultOauthClient('gmail');
	return json({
		configured: gmailClients.length > 0,
		clientCount: gmailClients.length,
		defaultConfigured: defaultClient !== null,
		redirectUri: `${url.origin}/api/inbox/oauth/callback`,
	});
};
