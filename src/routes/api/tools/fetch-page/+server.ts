/**
 * POST /api/tools/fetch-page
 *
 * Curl-callable wrapper around `fetchPage` per the no-PTY-parsing rule
 * (memory `feedback_ai_tool_apis`). The orchestrator tool calls the
 * underlying function directly — this endpoint exists so non-LLM surfaces
 * (content-pipeline, future inbox auto-routing, manual ops) can hit it
 * with curl + JSON.
 *
 * Body shape:
 *   { url: string, maxChars?: number, timeoutMs?: number }
 *
 * Returns the FetchPageResult JSON unchanged. Failures are NEVER thrown —
 * they're encoded in the `failureClass` + `error` fields on the result,
 * mirroring the function's contract.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { fetchPage } from '$lib/fetch-page/index.js';

export const POST: RequestHandler = async ({ request }) => {
	let body: { url?: unknown; maxChars?: unknown; timeoutMs?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	if (typeof body.url !== 'string' || body.url.length === 0) {
		return json({ error: 'url is required (string)' }, { status: 400 });
	}

	const maxChars = typeof body.maxChars === 'number' && body.maxChars > 0 ? body.maxChars : undefined;
	const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : undefined;

	const result = await fetchPage(body.url, { maxChars, timeoutMs });
	return json(result);
};
