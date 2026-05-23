/**
 * OAuth2 helpers for Gmail IMAP access.
 *
 * Flow:
 *   1. User picks an OAuth client (Connections) and clicks "Sign in with Google"
 *   2. /api/inbox/oauth?client=<uuid> builds the consent URL with that client's creds
 *   3. Google redirects back with ?code=... → exchange for tokens
 *   4. Store encrypted { accessToken, refreshToken, expiresAt } in accounts table,
 *      with `oauth_client_ref` pointing at the chosen Connections row
 *   5. Sync worker reads credential + resolves the per-account client, refreshes if
 *      expired, connects with accessToken
 *
 * Client identity resolution: every flow takes an explicit ClientCreds object.
 * See `src/lib/inbox/db.ts` for `getOauthClient`, `getDefaultOauthClient`, and
 * `listOauthClients`. The platform-env `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
 * are read ONCE by migration #5 to seed the Default Connections row, then never
 * again at runtime.
 *
 * Required scope: https://mail.google.com/ (NOT gmail.readonly — won't work for IMAP)
 *
 * See ADR 2026-05-11-oauth-clients-as-first-class-connections.
 */

import { OAuth2Client } from 'google-auth-library';
import { decrypt } from './crypto.js';
import { getOauthClient, getDefaultOauthClient } from './db.js';

// `mail.google.com` is the restricted IMAP/SMTP scope. `openid` + `userinfo.email`
// are needed so the OAuth callback can call /oauth2/v2/userinfo to discover the
// authenticated user's address — without these the callback falls back to the
// literal string "gmail-user", which then breaks XOAUTH2 IMAP auth.
const GMAIL_SCOPES = [
	'https://mail.google.com/',
	'openid',
	'https://www.googleapis.com/auth/userinfo.email',
];

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // unix ms
}

export interface ClientCreds {
	clientId: string;
	clientSecret: string;
}

/**
 * Resolve ClientCreds for a stored OAuth client (Connections row) by id.
 * Throws if the row is missing — callers should validate the ref before
 * invoking flow steps.
 */
export function resolveClientCredsByRef(clientRef: string): ClientCreds {
	const client = getOauthClient(clientRef);
	if (!client) {
		throw new Error(`oauth_clients row not found: ${clientRef}`);
	}
	return {
		clientId: client.clientId,
		clientSecret: decrypt(client.clientSecretEncrypted),
	};
}

/**
 * Resolve ClientCreds for an account. Uses the account's `oauthClientRef` if
 * set; otherwise falls back to the provider's Default Connections row.
 * Throws with an operator-actionable message if neither is available.
 */
export function resolveClientCredsForAccount(account: {
	oauthClientRef: string | null;
	provider: string;
}): ClientCreds {
	if (account.oauthClientRef) {
		return resolveClientCredsByRef(account.oauthClientRef);
	}
	const def = getDefaultOauthClient(account.provider as 'gmail' | 'outlook' | 'icloud' | 'imap');
	if (!def) {
		throw new Error(
			`No OAuth client configured for provider '${account.provider}'. Add one via Settings → Connections.`,
		);
	}
	return {
		clientId: def.clientId,
		clientSecret: decrypt(def.clientSecretEncrypted),
	};
}

function createClient(redirectUri: string, creds: ClientCreds): OAuth2Client {
	return new OAuth2Client(creds.clientId, creds.clientSecret, redirectUri);
}

/** Generate the Google OAuth2 consent URL */
export function getAuthUrl(redirectUri: string, creds: ClientCreds, state?: string): string {
	const client = createClient(redirectUri, creds);
	return client.generateAuthUrl({
		access_type: 'offline', // get refresh token
		prompt: 'consent', // force consent to always get refresh token
		scope: GMAIL_SCOPES,
		state,
	});
}

/** Exchange authorization code for tokens */
export async function exchangeCode(
	code: string,
	redirectUri: string,
	creds: ClientCreds,
): Promise<OAuthTokens> {
	const client = createClient(redirectUri, creds);
	const { tokens } = await client.getToken(code);

	if (!tokens.access_token) {
		throw new Error('No access token received from Google');
	}
	if (!tokens.refresh_token) {
		throw new Error('No refresh token received. Ensure access_type=offline and prompt=consent');
	}

	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: tokens.expiry_date || (Date.now() + 3600_000), // default 1h if not provided
	};
}

/** Refresh an expired access token using the refresh token */
export async function refreshAccessToken(
	refreshToken: string,
	creds: ClientCreds,
): Promise<OAuthTokens> {
	const client = new OAuth2Client(creds.clientId, creds.clientSecret);
	client.setCredentials({ refresh_token: refreshToken });

	const { credentials } = await client.refreshAccessToken();

	if (!credentials.access_token) {
		throw new Error('Failed to refresh access token');
	}

	return {
		accessToken: credentials.access_token,
		refreshToken: credentials.refresh_token || refreshToken, // Google may not return a new refresh token
		expiresAt: credentials.expiry_date || (Date.now() + 3600_000),
	};
}

/** Check if tokens need refresh (expired or expiring within 5 min) */
export function isTokenExpired(tokens: OAuthTokens): boolean {
	return Date.now() >= tokens.expiresAt - 5 * 60 * 1000; // 5 min buffer
}

/** Get a valid access token, refreshing if needed. Returns updated tokens. */
export async function getValidToken(
	tokens: OAuthTokens,
	creds: ClientCreds,
): Promise<OAuthTokens> {
	if (!isTokenExpired(tokens)) {
		return tokens;
	}
	return refreshAccessToken(tokens.refreshToken, creds);
}
