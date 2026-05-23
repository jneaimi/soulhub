/** GET /api/channels/whatsapp/heartbeat/status — runtime snapshot for the
 *  Settings UI status line. Returns whether the heartbeat would fire right
 *  now (active hours + mute) and how the daily cap stands, plus the vault
 *  paths the card deep-links to. Cheap: no LLM, no DB writes, one daily
 *  counter read. Safe to poll. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getHeartbeatRuntimeStatus } from '$lib/channels/whatsapp/index.js';

export const GET: RequestHandler = async () => {
	const status = getHeartbeatRuntimeStatus();
	if (!status) return json({ ok: false, error: 'WhatsApp config invalid' }, { status: 400 });
	return json({ ok: true, ...status });
};
