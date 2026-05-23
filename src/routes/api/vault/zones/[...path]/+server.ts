import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/**
 * GET /api/vault/zones/<zone-path>
 *
 * Returns the governance rules for a zone as parsed from the nearest
 * CLAUDE.md in the zone's path hierarchy. Pure read — no engine state change.
 *
 * Introduced in Soul Hub's Phase 3 vault-integration work so external writers
 * (Katib, playbook bridge, scripts) can validate a proposed write *before*
 * constructing it — fail fast instead of after the fact.
 *
 * Response shape:
 *   {
 *     "zone": "projects/ils-offers/outputs",
 *     "resolvedFrom": "projects",          // which parent governance actually applied
 *     "allowedTypes": ["output", "index", ...],
 *     "requiredFields": ["type", "created", "tags", "project"],
 *     "namingPattern": "^\\d{4}-\\d{2}-\\d{2}-" | null,
 *     "requireTemplate": false
 *   }
 *
 * rawGovernance (the raw CLAUDE.md text) is intentionally omitted — clients
 * only need the parsed rules.
 */
export const GET: RequestHandler = async ({ params }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const zonePath = params.path ?? '';

	// Same input validation the POST handler uses — no traversal, no NUL bytes
	if (zonePath.includes('..') || zonePath.includes('\0')) {
		return json({ error: 'Invalid zone path' }, { status: 400 });
	}
	if (zonePath && !/^[\w\-./]+$/.test(zonePath)) {
		return json({ error: 'Invalid zone path' }, { status: 400 });
	}

	const zone = engine.resolveZone(zonePath);
	return json({
		zone: zonePath,
		resolvedFrom: zone.path,
		allowedTypes: zone.allowedTypes,
		requiredFields: zone.requiredFields,
		namingPattern: zone.namingPattern ?? null,
		requireTemplate: zone.requireTemplate,
	});
};
