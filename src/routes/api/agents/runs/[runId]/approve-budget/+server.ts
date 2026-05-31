/**
 * POST /api/agents/runs/[runId]/approve-budget — O3 D1 (workbench-first
 * escalation, sibling of the Telegram bump path).
 *
 * Replaces the Telegram inline keyboard as the AUTHORITATIVE budget-approval
 * surface. The Telegram message remains a smart pointer (D2) — the operator
 * approves/stops from the workbench (D3), which calls this endpoint. The
 * Telegram bump callbacks stay live as a convenience for quick taps; both
 * paths converge on the same `resumeWithRaisedBudget` / `stopBudgetApproval`
 * helpers.
 *
 * Body:
 *   { addUsd?: number, addTurns?: number, stop?: true, reason?: string }
 *
 *   - `stop: true` → flip the run to `budget-exceeded`. The `reason` is recorded
 *     on the run's `error_message` for the audit trail.
 *   - otherwise   → raise the ceiling by `addUsd` / `addTurns` and re-dispatch.
 *     At least one of `addUsd` / `addTurns` must be > 0.
 *
 * Defense in order (fail-closed at every step):
 *   1. Not same-origin            → 403 (page JS cannot forge Sec-Fetch-Site;
 *                                        curl + external callers get 403)
 *   2. Missing runId              → 400
 *   3. Run not found              → 404
 *   4. Run not awaiting approval  → 409
 *   5. No pending approval row    → 410 (TTL'd or already resolved)
 *   6. Invalid bump amounts       → 400
 *
 * Status semantics on success:
 *   - 200 { ok: true, action: 'stopped', runId }
 *   - 200 { ok: true, action: 'resumed', runId, ceilingUsd, ceilingTurns }
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAgentRun, setRunStatus } from '$lib/agents/runs.js';
import {
	budgetApprovalIdFor,
	deleteBudgetApproval,
	getBudgetApproval,
	resumeWithRaisedBudget,
} from '$lib/agents/budget-escalation.js';
import { parseApproveBudgetBody } from '$lib/agents/approve-budget-body.js';

export const POST: RequestHandler = async ({ request, params }) => {
	// 1. Same-origin guard — operator action, browser-only.
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite !== 'same-origin') {
		return json(
			{ error: 'Forbidden — approve-budget requires a same-origin browser request' },
			{ status: 403 },
		);
	}

	// 2. runId.
	const runId = params.runId;
	if (!runId) return json({ error: 'runId required' }, { status: 400 });

	// 3. Body.
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	const parsed = parseApproveBudgetBody(raw);
	if (!parsed.ok) {
		return json({ error: parsed.error }, { status: 400 });
	}
	const { stop, addUsd, addTurns, reason } = parsed.value;

	// 4. Load run + verify it's awaiting budget approval.
	const run = getAgentRun(runId);
	if (!run) {
		return json({ error: `Run '${runId}' not found` }, { status: 404 });
	}
	if (run.status !== 'awaiting-budget-approval') {
		return json(
			{
				error: `Run is in status '${run.status}' — approve-budget only applies to 'awaiting-budget-approval'`,
				currentStatus: run.status,
			},
			{ status: 409 },
		);
	}
	if (!run.claudeSessionId) {
		return json({ error: 'Run has no claude_session_id — cannot resume' }, { status: 409 });
	}

	// 5. Load the pending budget-approval row. TTL is 6h; gone → already
	//    resolved (Telegram tap, prior approve-budget call, or sweep).
	const approvalId = budgetApprovalIdFor(runId, run.claudeSessionId);
	const approvalRow = getBudgetApproval(approvalId);
	if (!approvalRow) {
		return json(
			{ error: 'No pending budget approval for this run (already resolved or expired)' },
			{ status: 410 },
		);
	}

	// 6. Act.
	if (stop) {
		const errorMessage = reason
			? `stopped by operator at budget ceiling: ${reason}`
			: 'stopped by operator at budget ceiling';
		setRunStatus(runId, 'budget-exceeded', { errorMessage });
		deleteBudgetApproval(approvalId);
		return json({ ok: true, action: 'stopped', runId, reason: reason ?? null });
	}

	const { ceilingUsd, ceilingTurns } = resumeWithRaisedBudget(approvalRow, {
		addUsd: addUsd > 0 ? addUsd : undefined,
		addTurns: addTurns > 0 ? addTurns : undefined,
	});

	return json({
		ok: true,
		action: 'resumed',
		runId,
		ceilingUsd,
		ceilingTurns,
		addUsd,
		addTurns,
	});
};
