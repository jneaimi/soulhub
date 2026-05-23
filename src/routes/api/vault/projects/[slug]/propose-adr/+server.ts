/** POST /api/projects/:slug/propose-adr
 *
 *  project-phases ADR-005 S1 — orchestrator + HTTP surface for the
 *  proposeAdr tool. Thin wrapper around `applyProposeAdr` in
 *  `src/lib/projects/propose-adr.ts` — the same core function the
 *  orchestrator-v2 `proposeAdr` tool calls (S1 manifest entry).
 *
 *  Body: ProposeAdrInput (see schema in propose-adr.ts).
 *
 *  Returns: { success: true, path, ordinal, adr_slug, preview, ... }
 *  Errors:  400 invalid body / unresolved input;
 *           404 if the project's index.md is missing;
 *           409 on two consecutive ordinal collisions. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { applyProposeAdr } from '$lib/projects/propose-adr.js';
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

	// Force the URL's slug to win over any slug in the body — keeps the
	// route + payload aligned and prevents confusion on stale clients.
	const input =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? { ...(raw as Record<string, unknown>), slug }
			: { slug };

	// ADR-005 S4 — per-actor tool-level rate limit (5/hr, layered above
	// the ADR-046 chokepoint cap). `actor` mirrors what applyProposeAdr
	// stamps on engine.createNote: defaults to 'proposeAdr' unless the
	// caller passes a `source_agent` override.
	const actor =
		typeof (input as Record<string, unknown>).source_agent === 'string'
			? ((input as Record<string, unknown>).source_agent as string)
			: 'proposeAdr';
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

	const result = await applyProposeAdr(engine, input);
	const status = result.success ? 201 : (result.status_hint ?? 400);
	return json(result, { status });
};
