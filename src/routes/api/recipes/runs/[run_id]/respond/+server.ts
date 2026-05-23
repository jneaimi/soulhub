/**
 * POST /api/recipes/runs/[run_id]/respond — resolve a paused human/gate step.
 *
 * Body shape:
 *   { stepId: string, kind: 'human', response: object | string }
 *   { stepId: string, kind: 'gate', decision: 'approved'|'rejected', comment?: string }
 *
 * Status codes:
 *   200 — pause resolved, runner resumed
 *   400 — bad body (missing/invalid fields, wrong kind)
 *   404 — no such paused step (already resolved, timed out, or never paused)
 *   409 — pause kind mismatch (e.g. POST 'human' to a 'gate' pause)
 *
 * v1 is single-operator first-response-wins; no locking design. ADR-011.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolvePause, type PauseResponse } from '$lib/naseej/pause-registry.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const runId = params.run_id;
	if (!runId) return json({ error: 'runId required' }, { status: 400 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const b = (body ?? {}) as Record<string, unknown>;
	const stepId = b.stepId;
	const kind = b.kind;

	if (typeof stepId !== 'string' || !stepId) {
		return json({ error: 'stepId (string) is required' }, { status: 400 });
	}
	if (kind !== 'human' && kind !== 'gate') {
		return json({ error: 'kind must be "human" or "gate"' }, { status: 400 });
	}

	let payload: PauseResponse;
	if (kind === 'human') {
		const response = b.response;
		if (response === undefined || response === null) {
			return json({ error: 'response is required for human kind' }, { status: 400 });
		}
		if (typeof response !== 'string' && (typeof response !== 'object' || Array.isArray(response))) {
			return json(
				{ error: 'response must be a string or object' },
				{ status: 400 },
			);
		}
		payload = {
			kind: 'human',
			response: { response: response as Record<string, unknown> | string },
		};
	} else {
		const decision = b.decision;
		if (decision !== 'approved' && decision !== 'rejected') {
			return json(
				{ error: 'decision must be "approved" or "rejected"' },
				{ status: 400 },
			);
		}
		const comment = b.comment;
		if (comment !== undefined && typeof comment !== 'string') {
			return json({ error: 'comment must be a string' }, { status: 400 });
		}
		payload = {
			kind: 'gate',
			response: {
				decision,
				...(comment ? { comment } : {}),
			},
		};
	}

	const fired = resolvePause(runId, stepId, payload);
	if (!fired) {
		return json(
			{ error: 'no paused step matches the given runId + stepId (already resolved, timed out, or never paused)' },
			{ status: 404 },
		);
	}

	return json({ ok: true, runId, stepId, kind });
};
