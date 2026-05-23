/**
 * /api/crm/contacts/[id]/interactions — list + append.
 *
 *   GET    ?limit=50            → newest-first interaction log
 *   POST   { channel, summary, timestamp?, direction?, messageId? }
 *                                → addInteraction (touches last_interaction_at)
 *
 * Read-only history surface for the Stage E detail panel. Does NOT trigger
 * vault-sync — interactions don't surface in managed frontmatter (only the
 * `last_interaction_at` field does, and the DB write already updated it).
 *
 * Stage D consumer. ADR §D2.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getContact,
	addInteraction,
	listInteractions,
	type InteractionChannel,
	type InteractionDirection,
} from '$lib/crm/index.js';

const ALLOWED_CHANNELS: InteractionChannel[] = ['email', 'call', 'meeting', 'social', 'whatsapp', 'other'];
const ALLOWED_DIRECTIONS: InteractionDirection[] = ['inbound', 'outbound'];

export const GET: RequestHandler = async ({ params, url }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });
	if (!getContact(contactId)) {
		return json({ error: `Contact ${contactId} not found` }, { status: 404 });
	}

	const limitRaw = url.searchParams.get('limit');
	const parsed = limitRaw ? Number(limitRaw) : 50;
	const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.round(parsed))) : 50;

	const interactions = listInteractions(contactId, limit);
	return json({ contactId, interactions });
};

export const POST: RequestHandler = async ({ params, request }) => {
	const contactId = params.id;
	if (!contactId) return json({ error: 'contact id required' }, { status: 400 });
	if (!getContact(contactId)) {
		return json({ error: `Contact ${contactId} not found` }, { status: 404 });
	}

	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	if (typeof body.channel !== 'string' || !ALLOWED_CHANNELS.includes(body.channel as InteractionChannel)) {
		return json({ error: `channel must be one of ${ALLOWED_CHANNELS.join(', ')}` }, { status: 400 });
	}
	if (typeof body.summary !== 'string' || body.summary.trim().length === 0) {
		return json({ error: 'summary required (non-empty string)' }, { status: 400 });
	}
	const direction = body.direction;
	if (direction !== undefined && (typeof direction !== 'string' || !ALLOWED_DIRECTIONS.includes(direction as InteractionDirection))) {
		return json({ error: `direction must be one of ${ALLOWED_DIRECTIONS.join(', ')}` }, { status: 400 });
	}
	const timestamp = body.timestamp;
	if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(timestamp))) {
		return json({ error: 'timestamp must be epoch milliseconds (number)' }, { status: 400 });
	}
	const messageId = body.messageId;
	if (messageId !== undefined && messageId !== null && (typeof messageId !== 'number' || !Number.isFinite(messageId))) {
		return json({ error: 'messageId must be a number or null' }, { status: 400 });
	}

	const interaction = addInteraction({
		contactId,
		channel: body.channel as InteractionChannel,
		direction: (direction as InteractionDirection | undefined),
		summary: body.summary.trim(),
		timestamp: timestamp as number | undefined,
		messageId: messageId as number | null | undefined,
	});

	return json(interaction, { status: 201 });
};
