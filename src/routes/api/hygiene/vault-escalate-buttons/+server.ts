import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { emitVaultHygieneEscalations } from '$lib/vault-hygiene/vault-escalator.js';

/** POST /api/hygiene/vault-escalate-buttons — ADR-043 pilot trigger.
 *
 *  Reads a fresh hygiene report and sends one Telegram message per
 *  `unresolved` (broken_link) anomaly with the inline keyboard from
 *  `callback.ts`. Manual trigger for the pilot; auto-trigger via the
 *  existing 30-min heartbeat-tick lands in pass 2. Loopback-only —
 *  no auth, intended to be curl'd from localhost. */
export const POST: RequestHandler = async () => {
	try {
		const result = await emitVaultHygieneEscalations();
		const status = result.ok ? 200 : 500;
		return json(result, { status });
	} catch (err) {
		return json(
			{ ok: false, error: (err as Error).message ?? String(err) },
			{ status: 500 },
		);
	}
};
