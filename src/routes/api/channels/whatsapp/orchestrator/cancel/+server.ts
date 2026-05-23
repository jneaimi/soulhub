/**
 * POST /api/channels/whatsapp/orchestrator/cancel
 *
 * Body: { jid: string }
 * Response: { ok: true, cancelled: Array<{ runId, agentId, startedAt }> }
 *
 * Cancels every active orchestrator-initiated agent run for the given
 * JID. Idempotent — returns `cancelled: []` when nothing was running.
 *
 * Phase 1.5a returns an array because per-jid cap = 2 means there can
 * be up to two concurrent runs on a single chat.
 */

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { cancelByJid } from '$lib/orchestrator/index.js';

export const POST: RequestHandler = async ({ request }) => {
	let body: { jid?: string };
	try {
		body = (await request.json()) as { jid?: string };
	} catch {
		throw error(400, 'Invalid JSON.');
	}

	const jid = body.jid?.trim();
	if (!jid) throw error(400, 'Missing `jid`.');

	const cancelled = cancelByJid(jid);
	return json({
		ok: true,
		cancelled: cancelled.map((r) => ({
			runId: r.runId,
			agentId: r.agentId,
			startedAt: r.startedAt,
		})),
	});
};
