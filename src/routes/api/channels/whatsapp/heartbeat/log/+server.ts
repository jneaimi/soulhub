/** GET /api/channels/whatsapp/heartbeat/log?limit=10 — recent audit
 *  entries for the Settings UI panel. Mirrors the `/heartbeat status`
 *  slash command's tail but with structured fields so the UI can render
 *  status badges, model labels, and tooltips. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { recentHeartbeatLog } from '$lib/channels/whatsapp/index.js';

export const GET: RequestHandler = async ({ url }) => {
	const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10));
	const entries = recentHeartbeatLog(limit);
	return json({ ok: true, entries });
};
