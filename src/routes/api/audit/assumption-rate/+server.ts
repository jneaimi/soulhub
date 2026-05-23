/** GET /api/audit/assumption-rate
 *
 *  project-phases ADR-008 S2 — operator-facing view of the assumption-rate
 *  audit table. Sibling of `/api/vault/projects/<slug>/falsifiers`. The
 *  `<AssumptionAuditPanel>` UI (S4) reads from this endpoint.
 *
 *  Query params:
 *    ?project=<slug>            filter to audits whose linked_projects contains slug
 *    ?since=<iso8601>           lower-bound on audited_at; default = 30 days ago
 *    ?limit=<N>                 max audits returned; default 50, capped at 500
 *    ?include_dismissed=true    include false-positive-dismissed rows (default false)
 *
 *  Returns:
 *    {
 *      audits: AuditRow[],
 *      counts: { high_score, medium_score, low_score }
 *    }
 *
 *  The audit response is the LATEST-per-session view: if a transcript was
 *  re-audited (file grew), only the most recent row is returned. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { queryAudits, countAudits } from '$lib/audit/persister.js';

const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export const GET: RequestHandler = async ({ url }) => {
	const project = url.searchParams.get('project') ?? undefined;
	// projects-graph ADR-004 — OR-match across multiple project slugs
	// (parent + descendants). Comma-separated.
	const projectsParam = url.searchParams.get('projects');
	const projects = projectsParam
		? projectsParam.split(',').map((s) => s.trim()).filter(Boolean)
		: undefined;
	const includeDismissed = url.searchParams.get('include_dismissed') === 'true';

	let since: number | undefined;
	const sinceRaw = url.searchParams.get('since');
	if (sinceRaw) {
		const parsed = Date.parse(sinceRaw);
		if (Number.isNaN(parsed)) {
			return json({ error: 'invalid since (expected ISO-8601)' }, { status: 400 });
		}
		since = parsed;
	} else {
		since = Date.now() - DEFAULT_LOOKBACK_MS;
	}

	const limitRaw = url.searchParams.get('limit');
	let limit: number | undefined;
	if (limitRaw) {
		const parsed = Number(limitRaw);
		if (!Number.isInteger(parsed) || parsed < 1) {
			return json({ error: 'invalid limit (expected positive integer)' }, { status: 400 });
		}
		limit = parsed;
	}

	const opts = { project, projects, since, limit, include_dismissed: includeDismissed };
	const audits = queryAudits(opts);
	const counts = countAudits(opts);

	return json({
		generated_at: new Date().toISOString(),
		filter: {
			project: project ?? null,
			projects: projects ?? null,
			since: new Date(since).toISOString(),
		},
		audits,
		counts,
	});
};
