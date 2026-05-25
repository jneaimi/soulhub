import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listAwaitingBudgetApprovals } from '$lib/agents/runs.js';
import {
	BUDGET_BUMPS,
	budgetApprovalIdFor,
	getBudgetApproval,
	resumeWithRaisedBudget,
	stopBudgetApproval,
} from '$lib/agents/budget-escalation.js';

/**
 * POST /api/agents/budget-approvals/[runId] — ADR-007 web front-door for the
 * ADR-006 resume/stop engine. Same engine as the Telegram buttons; this just
 * lets the operator act from the dashboard.
 *
 * It spends money (resume re-dispatches `claude --resume` with a raised
 * ceiling), so it fails CLOSED behind a same-origin-strict guard — mirrors
 * `checkUpdateAccess` in /api/system/update: only a browser fetch carrying
 * `Sec-Fetch-Site: same-origin` is admitted. Header-less curl (`null`),
 * `none`, and cross-/same-site all get 403.
 *
 * Body: { action: 'bump_usd' | 'bump_turns' | 'stop', amount?: number }.
 */

const ACTIONS = ['bump_usd', 'bump_turns', 'stop'] as const;
type Action = (typeof ACTIONS)[number];

export const POST: RequestHandler = async ({ request, params }) => {
	// Same-origin-strict guard — page JS cannot forge Sec-Fetch-Site.
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite !== 'same-origin') {
		return json(
			{ error: 'Forbidden — budget actions require a same-origin browser request' },
			{ status: 403 },
		);
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const action = body.action as Action;
	if (!ACTIONS.includes(action)) {
		return json(
			{ error: `Invalid action — expected one of ${ACTIONS.join(', ')}` },
			{ status: 400 },
		);
	}

	const runId = params.runId;
	try {
		const row = listAwaitingBudgetApprovals().find((r) => r.runId === runId);
		const sessionUuid = row?.claudeSessionId ?? '';
		const appr = sessionUuid
			? getBudgetApproval(budgetApprovalIdFor(runId, sessionUuid))
			: undefined;
		if (!appr) {
			return json({ error: 'no open approval for this run' }, { status: 404 });
		}

		if (action === 'stop') {
			stopBudgetApproval(appr);
			return json({ ok: true, stopped: true });
		}

		const amount = typeof body.amount === 'number' ? body.amount : undefined;
		const bump =
			action === 'bump_usd'
				? { addUsd: amount ?? BUDGET_BUMPS['bgt-u2'].addUsd }
				: { addTurns: amount ?? BUDGET_BUMPS['bgt-t10'].addTurns };
		const { ceilingUsd, ceilingTurns } = resumeWithRaisedBudget(appr, bump);
		return json({ ok: true, ceilingUsd, ceilingTurns });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		);
	}
};
