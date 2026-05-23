import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { emitArchiveZoneEscalations } from '$lib/vault-hygiene/inline-escalator.js';

/** POST /api/hygiene/escalate-buttons — ADR-042 pilot trigger.
 *
 *  Reads the latest project-hygiene digest, scans for
 *  `archive_zone_mismatch` rows, and sends one Telegram message per
 *  row with the inline keyboard from `callback.ts`. Manual trigger
 *  for the pilot; future hook lands in pass 2. Loopback-only — no
 *  auth, intended to be curl'd from localhost. */
export const POST: RequestHandler = async () => {
	try {
		const result = await emitArchiveZoneEscalations();
		const status = result.ok ? 200 : 500;
		return json(result, { status });
	} catch (err) {
		return json(
			{ ok: false, error: (err as Error).message ?? String(err) },
			{ status: 500 },
		);
	}
};
