/** GET / POST /api/intent/proposed — operator surface for the
 *  ADR-023 Phase 1.5 intent-pattern approval queue.
 *
 *  GET  ?batch=<batchId>          — list pending proposals (default: all pending)
 *       ?includeDismissed=true    — also include resolved rows
 *  POST { action: 'approve',    id: number }
 *       { action: 'reject',     id: number, reason?: string }
 *       { action: 'approveAll', batchId: string }
 *       { action: 'defer',      batchId: string }
 *
 *  CSRF posture: same as `/api/conversation/proactive` — Sec-Fetch-Site:
 *  cross-site is rejected. The operator browsing on localhost (same-origin)
 *  or curl from a shell (no fetch-site header) is fine. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	listProposed,
	promoteProposal,
	rejectProposal,
	promoteAllInBatch,
	deferBatch,
} from '$lib/intent/patterns.js';

function rejectCrossSite(request: Request): Response | null {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		return json({ ok: false, error: 'cross-site requests rejected' }, { status: 403 });
	}
	return null;
}

export const GET: RequestHandler = async ({ url, request }) => {
	const guard = rejectCrossSite(request);
	if (guard) return guard;

	const batch = url.searchParams.get('batch') ?? undefined;
	const includeDismissed = url.searchParams.get('includeDismissed') === 'true';
	const rows = listProposed({ batchId: batch || undefined, includeDismissed });

	return json({ ok: true, count: rows.length, proposals: rows });
};

interface PostBody {
	action?: string;
	id?: unknown;
	batchId?: unknown;
	reason?: unknown;
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

	const action = typeof body.action === 'string' ? body.action : '';

	if (action === 'approve') {
		const id = typeof body.id === 'number' ? body.id : Number(body.id);
		if (!Number.isFinite(id) || id < 1) {
			return json({ ok: false, error: 'id must be a positive integer' }, { status: 400 });
		}
		const r = promoteProposal(id);
		return json({ ok: r.ok, patternId: r.patternId, error: r.error }, { status: r.ok ? 200 : 400 });
	}

	if (action === 'reject') {
		const id = typeof body.id === 'number' ? body.id : Number(body.id);
		if (!Number.isFinite(id) || id < 1) {
			return json({ ok: false, error: 'id must be a positive integer' }, { status: 400 });
		}
		const reason = typeof body.reason === 'string' ? body.reason : undefined;
		const r = rejectProposal(id, reason);
		return json({ ok: r.ok, rejectedId: r.rejectedId, error: r.error }, { status: r.ok ? 200 : 400 });
	}

	if (action === 'approveAll') {
		const batchId = typeof body.batchId === 'string' ? body.batchId : '';
		if (!batchId) return json({ ok: false, error: 'batchId required' }, { status: 400 });
		const r = promoteAllInBatch(batchId);
		return json({ ok: true, ...r });
	}

	if (action === 'defer') {
		const batchId = typeof body.batchId === 'string' ? body.batchId : '';
		if (!batchId) return json({ ok: false, error: 'batchId required' }, { status: 400 });
		const r = deferBatch(batchId);
		return json({ ok: true, ...r });
	}

	return json(
		{ ok: false, error: 'action must be one of: approve | reject | approveAll | defer' },
		{ status: 400 },
	);
};
