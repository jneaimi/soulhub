import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getResolvedStatus, triggerLogout } from '$lib/channels/whatsapp/index.js';

/** POST /api/channels/whatsapp/logout — tear down the socket and remove
 *  on-disk auth so the next /login starts a fresh QR flow.
 *
 *  Body: { wipeAuth?: boolean }   — defaults to true; pass false to keep
 *                                    creds on disk for a soft disconnect.
 *
 *  Worker mode forwards the call to the worker; in-process tears down
 *  the local Baileys socket. */
export const POST: RequestHandler = async ({ request }) => {
	let body: { wipeAuth?: boolean } = {};
	try {
		body = (await request.json()) as { wipeAuth?: boolean };
	} catch {
		body = {};
	}
	const wipeAuth = body.wipeAuth !== false;

	try {
		const { mode } = await triggerLogout(wipeAuth);
		const { status } = await getResolvedStatus();
		return json({ ok: true, mode, status });
	} catch (err) {
		return json(
			{ ok: false, error: (err as Error).message },
			{ status: 502 },
		);
	}
};
