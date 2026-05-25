import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listAwaitingBudgetApprovals } from '$lib/agents/runs.js';
import { budgetApprovalIdFor, getBudgetApproval } from '$lib/agents/budget-escalation.js';

/**
 * GET /api/agents/budget-approvals — ADR-007 web surface for ADR-006 paused
 * runs. Lists every run sitting at `awaiting-budget-approval`, merged with its
 * pending-approval detail (ceilings + reason + TTL). The pending record can
 * expire/be-consumed independently of the run row, so a row with no live
 * approval is reported as `actionable: false` rather than dropped — the panel
 * shows it greyed out.
 *
 * Read-only. The money-spending actions live on POST .../[runId].
 */

const APPROVAL_TTL_MS = 6 * 60 * 60 * 1000; // 6h — mirrors budget-escalation.ts

export const GET: RequestHandler = async () => {
	try {
		const rows = listAwaitingBudgetApprovals();
		const now = Date.now();

		const approvals = rows.map((row) => {
			const sessionUuid = row.claudeSessionId ?? '';
			const appr = sessionUuid
				? getBudgetApproval(budgetApprovalIdFor(row.runId, sessionUuid))
				: undefined;
			const expiresAt = row.startedAt + APPROVAL_TTL_MS;
			const ttlMs = Math.max(0, expiresAt - now);

			return {
				runId: row.runId,
				agentId: row.agentId,
				spentUsd: appr?.spentUsd ?? row.costUsd,
				turns: appr?.turns ?? row.numTurns,
				ceilingUsd: appr?.ceilingUsd ?? null,
				ceilingTurns: appr?.ceilingTurns ?? null,
				reason: appr?.reason ?? null,
				softUsd: null,
				errorMessage: row.errorMessage,
				ttlMs,
				actionable: Boolean(appr),
				bumps: { addUsd: [2, 5], addTurns: [10] },
			};
		});

		return json({ approvals });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		);
	}
};
