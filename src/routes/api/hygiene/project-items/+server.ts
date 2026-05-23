import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getProjectHygieneRows } from '$lib/vault-hygiene/inline-escalator.js';

/** GET /api/hygiene/project-items — actionable project-hygiene anomalies for
 *  the /hygiene dashboard (soul-hub-hygiene ADR-005 "2b").
 *
 *  Project-hygiene findings live only in the weekly inbox digest (no engine
 *  API), so this parses the latest digest into structured rows. The dashboard
 *  renders them with bucket-appropriate actions that POST to
 *  /api/hygiene/project-remediate. */
export const GET: RequestHandler = async () => {
	try {
		const rows = await getProjectHygieneRows();
		return json({ generatedAt: new Date().toISOString(), rows });
	} catch (err) {
		return json({ error: (err as Error).message }, { status: 500 });
	}
};
