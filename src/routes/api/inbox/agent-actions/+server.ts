/**
 * GET /api/inbox/agent-actions — L3 audit log query surface
 *   ?tool=inbox-mark-processed   — filter by tool name
 *   ?messageId=N                  — filter by message id
 *   ?actor=orchestrator           — orchestrator | worker | operator-direct
 *   ?since=<epoch_ms>             — lower bound on timestamp
 *   ?confirmedOnly=true           — only result.ok === true rows
 *   ?limit=50                     — page size, max 500
 *   ?offset=0                     — pagination offset
 *
 * Returns `{ actions, total, byTool, trustTrainer }`. The `trustTrainer`
 * block surfaces the L3 confirmation gate's current state — count of
 * successful `inbox-mark-processed` rows + the 50-call threshold + a
 * `forceConfirm` flag honouring `INBOX_MARK_PROCESSED_CONFIRM=always`.
 *
 * Specified in ADR-L3 §D7 Guardrail 2 ("Queryable via GET /api/inbox/agent-actions").
 * Read-only — there is no write endpoint here. The audit log is append-only
 * via `recordAgentAction` from the inbox/tool internals.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { queryAgentActions, countConfirmedMarkProcessed } from '$lib/inbox/index.js';

const MARK_PROCESSED_THRESHOLD = 50;

export const GET: RequestHandler = async ({ url }) => {
	const tool = url.searchParams.get('tool') || undefined;
	const messageIdRaw = url.searchParams.get('messageId');
	const actor = url.searchParams.get('actor') || undefined;
	const sinceRaw = url.searchParams.get('since');
	const confirmedOnly = url.searchParams.get('confirmedOnly') === 'true';
	const limitRaw = url.searchParams.get('limit');
	const offsetRaw = url.searchParams.get('offset');

	const messageId = messageIdRaw ? Number(messageIdRaw) : undefined;
	const since = sinceRaw ? Number(sinceRaw) : undefined;
	const limit = limitRaw ? Number(limitRaw) : 50;
	const offset = offsetRaw ? Number(offsetRaw) : 0;

	if (messageId !== undefined && (!Number.isFinite(messageId) || messageId < 1)) {
		return json({ error: 'messageId must be a positive integer' }, { status: 400 });
	}
	if (since !== undefined && !Number.isFinite(since)) {
		return json({ error: 'since must be epoch milliseconds' }, { status: 400 });
	}
	if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
		return json({ error: 'limit must be 1-500' }, { status: 400 });
	}
	if (!Number.isFinite(offset) || offset < 0) {
		return json({ error: 'offset must be >= 0' }, { status: 400 });
	}
	if (actor && !['orchestrator', 'worker', 'operator-direct'].includes(actor)) {
		return json(
			{ error: "actor must be one of: orchestrator | worker | operator-direct" },
			{ status: 400 },
		);
	}

	const result = queryAgentActions({
		tool,
		messageId,
		actor,
		since,
		confirmedOnly,
		limit,
		offset,
	});

	const confirmed = countConfirmedMarkProcessed();
	const forceConfirm =
		(process.env.INBOX_MARK_PROCESSED_CONFIRM ?? '').trim().toLowerCase() === 'always';

	return json({
		...result,
		trustTrainer: {
			tool: 'inbox-mark-processed',
			confirmed,
			threshold: MARK_PROCESSED_THRESHOLD,
			remaining: Math.max(0, MARK_PROCESSED_THRESHOLD - confirmed),
			gateActive: forceConfirm || confirmed < MARK_PROCESSED_THRESHOLD,
			forceConfirm,
		},
	});
};
