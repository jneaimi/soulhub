/** POST /api/vault/projects/:slug/ship-slice
 *
 *  Atomic ship-slice mutation per project-phases ADR-003. Thin HTTP wrapper
 *  around `applyShipSlice` in `src/lib/projects/ship-slice.ts` — the same
 *  core function the orchestrator-v2 `projectShipSlice` tool calls (ADR-003
 *  S3). See the core function's docstring for the full atomicity contract.
 *
 *  Query params:
 *    ?dry-run=true  Return the computed preview without writing. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';
import { ShipSliceRequestSchema, applyShipSlice } from '$lib/projects/ship-slice.js';

export const POST: RequestHandler = async ({ params, request, url }) => {
	const slug = params.slug;
	if (!slug) return json({ error: 'slug required' }, { status: 400 });

	const engine = getVaultEngine();
	if (!engine) return json({ error: 'Vault not initialized' }, { status: 503 });

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = ShipSliceRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return json(
			{
				success: false,
				error: 'invalid request body',
				issues: parsed.error.issues.map((i) => ({
					path: i.path.join('.'),
					message: i.message,
				})),
			},
			{ status: 400 },
		);
	}

	const dryRun = url.searchParams.get('dry-run') === 'true';
	const result = await applyShipSlice(engine, slug, parsed.data, { dryRun });

	const status = result.status_hint ?? (result.success ? 200 : 500);
	const body: Record<string, unknown> = {
		success: result.success,
		applied: result.applied,
		preview: result.preview,
	};
	if (dryRun) body.dry_run = true;
	if (result.error) body.error = result.error;
	if (result.field) body.field = result.field;
	if (result.rollback_attempted) body.rollback_attempted = result.rollback_attempted;
	if (result.rollback_attempted) body.rollback_ok = result.rollback_ok;

	return json(body, { status });
};
