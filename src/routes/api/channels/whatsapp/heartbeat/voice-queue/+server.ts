/** GET /api/channels/whatsapp/heartbeat/voice-queue — read-only preview
 *  of what the heartbeat tick would surface right now (per ADR-003).
 *
 *  Returns the same list the heartbeat consumer fetches inside
 *  `runHeartbeatOnce`, so the user can verify producer flagging and
 *  due-date logic without firing a real WhatsApp message. Vault-Scout
 *  (Phase 7, ADR-007) will also use this surface to sanity-check what
 *  it just queued. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getEligibleVoiceItems } from '$lib/vault/voice-queue.js';

export const GET: RequestHandler = async () => {
	const items = getEligibleVoiceItems({ limit: 50 });
	return json({
		count: items.length,
		items: items.map((i) => ({
			notePath: i.notePath,
			title: i.title,
			summary: i.summary,
			priority: i.priority,
			dueAt: i.dueAt?.toISOString() ?? null,
			createdAt: i.createdAt?.toISOString() ?? null,
		})),
	});
};
