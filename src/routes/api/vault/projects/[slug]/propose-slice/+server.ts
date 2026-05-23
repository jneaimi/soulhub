/** POST /api/vault/projects/:slug/propose-slice
 *
 *  project-phases ADR-005 S2 — orchestrator + HTTP surface for the
 *  proposeSlice tool. Thin wrapper around `applyProposeSlice` in
 *  `src/lib/projects/propose-slice.ts` — the same core function the
 *  orchestrator-v2 `proposeSlice` tool calls.
 *
 *  Body: ProposeSliceInput (see schema in propose-slice.ts).
 *
 *  Returns: { success: true, path, slice_id, new_row, already_present? }
 *  Errors:  400 invalid body / unresolved adr;
 *           404 if the project's index.md is missing;
 *           422 if the ADR has no `## Implementation plan` table. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { applyProposeSlice } from '$lib/projects/propose-slice.js';
import { checkProposeRate } from '$lib/projects/propose-rate-limit.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const slug = params.slug;
	if (!slug) return json({ success: false, error: 'slug required' }, { status: 400 });

	const engine = getVaultEngine();
	if (!engine) return json({ success: false, error: 'Vault not initialized' }, { status: 503 });

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	// URL's slug wins over any slug in the body.
	const input =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? { ...(raw as Record<string, unknown>), slug }
			: { slug };

	// ADR-005 S4 — per-actor tool-level rate limit.
	const actor =
		typeof (input as Record<string, unknown>).source_agent === 'string'
			? ((input as Record<string, unknown>).source_agent as string)
			: 'proposeSlice';
	const rate = checkProposeRate(actor);
	if (!rate.allowed) {
		return json(
			{
				success: false,
				error: `Rate limit exceeded for "${actor}" — max ${rate.ceiling} proposals/hour. Resets at ${rate.resetAt}.`,
				status_hint: 429,
				rate_limit: rate,
			},
			{ status: 429 },
		);
	}

	const result = await applyProposeSlice(engine, input);
	const status = result.success ? 200 : (result.status_hint ?? 400);
	return json(result, { status });
};
