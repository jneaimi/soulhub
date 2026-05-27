/**
 * ADR-012 P1 — deliverable-gating for dispatch completion.
 *
 * A production *coding* dispatch (worktree agent) is only a real success if it
 * left something the review lane can surface: a parseable hand-back OR a
 * committed worktree branch. The ADR-003 run reported `goal_achieved` at $3.17
 * with neither (it edited global files outside its worktree), then fell back to
 * `ready_for_ai` — looking like nothing happened. This gate downgrades that to
 * `completed-no-artifact` so the run stays visible in Waiting-on-you instead.
 *
 * Pure except for `branchHasCommits` (a sync git read); the git check is
 * injectable so the gate logic is unit-testable without a real repo.
 */

import { spawnSync } from 'node:child_process';
import { safeId } from './worktree-provision.js';
import type { DispatchMode } from './types.js';
import type { RunStatus } from '../runs.js';

/** Statuses we treat as "looked successful" and therefore gate. */
const SUCCESS_LIKE = new Set<RunStatus>(['success', 'goal_achieved']);

/** True iff `branch` exists in `repo` AND carries ≥1 commit ahead of `main`
 *  — i.e. the agent actually committed work to its worktree branch. A missing
 *  branch (the agent never committed, or worked outside the worktree) or a
 *  zero-commit branch both return false. Base is assumed to be `main` (the
 *  worktree-provision base); non-main bases degrade to a conservative false. */
export function branchHasCommits(branch: string, repo: string): boolean {
	try {
		const exists = spawnSync(
			'git',
			['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
			{ cwd: repo, encoding: 'utf8' },
		);
		if (exists.status !== 0) return false;
		const ahead = spawnSync('git', ['rev-list', '--count', `main..${branch}`], {
			cwd: repo,
			encoding: 'utf8',
		});
		if (ahead.status !== 0) return false;
		return Number((ahead.stdout || '0').trim()) > 0;
	} catch {
		// git unavailable — don't falsely downgrade; treat as "has artifact".
		return true;
	}
}

export interface DeliverableGateInput {
	rawStatus: RunStatus;
	/** Raw hand-back block extracted from the run output, if any. */
	handback: string | undefined;
	mode: DispatchMode;
	/** `agent.repo` — set only for worktree/coding agents. Falsy = don't gate. */
	repo: string | undefined;
	subjectPath: string | undefined;
	startedAt: number;
	/** Injectable git check (defaults to the real `branchHasCommits`). */
	branchHasCommitsFn?: (branch: string, repo: string) => boolean;
}

/** ADR-012 P1 — return the effective persisted status: downgrade a success-like
 *  production coding dispatch to `completed-no-artifact` when it left no
 *  reviewable deliverable. Everything else passes through unchanged. */
export function gateStatusForDeliverable(input: DeliverableGateInput): RunStatus {
	const { rawStatus, handback, mode, repo, subjectPath, startedAt } = input;
	if (!SUCCESS_LIKE.has(rawStatus)) return rawStatus; // only gate apparent successes
	if (mode !== 'production') return rawStatus; // test/oneshot need no artifact
	if (!repo) return rawStatus; // non-worktree agent (analyst, research, clerical)
	if (!subjectPath) return rawStatus; // no review-lane subject (chat dispatch)
	if (handback) return rawStatus; // deliverable A — a parseable hand-back
	const branch = `orchestration/run-${startedAt}/${safeId(subjectPath)}`;
	const check = input.branchHasCommitsFn ?? branchHasCommits;
	if (check(branch, repo)) return rawStatus; // deliverable B — committed branch
	return 'completed-no-artifact';
}
