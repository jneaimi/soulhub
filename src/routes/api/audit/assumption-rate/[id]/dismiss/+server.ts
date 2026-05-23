/** POST /api/audit/assumption-rate/:id/dismiss
 *
 *  project-phases ADR-008 S4 — operator marks an audit as a false
 *  positive (or otherwise "not worth showing"). Writes `dismissed_at`
 *  + optional `dismissed_reason` on the row. Idempotent: dismissing an
 *  already-dismissed audit is a no-op that returns 200.
 *
 *  F4 (false-positive rate <30%) is driven by this column: the operator
 *  dashboard counts dismissals / high-score audits in a rolling window.
 *
 *  Body: { reason?: string }
 *
 *  Returns: { success: true, id, dismissed_at, dismissed_reason }
 *  Errors:  404 if no row with that id, 400 on invalid body. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getHeartbeatDb } from '$lib/channels/whatsapp/heartbeat-state.js';

interface DismissBody {
	reason?: string;
}

export const POST: RequestHandler = async ({ params, request }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id < 1) {
		return json({ success: false, error: 'invalid id' }, { status: 400 });
	}

	let body: DismissBody = {};
	try {
		const raw = await request.text();
		if (raw.trim()) body = JSON.parse(raw) as DismissBody;
	} catch {
		return json({ success: false, error: 'invalid JSON body' }, { status: 400 });
	}

	const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
	const dismissed_at = Date.now();

	const db = getHeartbeatDb();
	const info = db
		.prepare(
			`UPDATE assumption_audits
			 SET dismissed_at = COALESCE(dismissed_at, @dismissed_at),
			     dismissed_reason = COALESCE(dismissed_reason, @reason)
			 WHERE id = @id`
		)
		.run({ id, dismissed_at, reason });

	if (info.changes === 0) {
		return json({ success: false, error: `audit ${id} not found` }, { status: 404 });
	}

	const row = db
		.prepare('SELECT id, dismissed_at, dismissed_reason FROM assumption_audits WHERE id = ?')
		.get(id) as { id: number; dismissed_at: number; dismissed_reason: string | null };

	return json({ success: true, ...row });
};
