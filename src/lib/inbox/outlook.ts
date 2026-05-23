/**
 * Outlook / Microsoft 365 integration via MS Graph API + OAuth2.
 *
 * Flow (mirrors Gmail in `oauth.ts`):
 *   1. User picks an OAuth client (Connections) and clicks "Sign in with Microsoft"
 *   2. /api/inbox/outlook?client=<uuid> builds the consent URL with that client's creds
 *   3. Microsoft redirects back with ?code=... → exchange for tokens
 *   4. Store encrypted { accessToken, refreshToken, expiresAt } in accounts table,
 *      with `oauth_client_ref` pointing at the chosen Connections row
 *   5. Sync worker reads credential + resolves the per-account client, refreshes if
 *      expired, connects with accessToken
 *
 * Authority is `/common`, which accepts both work/school (Microsoft 365)
 * AND personal Microsoft accounts (Outlook.com, Hotmail.com, Live.com).
 *
 * Required scopes: Mail.Read, User.Read, offline_access (refresh_token).
 *
 * Edge cases:
 *   - Refresh token: returned because `offline_access` is in scope. Tokens stay
 *     valid for 90 days of inactivity.
 *   - Personal vs work accounts → both supported via /common authority
 */

import type { ClientCreds } from './oauth.js';

const GRAPH_SCOPES = ['Mail.Read', 'User.Read', 'offline_access'];
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

export interface OutlookTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

/** Generate the Microsoft OAuth2 consent URL.
 *
 *  Built manually (not via MSAL) so the flow stays symmetric with the
 *  Gmail path in `oauth.ts:getAuthUrl` — same shape, same plumbing.
 *
 *  `state` threads through the round-trip — the callback uses it to
 *  distinguish first-time link (`client:<uuid>`) from Reauthorize
 *  (`<accountId>`). */
export function getOutlookAuthUrl(redirectUri: string, creds: ClientCreds, state?: string): string {
	const params = new URLSearchParams({
		client_id: creds.clientId,
		response_type: 'code',
		redirect_uri: redirectUri,
		response_mode: 'query',
		scope: GRAPH_SCOPES.join(' '),
		prompt: 'consent',
	});
	if (state) params.set('state', state);
	return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Exchange authorization code for tokens.
 *
 *  Uses the raw token endpoint so `refresh_token` is returned explicitly
 *  (MSAL's `acquireTokenByCode` stashes it in an in-process cache that
 *  doesn't survive a process restart). */
export async function exchangeOutlookCode(
	code: string,
	redirectUri: string,
	creds: ClientCreds,
): Promise<OutlookTokens> {
	const params = new URLSearchParams({
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		code,
		redirect_uri: redirectUri,
		grant_type: 'authorization_code',
		scope: GRAPH_SCOPES.join(' '),
	});

	const res = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
	});

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Outlook code exchange failed: ${res.status} ${err}`);
	}

	const data = await res.json();
	if (!data.access_token) {
		throw new Error('No access token received from Microsoft');
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token || '',
		expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
	};
}

/** Refresh an expired access token. */
export async function refreshOutlookToken(
	refreshToken: string,
	creds: ClientCreds,
): Promise<OutlookTokens> {
	const params = new URLSearchParams({
		client_id: creds.clientId,
		client_secret: creds.clientSecret,
		refresh_token: refreshToken,
		grant_type: 'refresh_token',
		scope: GRAPH_SCOPES.join(' '),
	});

	const res = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
	});

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Token refresh failed: ${res.status} ${err}`);
	}

	const data = await res.json();
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token || refreshToken,
		expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
	};
}

/** Check if tokens need refresh */
export function isOutlookTokenExpired(tokens: OutlookTokens): boolean {
	return Date.now() >= tokens.expiresAt - 5 * 60 * 1000;
}

/** Get a valid access token, refreshing if needed */
export async function getValidOutlookToken(
	tokens: OutlookTokens,
	creds: ClientCreds,
): Promise<OutlookTokens> {
	if (!isOutlookTokenExpired(tokens)) return tokens;
	return refreshOutlookToken(tokens.refreshToken, creds);
}

/** Fetch the Microsoft-authenticated user's email via Graph /me */
export async function getOutlookUserEmail(accessToken: string): Promise<string> {
	const res = await fetch(`${GRAPH_BASE}/me`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch user email: ${res.status}`);
	}
	const data = await res.json();
	return data.mail || data.userPrincipalName || 'outlook-user';
}

/** Fetch messages from a user's mailbox via delta query (initial sync) */
export interface GraphMessage {
	id: string;
	subject: string;
	from: { emailAddress: { address: string; name?: string } };
	receivedDateTime: string;
	bodyPreview: string;
	hasAttachments: boolean;
	isRead: boolean;
	isDraft: boolean;
	flag?: { flagStatus: string };
	// Richer fields graphToInboxMessage (sync.ts) maps for messageId/threadId/
	// toAddress/dateSent. Now in the delta `$select` below. Still optional:
	// Graph may omit empty ones, and an Outlook account whose deltaLink predates
	// this change keeps the old select until its next full re-sync.
	internetMessageId?: string;
	conversationId?: string;
	sentDateTime?: string;
	toRecipients?: { emailAddress: { address: string; name?: string } }[];
}

export interface OutlookDeltaResponse {
	value: GraphMessage[];
	'@odata.nextLink'?: string;
	'@odata.deltaLink'?: string;
}

export class DeltaExpiredError extends Error {
	constructor() {
		super('Delta link expired (>7 days)');
		this.name = 'DeltaExpiredError';
	}
}

/** Fetch messages using delta query.
 *  Pass deltaLink for incremental sync, or null for initial sync. */
export async function fetchMessagesDelta(
	accessToken: string,
	deltaLink: string | null = null,
): Promise<OutlookDeltaResponse> {
	const url = deltaLink || `${GRAPH_BASE}/me/messages/delta?$select=subject,from,receivedDateTime,bodyPreview,hasAttachments,isRead,isDraft,flag,internetMessageId,conversationId,toRecipients,sentDateTime&$top=50`;

	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (res.status === 410) {
		throw new DeltaExpiredError();
	}

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Failed to fetch messages: ${res.status} ${err}`);
	}

	return res.json();
}
