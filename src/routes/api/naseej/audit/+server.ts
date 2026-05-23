/**
 * GET /api/naseej/audit — read-only audit-trail surface (ADR-021 Track 1 Slice 2).
 *
 * Query params:
 *   type=runs|publishes      (required)
 *   limit=N                  (default 50; clamped 1..500 by audit.ts)
 *   recipe=<name>            (runs only — filter by recipe)
 *   status=<status>          (runs: running|success|failed|cancelled|paused;
 *                             publishes: passed|failed)
 *   component=<name>         (publishes only — filter by component)
 *   project=<slug>           (runs only — filter by project)
 *
 * No POST surface — writes happen via the runner + publish gate hooks.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	listRuns,
	listPublishes,
	type RunStatus,
	type PublishStatus,
} from '$lib/naseej/audit.js';

const RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
	'running',
	'success',
	'failed',
	'cancelled',
	'paused',
]);
const PUBLISH_STATUSES: ReadonlySet<PublishStatus> = new Set(['passed', 'failed']);

export const GET: RequestHandler = async ({ url }) => {
	const type = url.searchParams.get('type');
	if (type !== 'runs' && type !== 'publishes') {
		return json(
			{ error: 'type must be "runs" or "publishes"' },
			{ status: 400 },
		);
	}

	const limitRaw = url.searchParams.get('limit');
	const limit = limitRaw ? Number(limitRaw) : undefined;
	if (limitRaw && !Number.isFinite(limit)) {
		return json({ error: 'limit must be a number' }, { status: 400 });
	}

	if (type === 'runs') {
		const status = url.searchParams.get('status');
		if (status && !RUN_STATUSES.has(status as RunStatus)) {
			return json(
				{ error: `status must be one of: ${[...RUN_STATUSES].join(', ')}` },
				{ status: 400 },
			);
		}
		const rows = listRuns({
			limit,
			recipe: url.searchParams.get('recipe') ?? undefined,
			status: (status as RunStatus) ?? undefined,
			project: url.searchParams.get('project') ?? undefined,
		});
		return json({ type: 'runs', total: rows.length, results: rows });
	}

	const status = url.searchParams.get('status');
	if (status && !PUBLISH_STATUSES.has(status as PublishStatus)) {
		return json(
			{ error: `status must be one of: ${[...PUBLISH_STATUSES].join(', ')}` },
			{ status: 400 },
		);
	}
	const rows = listPublishes({
		limit,
		component: url.searchParams.get('component') ?? undefined,
		status: (status as PublishStatus) ?? undefined,
	});
	return json({ type: 'publishes', total: rows.length, results: rows });
};
