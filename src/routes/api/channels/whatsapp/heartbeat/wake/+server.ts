/** POST /api/channels/whatsapp/heartbeat/wake — manual heartbeat trigger
 *  for the Settings UI "Run now" button. Equivalent to the `/heartbeat now`
 *  WhatsApp slash command but reachable from the browser. Skips
 *  active-hours/mute gates (manual source) but still respects the daily
 *  cap to prevent abuse. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { triggerHeartbeat } from '$lib/channels/whatsapp/index.js';

export const POST: RequestHandler = async () => {
	const result = await triggerHeartbeat();
	return json({ ok: true, status: result.status, text: result.text });
};
