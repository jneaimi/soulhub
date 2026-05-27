/**
 * projects-graph ADR-026 D3 (drawer hydration) — GET the review hand-off for a
 * single subject (an ADR/decision path), so opening the drawer on a PAST
 * completed dispatch re-shows the ADR-024 review card + Ship / Send-back —
 * the card no longer exists only during a live in-drawer dispatch stream.
 *
 * Mirrors the worklist endpoint's review-handoff gating:
 *   - latest finished goal_achieved/success run for the subject
 *   - worktree branch must still exist (un-merged) — a discarded/merged branch
 *     means the run was already handled, so we report `available:false`.
 *
 * Returns the raw stored hand-back so the drawer can parse it with the shared
 * `parseHandback` from $lib/agents/handback.js (ADR-028) — matching the
 * live-stream path with no second parser to keep in sync.
 */

import { json, error } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getReviewableRunForSubject } from '$lib/agents/runs.js';
import { safeId, expandHome } from '$lib/agents/dispatch/worktree-provision.js';
import type { RequestHandler } from './$types';

const execFileAsync = promisify(execFile);

export const GET: RequestHandler = async ({ url }) => {
	const subject = url.searchParams.get('subject');
	if (!subject) throw error(400, 'subject query param required');

	const run = getReviewableRunForSubject(subject);
	if (!run) return json({ available: false });

	// Reconstruct the deterministic worktree branch (same formula as the
	// dispatcher + worklist) and confirm it still exists. An absent branch =
	// the run was merged or discarded → nothing left to review/ship.
	const branch = `orchestration/run-${run.startedAt}/${safeId(subject)}`;
	// ADR-031 P1 — run the liveness check in the run's actual repo.  A null
	// `repo` (legacy/soul-hub runs) falls through to process.cwd() — same
	// behaviour as before this ADR.
	const repoDir = expandHome(run.repo ?? process.env.SOUL_HUB_REPO ?? process.cwd());
	let branchLive = false;
	try {
		const { stdout } = await execFileAsync(
			'git',
			['branch', '--list', branch, '--format=%(refname:short)'],
			{ cwd: repoDir },
		);
		branchLive = stdout
			.split('\n')
			.map((b) => b.trim())
			.filter(Boolean)
			.includes(branch);
	} catch {
		// git unavailable → can't confirm an un-merged branch; stay conservative.
		branchLive = false;
	}
	if (!branchLive) return json({ available: false });

	// Prefer the full untruncated `handback` column; fall back to the 800-char
	// `result_excerpt` for runs predating that column (matches the worklist).
	const handbackRaw = run.handback ?? run.resultExcerpt;

	return json({
		available: true,
		runId: run.runId,
		sessionId: run.claudeSessionId,
		branch,
		costUsd: run.costUsd,
		numTurns: run.numTurns,
		status: run.status,
		handbackRaw,
	});
};
