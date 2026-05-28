import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { installSeedRoster, listSeedIds } from '$lib/agents/seed-roster.js';
import { bumpStoreVersion } from '$lib/agents/store.js';

/** POST /api/agents/seed — install (or refresh) the built-in agent roster.
 *
 *  Idempotent: skips any seed whose Lane A `.md` file already exists, unless
 *  `?overwrite=true` is passed. With `overwrite=true`, only files whose
 *  frontmatter carries `provenance: builtin` (i.e. previously installed by
 *  Soul Hub) are refreshed — user-customised files are never clobbered. */
export const POST: RequestHandler = async ({ url }) => {
	const overwrite = url.searchParams.get('overwrite') === 'true';
	try {
		const result = installSeedRoster({ overwrite });
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
