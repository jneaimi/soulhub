import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVaultEngine } from '$lib/vault/index.js';

/** GET /api/vault/health — Vault health report */
export const GET: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	try {
		const health = await engine.getHealth();
		const violations = engine.getGovernanceViolations();
		return json({ ...health, violations, violationCount: violations.length });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
