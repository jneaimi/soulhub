/**
 * POST /api/agents/runs/[runId]/bump-continue — ADR-019 P2.
 *
 * "Bump budget + continue" affordance for paused runs.  Lets the operator
 * extend headroom and resume a run that stalled at `awaiting-operator-input`
 * (self-trigger pause or genuine question the operator deems non-blocking)
 * without having to craft a typed answer.
 *
 * Behavior:
 *   1. Resolve the agent's default budget; compute +50% ceiling bump (additive
 *      on top of the production defaults, capped at 2× those defaults).
 *   2. Build a structured continuation prompt that tells the agent:
 *        - the pause was treated as a continuation (not a real question)
 *        - the new headroom (ceiling_usd / ceiling_turns)
 *        - to re-emit the sentinel if truly blocked (it will fire again and
 *          the operator can answer via the textarea on the second pause)
 *   3. Re-dispatch the same agent via `--resume <session_id>` with the bumped
 *      ceiling + the continuation prompt as the task.  Fire-and-forget: the
 *      dispatch is detached so this endpoint responds in <100ms while the
 *      (minutes-long) PTY run proceeds in the background.
 *
 * Only same-origin browser requests are admitted (Sec-Fetch-Site guard).
 * Fails-closed: refuses with 403 when the header is absent or wrong.
 *
 * Status semantics:
 *   - 200 → bump accepted + re-dispatch launched
 *   - 400 → run not in a bumpable state
 *   - 403 → cross-origin call rejected
 *   - 404 → run not found
 *   - 500 → internal error
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAgentRun } from '$lib/agents/runs.js';
import { getAgent } from '$lib/agents/store.js';
import { resolveBudget } from '$lib/agents/dispatch/budget.js';
import { branchForRun } from '$lib/agents/dispatch/run-branch.js';

/** Bumpable statuses — the affordance is offered on both pause types so the
 *  operator has a uniform "extend and continue" path regardless of why the run
 *  paused.  `awaiting-budget-approval` uses the same path for symmetry with
 *  ADR-006's budget-approval resume. */
const BUMPABLE_STATUSES = new Set(['awaiting-operator-input', 'awaiting-budget-approval']);

/** Default bump percentage (+50% on top of the production ceiling). */
const BUMP_PCT = 0.5;
/** Hard cap: the bumped ceiling can never exceed 2× the base ceiling. */
const BUMP_CAP_MULTIPLIER = 2;

/** Build the templated continuation prompt the agent receives on resume.
 *  This is the core of ADR-019 P2: a structured message that tells the agent
 *  to continue rather than wait for an operator answer. */
function buildContinuationPrompt(
	ceilingUsd: number,
	ceilingTurns: number,
	extraUsd: number,
	extraTurns: number,
): string {
	return [
		`The previous pause was treated as an operator continuation, not a question requiring an answer.`,
		``,
		`Budget extended: ceiling_usd=$${ceilingUsd.toFixed(2)}, ceiling_turns=${ceilingTurns} (new headroom: +$${extraUsd.toFixed(2)}, +${extraTurns} turns).`,
		``,
		`Resume the task from where you stopped. If you need to ask the operator a genuine question, re-emit the ASK_OPERATOR marker in your text output — the system will capture it and surface it as an answer textarea on the next pause card. Do not stop and wait; continue the implementation, run the verification gates, and emit the hand-back JSON.`,
	].join('\n');
}

