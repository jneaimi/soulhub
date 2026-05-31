/**
 * ADR-022 branch-convention single-source-of-truth.
 *
 * Resolve the git branch + worktree path for an `agent_run` row.
 *
 * Bug context (2026-05-29): ADR-022 (shipped earlier this session) changed
 * worktree branches from `orchestration/run-<startedAt>/<adrSlug>` to
 * `claude-soul/<adrKey>` and worktree paths from
 * `.worktrees/run-<startedAt>-<adrSlug>` to `.worktrees/<adrKey>`. Eight
 * call-sites kept the legacy reconstruction — most operator-visibly the
 * workbench review lane (`worklist/+server.ts`), which filtered out shipped
 * runs because their reconstructed-old-format branch didn't match the
 * actual `claude-soul/...` branch on disk. ADR-025's run #522 reached
 * `goal_achieved` with a committed branch but the UI kept showing the ADR
 * as "ready to dispatch."
 *
 * This helper consolidates the contract:
 *
 *   1. Authoritative: `handback.branch` — the agent wrote this with the
 *      ACTUAL branch it committed to. Wins if present + non-empty.
 *   2. ADR-022 reconstruction: `claude-soul/<safeId(subjectPath)>` — the
 *      current convention. Used when no handback (running rows, or
 *      handback parse failed).
 *   3. Legacy reconstruction: `orchestration/run-<startedAt>/<safeId>` —
 *      for rows predating ADR-022 (commit a109bf0 — 2026-05-29). Still
 *      findable by the live-branch filter in `worklist/+server.ts`.
 *
 * Worktree paths follow the same three-tier fallback. The legacy convention
 * used `.worktrees/run-<startedAt>-<adrSlug>`; ADR-022 uses
 * `.worktrees/<adrKey>`.
 */

import { join } from 'node:path';
import { parseHandback } from '../handback.js';
import { safeId } from './worktree-provision.js';

/** Structural input to `branchForRun` / `worktreeForRun`.  Accepts any row
 *  shape that carries the three fields the helpers actually read — both
 *  `AgentRunRow` and the smaller `ReviewableRun` satisfy this without a cast. */
export interface RunBranchInput {
	handback?: string | null;
	subjectPath?: string | null;
	/** Epoch ms; falls back to 0 for the legacy reconstruction tier. */
	startedAt?: number;
}

/** Authoritative branch for `run`. Falls through three tiers; returns empty
 *  string only when none of the tiers can produce a name (i.e. no
 *  subjectPath AND no startedAt — should never happen for a persisted row). */
export function branchForRun(run: RunBranchInput): string {
	// Tier 1 — agent-reported branch. Authoritative when present.
	const hb = parseHandback(run.handback ?? null);
	if (hb && typeof hb.branch === 'string' && hb.branch.trim()) {
		return hb.branch.trim();
	}
	// Tier 2 — ADR-022 reconstruction.
	if (run.subjectPath) {
		return `claude-soul/${safeId(run.subjectPath)}`;
	}
	// Tier 3 — legacy pre-ADR-022 reconstruction (for old rows that may
	// still be sitting in the database). Subject path was the only
	// per-run key, so the formula breaks down without it.
	if (run.startedAt) {
		return `orchestration/run-${run.startedAt}/${safeId(run.subjectPath ?? '')}`;
	}
	return '';
}

/** Authoritative worktree path for `run`, anchored at `repoPath`.
 *  Same three-tier fallback as `branchForRun`, applied to the directory name. */
export function worktreeForRun(run: RunBranchInput, repoPath: string): string {
	// Tier 1+2 — ADR-022 per-ADR directory (same name as the branch slug).
	if (run.subjectPath) {
		return join(repoPath, '.worktrees', safeId(run.subjectPath));
	}
	// Tier 3 — legacy per-run directory.
	return join(repoPath, '.worktrees', `run-${run.startedAt}-${safeId(run.subjectPath ?? '')}`);
}

/** Branch-list glob pattern covering both ADR-022 and legacy branches.
 *  Use this as the `git branch --list` argument so the live-branches set
 *  catches both conventions during the migration window. Eventually
 *  `orchestration/*` can be dropped once no legacy rows remain. */
export const RUN_BRANCH_GLOBS = ['claude-soul/*', 'orchestration/*'] as const;
