/** GET / POST /api/intent/patterns — active learned-pattern surface.
 *
 *  GET — list active rows from `intent_patterns` (retired_at IS NULL).
 *  POST { action: 'retire', id: number } — soft-delete by stamping
 *    `retired_at`. Idempotent.
 *
 *  Pairs with `/api/intent/proposed` (the approval queue) — this
 *  endpoint manages already-promoted patterns. Same-origin guard
 *  consistent with the other intent endpoints. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listActivePatterns, retirePattern } from '$lib/intent/patterns.js';

function rejectCrossSite(request: Request): Response | null {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}
	return null;
}

export const GET: RequestHandler = async ({ request }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;
	const patterns = listActivePatterns();
	return json({ ok: true, count: patterns.length, patterns });
};

interface PostBody {
	action?: string;
	id?: unknown;
}

export const POST: RequestHandler = async ({ request }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;

	let body: PostBody;
	try {
		body = (await request.json()) as PostBody;
	} catch {
		return json({ ok: false, error: 'body must be JSON' }, { status: 400 });
	}

	if (body.action !== 'retire') {
		return json({ ok: false, error: "action must be 'retire'" }, { status: 400 });
	}

	const id = typeof body.id === 'number' ? body.id : Number(body.id);
	if (!Number.isFinite(id) || id < 1) {
		return json({ ok: false, error: 'id must be a positive integer' }, { status: 400 });
	}

	const retired = retirePattern(id);
	if (!retired) {
		return json(
			{ ok: false, error: `pattern ${id} not found or already retired` },
			{ status: 400 },
		);
	}

	return json({ ok: true, retired: true, id });
};