export const POST: RequestHandler = async ({ request, params }) => {
	// Same-origin-strict guard — budget/resume actions require a browser fetch.
	// Page JS cannot forge Sec-Fetch-Site; curl + external callers get 403.
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite !== 'same-origin') {
		return json(
			{ error: 'Forbidden — bump-continue requires a same-origin browser request' },
			{ status: 403 },
		);
	}

	const runId = params.runId;
	if (!runId) return json({ error: 'runId required' }, { status: 400 });

	// ── 1. Load the run row ──────────────────────────────────────────────────
	const run = getAgentRun(runId);
	if (!run) {
		return json({ error: `Run '${runId}' not found` }, { status: 404 });
	}

	if (!BUMPABLE_STATUSES.has(run.status)) {
		return json(
			{
				error: `Run is in status '${run.status}' — bump-continue is only available for: ${[...BUMPABLE_STATUSES].join(', ')}`,
			},
			{ status: 400 },
		);
	}

	const sessionUuid = run.claudeSessionId;
	if (!sessionUuid) {
		return json({ error: 'Run has no claude_session_id — cannot resume' }, { status: 400 });
	}

	// ── 2. Resolve budget and compute bumped ceilings ────────────────────────
	const agent = getAgent(run.agentId);
	const baseBudget = resolveBudget('production', agent?.budget);

	const baseCeilingUsd = baseBudget.ceiling_usd;
	const baseCeilingTurns = baseBudget.ceiling_turns;

	// +50%, capped at 2×
	const bumpedCeilingUsd = Math.min(
		baseCeilingUsd + baseCeilingUsd * BUMP_PCT,
		baseCeilingUsd * BUMP_CAP_MULTIPLIER,
	);
	const bumpedCeilingTurns = Math.min(
		Math.ceil(baseCeilingTurns + baseCeilingTurns * BUMP_PCT),
		baseCeilingTurns * BUMP_CAP_MULTIPLIER,
	);

	const extraUsd = bumpedCeilingUsd - baseCeilingUsd;
	const extraTurns = bumpedCeilingTurns - baseCeilingTurns;

	// ── 3. Reconstruct the branch name for worktree resume ───────────────────
	// ADR-022 single-source-of-truth via branchForRun (handback.branch wins,
	// else claude-soul/<adrKey>, else legacy orchestration/run-X/Y).
	// Falls back to undefined when subjectPath is absent (legacy non-artifact
	// runs), in which case provisionAgentWorktree provisions a fresh worktree.
	const resumeBranch = run.subjectPath ? branchForRun(run) : undefined;

	// ── 4. Build the continuation prompt ────────────────────────────────────
	const continuationTask = buildContinuationPrompt(
		bumpedCeilingUsd,
		bumpedCeilingTurns,
		extraUsd,
		extraTurns,
	);

	// ── 5. Fire-and-forget re-dispatch ───────────────────────────────────────
	// Detached: must NOT await — this endpoint must answer in <100ms.
	// The resumed dispatch flows back through dispatchAgent's full lifecycle:
	// it will persist its own terminal row, re-escalate if it hits the new
	// ceiling, and surface the review card when done.
	void (async () => {
		try {
			const { dispatchAgent } = await import('$lib/agents/dispatch/index.js');
			const gen = dispatchAgent(run.agentId, continuationTask, {
				mode: 'production',
				resumeSessionId: sessionUuid,
				...(resumeBranch ? { resumeBranch } : {}),
				pausableOnCeiling: true,
				subjectPath: run.subjectPath ?? undefined,
				budget_override: {
					ceiling_usd: bumpedCeilingUsd,
					ceiling_turns: bumpedCeilingTurns,
				},
				// ADR-020 P1 — tag bump+continue re-dispatches as `'iterate'` so
				// the drawer run-history strip surfaces them distinctly from the
				// original `'initial'` run.  P2 will refine to `'iterate-N'`
				// with a count derived from prior runs for this subject_path.
				phase: 'iterate',
			});
			// Drain to completion; dispatchAgent handles all persistence +
			// re-escalation via its normal finish path.
			while (!(await gen.next()).done) {
				/* drain events */
			}
		} catch (err) {
			console.error(
				`[agents/bump-continue] resume failed for run ${runId}: ${(err as Error).message}`,
			);
		}
	})();

	return json({
		ok: true,
		runId,
		bumpedCeilingUsd,
		bumpedCeilingTurns,
		extraUsd,
		extraTurns,
	});
};
