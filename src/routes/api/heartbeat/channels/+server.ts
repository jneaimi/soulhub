/** GET /api/heartbeat/channels — ids of every registered heartbeat delivery
 *  channel (ADR-001 P3). Powers the `delivery.channel` selector in the
 *  Heartbeat settings section. Today only `whatsapp` registers an adapter;
 *  more appear here automatically as their adapters land. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listHeartbeatChannelIds } from '$lib/heartbeat/channel.js';

export const GET: RequestHandler = async () => {
	return json({ ok: true, channels: listHeartbeatChannelIds() });
};
