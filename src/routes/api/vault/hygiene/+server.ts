import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getHygieneReport } from '$lib/vault-hygiene/index.js';

/** GET /api/vault/hygiene — single source of truth for vault health.
 *  Consumed by the heartbeat hook and the keeper agent prompt. Loopback-only
 *  in production (no auth — keeper curls localhost:2400). */
export const GET: RequestHandler = async () => {
	try {
		const report = await getHygieneReport();
		return json(report);
	} catch (err) {
		const message = (err as Error).message;
		const status = message.includes('not initialized') ? 503 : 500;
		return json({ error: message }, { status });
	}
};
