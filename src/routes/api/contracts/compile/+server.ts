/** POST /api/contracts/compile — soul-hub-governance ADR-002 (P2).
 *
 *  Recompile the on-disk contract cache from the vault registry note. Called by
 *  the falsifier task (heartbeat), by the registry note's vault-write event, and
 *  manually. GET returns the current self-check (resolution + freshness) for the
 *  /hygiene dashboard. Cross-site requests are rejected (same guard as
 *  /api/hygiene/remediate). */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { check, compile } from '$lib/contracts/registry.js';

function rejectCrossSite(request: Request): Response | null {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}
	return null;
}

export const POST: RequestHandler = async ({ request }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;
	try {
		const reg = compile();
		return json({ ok: true, compiledAt: reg.compiledAt, count: reg.contracts.length });
	} catch (e) {
		return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
	}
};

/** GET — current self-check, no recompile. */
export const GET: RequestHandler = async () => {
	try {
		return json({ ok: true, check: check() });
	} catch (e) {
		return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
	}
};
