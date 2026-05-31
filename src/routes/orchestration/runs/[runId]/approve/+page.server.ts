/** O3 D3 — workbench approval surface server-load.
 *
 *  This is the page the 🔍 Investigate Telegram button deep-links to. It
 *  loads everything the operator needs to make a budget decision without
 *  bouncing between tools:
 *
 *    - The run record (agentId, ceilings, spend, turns, reason).
 *    - The pending budget-approval row (TTL'd at 6h; absent = expired/resolved).
 *    - Up to 20 recent main-thread transcript turns (full file via ?all=1).
 *    - The same velocity classification the Telegram message used (D2).
 *
 *  Actions happen via the D1 endpoint (`POST /api/agents/runs/[runId]/approve-budget`);
 *  this load is read-only. */

import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getAgentRun, type AgentRunRow } from '$lib/agents/runs.js';
import {
	budgetApprovalIdFor,
	getBudgetApproval,
	type BudgetApprovalRow,
} from '$lib/agents/budget-escalation.js';
import { classifyVelocity, type VelocityNote } from '$lib/agents/budget-velocity.js';
import { locateTranscript } from '$lib/sessions/run-record.js';
import { streamEvents } from '$lib/sessions/parser.js';
import { extractRecentTurns, type RecentTurn } from '$lib/sessions/recent-turns.js';

/** Default transcript window. The full file is available behind `?all=1` so the
 *  operator can read it when the default doesn't capture the relevant moment. */
const DEFAULT_TURN_LIMIT = 20;
/** Per-turn cap in the workbench view. Larger than Telegram's 600 because we
 *  have screen real estate; smaller than infinity so a 50KB assistant message
 *  doesn't blow up the page. */
const PER_TURN_MAX_CHARS = 4000;

export interface ApprovePageData {
	runId: string;
	run: AgentRunRow;
	approval: BudgetApprovalRow | null;
	turns: RecentTurn[];
	totalTurns: number;
	velocity: VelocityNote | null;
	/** True when no live budget-approval row exists for this run — either the
	 *  TTL expired, the operator already resolved it (Telegram tap, prior
	 *  workbench call), or the run terminated. The page renders a banner and
	 *  greys out the action buttons. */
	expired: boolean;
	/** Whether `?all=1` was requested. Drives the "Show all"/"Show recent"
	 *  toggle in the UI. */
	showAll: boolean;
	/** Public URL base when configured. The action buttons fetch a relative
	 *  path, so this is informational only (rendered in the page footer). */
	publicUrlConfigured: boolean;
}

export const load: PageServerLoad = async ({ params, url }) => {
	const runId = params.runId;
	if (!runId) error(400, 'runId required');

	const run = getAgentRun(runId);
	if (!run) error(404, `Run '${runId}' not found`);

	const showAll = url.searchParams.get('all') === '1';
	const limit = showAll ? Number.POSITIVE_INFINITY : DEFAULT_TURN_LIMIT;

	// Load the pending budget-approval row if the run is still awaiting one.
	// Either condition flips `expired = true` and disables the action buttons.
	let approval: BudgetApprovalRow | null = null;
	if (run.status === 'awaiting-budget-approval' && run.claudeSessionId) {
		const id = budgetApprovalIdFor(runId, run.claudeSessionId);
		approval = getBudgetApproval(id) ?? null;
	}
	const expired = approval === null;

	// Velocity note — same classifier as the D2 Telegram message. Source of
	// ceilings is the approval row (the run row doesn't carry ceiling columns);
	// when the approval is expired, skip the note rather than render
	// half-information.
	let velocity: VelocityNote | null = null;
	if (approval) {
		velocity = classifyVelocity({
			spentUsd: approval.spentUsd,
			ceilingUsd: approval.ceilingUsd,
			turns: approval.turns,
			ceilingTurns: approval.ceilingTurns,
		});
	}

	// Load transcript turns — best-effort, soft-fails to empty.
	let turns: RecentTurn[] = [];
	let totalTurns = 0;
	if (run.claudeSessionId) {
		try {
			const path = locateTranscript(run.claudeSessionId);
			if (path) {
				const events = [];
				for await (const e of streamEvents(path)) {
					events.push(e);
				}
				// Count all qualifying main-thread turns BEFORE slicing so the
				// "Showing N of M" hint is honest.
				const all = extractRecentTurns(events, {
					limit: Number.POSITIVE_INFINITY,
					perTurnMaxChars: PER_TURN_MAX_CHARS,
				});
				totalTurns = all.length;
				turns = showAll ? all : all.slice(-DEFAULT_TURN_LIMIT);
			}
		} catch {
			/* transcript missing / parse error — render the page without it */
		}
	}

	return {
		runId,
		run,
		approval,
		turns,
		totalTurns,
		velocity,
		expired,
		showAll,
		publicUrlConfigured: Boolean(process.env.SOUL_HUB_PUBLIC_URL),
	} satisfies ApprovePageData;
};
