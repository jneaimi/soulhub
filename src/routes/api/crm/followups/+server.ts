/**
 * /api/crm/followups — pipeline-level follow-up dashboard data.
 *
 *   GET  ?overdueWindowDays=&upcomingWindowDays=&limit=
 *        → { overdue: Contact[], upcoming: Contact[] }
 *
 * Bucketed by `next_followup_at` relative to now in a single SQL pass —
 * see listFollowups in db.ts for the windowing semantics. The Stage E UI
 * surfaces this on the sidebar / dashboard.
 *
 * Stage D consumer. ADR §D2 / §D5.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listFollowups } from '$lib/crm/index.js';

export const GET: RequestHandler = async ({ url }) => {
	const overdueRaw = url.searchParams.get('overdueWindowDays');
	const upcomingRaw = url.searchParams.get('upcomingWindowDays');
	const limitRaw = url.searchParams.get('limit');

	const overdueWindowDays = parseOptionalNumber(overdueRaw);
	const upcomingWindowDays = parseOptionalNumber(upcomingRaw);
	if (overdueRaw !== null && overdueWindowDays === null) {
		return json({ error: 'overdueWindowDays must be a number' }, { status: 400 });
	}
	if (upcomingRaw !== null && upcomingWindowDays === null) {
		return json({ error: 'upcomingWindowDays must be a number' }, { status: 400 });
	}

	const limit = (() => {
		if (limitRaw === null) return 50;
		const parsed = Number(limitRaw);
		if (!Number.isFinite(parsed)) return 50;
		return Math.max(1, Math.min(500, Math.round(parsed)));
	})();

	const result = listFollowups({
		overdueWindowDays: overdueWindowDays ?? undefined,
		upcomingWindowDays: upcomingWindowDays ?? undefined,
		limit,
	});

	return json(result);
};

function parseOptionalNumber(raw: string | null): number | null {
	if (raw === null) return null;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return null;
	return parsed;
}
