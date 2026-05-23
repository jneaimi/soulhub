import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { loadRunSummary } from '$lib/sessions/dispatch.js';
import { loadSoulHubEvents } from '$lib/sessions/summarize-soul-hub.js';

/** GET /api/runs/[runId]?parentRunId=...&events=true */
export const GET: RequestHandler = async ({ params, url }) => {
	const runId = params.runId;
	if (!runId) return json({ error: 'Missing runId' }, { status: 400 });
	const parentRunId = url.searchParams.get('parentRunId') ?? undefined;
	const includeEvents = url.searchParams.get('events') === 'true';

	const { flavor, jsonlPath, summary } = await loadRunSummary(runId, parentRunId);
	if (flavor === 'unknown' || !summary) {
		return json({ error: `No run JSONL at ${jsonlPath} (or unrecognized format)` }, { status: 404 });
	}

	const body: Record<string, unknown> = { flavor, jsonlPath, summary };
	if (includeEvents) {
		body.events = await loadSoulHubEvents(jsonlPath);
	}
	return json(body);
};
