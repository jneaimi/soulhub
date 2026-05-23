import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getChannelConfig, triggerLogin } from '$lib/channels/whatsapp/index.js';

/** POST /api/channels/whatsapp/login — kick off the QR flow.
 *
 *  Idempotent: calling while already connecting/connected just returns
 *  the current status. Forwards to the worker process when worker mode
 *  is on; otherwise starts the in-process Baileys socket. The client
 *  polls GET /status to pick up the QR data URL and the eventual
 *  `connected` transition. */
export const POST: RequestHandler = async () => {
	const cfg = getChannelConfig();
	if (!cfg) {
		return json(
			{ ok: false, error: 'WhatsApp channel not present in settings.json — add channels.whatsapp.' },
			{ status: 400 },
		);
	}

	try {
		const { status, mode } = await triggerLogin();
		return json({ ok: true, mode, status });
	} catch (err) {
		return json(
			{ ok: false, error: (err as Error).message },
			{ status: 502 },
		);
	}
};
