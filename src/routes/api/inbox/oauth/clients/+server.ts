import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	listOauthClients, createOauthClient, countAccountsUsingOauthClient,
} from '$lib/inbox/index.js';
import type { InboxProvider } from '$lib/inbox/index.js';

/**
 * Connections API — first-class OAuth clients.
 * See ADR 2026-05-11-oauth-clients-as-first-class-connections.
 *
 * GET  /api/inbox/oauth/clients[?provider=gmail]
 *   List clients with masked client_id, default badge, account-usage count.
 *   Secrets are never echoed.
 *
 * POST /api/inbox/oauth/clients
 *   Body: { provider, label, clientId, clientSecret, isDefault? }
 *   Creates a new Connections row. Returns 409 if (provider, client_id) clashes.
 */

const VALID_PROVIDERS: InboxProvider[] = ['gmail', 'outlook'];

interface ClientDto {
	id: string;
	provider: InboxProvider;
	label: string;
	clientId: string;
	isDefault: boolean;
	accountCount: number;
	createdAt: number;
	lastUsedAt: number | null;
}

function toDto(row: ReturnType<typeof listOauthClients>[number]): ClientDto {
	return {
		id: row.id,
		provider: row.provider,
		label: row.label,
		clientId: row.clientId,
		isDefault: row.isDefault,
		accountCount: countAccountsUsingOauthClient(row.id),
		createdAt: row.createdAt,
		lastUsedAt: row.lastUsedAt,
	};
}

export const GET: RequestHandler = async ({ url }) => {
	const providerParam = url.searchParams.get('provider') as InboxProvider | null;
	if (providerParam && !VALID_PROVIDERS.includes(providerParam)) {
		return json({ error: `Invalid provider '${providerParam}'` }, { status: 400 });
	}
	const rows = listOauthClients(providerParam ?? undefined);
	return json({ clients: rows.map(toDto) });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: {
		provider?: string;
		label?: string;
		clientId?: string;
		clientSecret?: string;
		isDefault?: boolean;
	};
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const provider = (body.provider ?? '').trim() as InboxProvider;
	const label = (body.label ?? '').trim();
	const clientId = (body.clientId ?? '').trim();
	const clientSecret = (body.clientSecret ?? '').trim();

	if (!VALID_PROVIDERS.includes(provider)) {
		return json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` }, { status: 400 });
	}
	if (!label) return json({ error: 'label is required' }, { status: 400 });
	if (!clientId) return json({ error: 'clientId is required' }, { status: 400 });
	if (!clientSecret) return json({ error: 'clientSecret is required' }, { status: 400 });

	const existing = listOauthClients(provider);
	if (existing.some((c) => c.clientId === clientId)) {
		return json(
			{ error: `An OAuth client with this client_id already exists for ${provider}.` },
			{ status: 409 },
		);
	}
	if (existing.some((c) => c.label === label)) {
		return json(
			{ error: `An OAuth client labeled '${label}' already exists for ${provider}.` },
			{ status: 409 },
		);
	}

	const created = createOauthClient({ provider, label, clientId, clientSecret, isDefault: body.isDefault });
	return json({ client: toDto(created) }, { status: 201 });
};
