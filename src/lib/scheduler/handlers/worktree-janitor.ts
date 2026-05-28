/** Task handler: worktree-janitor (ADR-038 Layer B).
 *
 *  Daily scheduled safety-net for orchestration worktrees that Layer A
 *  (cleanup-on-merge in ship-merge) missed: runs that errored, were abandoned,
 *  or were merged outside ship-merge (e.g. a manual `git merge`).
 *
 *  Safety contract — only the merged guard makes automation safe:
 *    - Merged   (branch is ancestor of main): remove worktree + `git branch -d`.
 *    - Unmerged (inactive but awaiting review):  escalated, NEVER deleted.
 *      Surfaces count + branch names in the run output for operator action.
 *
 *  Settings shape:
 *
 *      {
 *        id: 'worktree-janitor-daily',
 *        type: 'worktree-janitor',
 *        cron: '0 3 * * *',                 // 03:00 daily
 *        params: {
 *          repo: '~/dev/soul-hub'           // optional; defaults to SOUL_HUB_REPO env or cwd()
 *        }
 *      }
 */

import type { TaskFn } from '../task-types.js';
import { detectOrphanWorktrees, cleanupOrphanWorktrees } from '../../orchestration/worktree.js';
import { listActiveRuns } from '../../orchestration/board.js';
import { expandHome } from '../../agents/dispatch/worktree-provision.js';

interface WorktreeJanitorParams {
	repo?: string;
}

function isParams(value: unknown): value is WorktreeJanitorParams {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	if ('repo' in v && typeof v.repo !== 'string') return false;
	return true;
}

export interface WorktreeJanitorResult {
	reclaimed: number;
	escalated: number;
	escalatedBranches: string[];
	errors: string[];
	summary: string;
}

export function worktreeJanitorFactory(params: unknown): TaskFn {
	if (!isParams(params)) {
		throw new Error(
			`worktree-janitor: params must be an object (got ${JSON.stringify(params)})`,
		);
	}

	const repoParam = params.repo;

	return async (): Promise<WorktreeJanitorResult> => {
		// Resolve repo path: params → env → cwd (same fallback chain as ship-merge).
		const repoDir = expandHome(
			repoParam ?? process.env.SOUL_HUB_REPO ?? process.cwd(),
		);

		// Collect active run IDs so detectOrphanWorktrees knows what's still live.
		const activeRuns = await listActiveRuns();
		const activeRunIds = new Set(activeRuns.map((r) => r.runId));

		// Find worktrees whose runId is no longer in the active set.
		const orphans = await detectOrphanWorktrees(repoDir, activeRunIds);

		if (orphans.length === 0) {
			return {
				reclaimed: 0,
				escalated: 0,
				escalatedBranches: [],
				errors: [],
				summary: 'worktree-janitor: no orphan worktrees found',
			};
		}

		// Harden: merged → reclaim; unmerged → escalate.
		const result = await cleanupOrphanWorktrees(repoDir, orphans);

		const summary =
			`worktree-janitor: reclaimed ${result.cleaned}, escalated ${result.escalated.length}` +
			(result.errors.length > 0 ? `, ${result.errors.length} error(s)` : '');

		// Surface escalated branches so the operator can inspect abandoned runs.
		if (result.escalated.length > 0) {
			console.warn(
				`[worktree-janitor] ${result.escalated.length} unmerged orphan(s) escalated for operator review:`,
				result.escalated,
			);
		}
		if (result.errors.length > 0) {
			console.error('[worktree-janitor] cleanup errors:', result.errors);
		}

		console.log(`[worktree-janitor] ${summary}`);

		return {
			reclaimed: result.cleaned,
			escalated: result.escalated.length,
			escalatedBranches: result.escalated,
			errors: result.errors,
			summary,
		};
	};
}
