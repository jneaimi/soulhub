import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getOauthClient, updateOauthClient, deleteOauthClient, countAccountsUsingOauthClient,
	listOauthClients,
} from '$lib/inbox/index.js';

/**
 * PATCH /api/inbox/oauth/clients/[id]
 *   Body: { label?, clientSecret?, isDefault? }
 *   `client_id` is immutable — to change it, create a new row and reassign accounts.
 *
 * DELETE /api/inbox/oauth/clients/[id]
 *   Refuses with 409 if any account references this client.
 */

export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = params.id;
	if (!id) return json({ error: 'id required' }, { status: 400 });

	const existing = getOauthClient(id);
	if (!existing) return json({ error: 'Not found' }, { status: 404 });

	let body: { label?: string; clientSecret?: string; isDefault?: boolean };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const patch: { label?: string; clientSecret?: string; isDefault?: boolean } = {};

	if (body.label !== undefined) {
		const label = body.label.trim();
		if (!label) return json({ error: 'label cannot be empty' }, { status: 400 });
		// Uniqueness within provider (excluding self).
		const clash = listOauthClients(existing.provider).some((c) => c.id !== id && c.label === label);
		if (clash) {
			return json(
				{ error: `An OAuth client labeled '${label}' already exists for ${existing.provider}.` },
				{ status: 409 },
			);
		}
		patch.label = label;
	}
	if (body.clientSecret !== undefined) {
		const secret = body.clientSecret.trim();
		if (!secret) return json({ error: 'clientSecret cannot be empty' }, { status: 400 });
		patch.clientSecret = secret;
	}
	if (body.isDefault !== undefined) {
		patch.isDefault = body.isDefault;
	}

	const changed = updateOauthClient(id, patch);
	if (!changed) return json({ error: 'No-op (no fields to update)' }, { status: 400 });

	const after = getOauthClient(id);
	if (!after) return json({ error: 'Updated row vanished' }, { status: 500 });

	return json({
		client: {
			id: after.id,
			provider: after.provider,
			label: after.label,
			clientId: after.clientId,
			isDefault: after.isDefault,
			accountCount: countAccountsUsingOauthClient(after.id),
			createdAt: after.createdAt,
			lastUsedAt: after.lastUsedAt,
		},
	});
};

export const DELETE: RequestHandler = async ({ params }) => {
	const id = params.id;
	if (!id) return json({ error: 'id required' }, { status: 400 });

	const result = deleteOauthClient(id);
	if (result.deleted) return json({ deleted: true });
	if (result.reason === 'not_found') return json({ error: 'Not found' }, { status: 404 });
	if (result.reason === 'in_use') {
		return json(
			{
				error: `Cannot delete: ${result.accountCount} account${result.accountCount === 1 ? '' : 's'} still using this OAuth client. Reassign or remove the account${result.accountCount === 1 ? '' : 's'} first.`,
				accountCount: result.accountCount,
			},
			{ status: 409 },
		);
	}
	return json({ error: 'Unknown error' }, { status: 500 });
};
