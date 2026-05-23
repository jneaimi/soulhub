import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { tickVaultHygiene } from '$lib/vault-hygiene/index.js';

/** POST /api/vault/hygiene/tick — manually fire a hygiene tick.
 *  Identical behaviour to the heartbeat-driven tick: builds the report,
 *  writes the compat shim, dispatches keeper if actionable. Returns the
 *  tick result so an operator (or smoke test) can inspect the decision. */
export const POST: RequestHandler = async () => {
	const result = await tickVaultHygiene();
	return json(result);
};
