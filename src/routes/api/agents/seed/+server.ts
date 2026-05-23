import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { installSeedRoster, listSeedIds } from '$lib/agents/seed-roster.js';
import { bumpStoreVersion } from '$lib/agents/store.js';

/** POST /api/agents/seed — install the 10-agent starter roster.
 *
 *  Idempotent: skips any seed whose Lane A `.md` file already exists. Safe
 *  to call repeatedly; safe on machines that already have files of these
 *  names — no clobbering. */
export const POST: RequestHandler = async () => {
	try {
		const result = installSeedRoster();
		bumpStoreVersion();
		return json(result);
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};

/** GET /api/agents/seed — preview which seeds will be installed. */
export const GET: RequestHandler = async () => {
	return json({ seeds: listSeedIds() });
};
