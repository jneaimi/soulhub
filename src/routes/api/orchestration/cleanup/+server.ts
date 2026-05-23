import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { listActiveRuns } from '$lib/orchestration/board.js';
import {
	detectOrphanWorktrees,
	cleanupOrphanWorktrees,
	cleanStaleLocks,
} from '$lib/orchestration/worktree.js';

/** GET /api/orchestration/cleanup — dry-run orphan detection */
export const GET: RequestHandler = async ({ url }) => {
	const projectPath = url.searchParams.get('projectPath');
	if (!projectPath) {
		return json({ error: 'projectPath query parameter required' }, { status: 400 });
	}

	try {
		const activeRuns = await listActiveRuns();
		const activeRunIds = new Set(activeRuns.map((r) => r.runId));
		const orphans = await detectOrphanWorktrees(projectPath, activeRunIds);

		return json({
			orphans: orphans.map((o) => ({ path: o.path, branch: o.branch, locked: o.isLocked })),
			count: orphans.length,
		});
	} catch (err) {
		return json({ error: (err as Error).message || 'Check failed' }, { status: 500 });
	}
};

/** POST /api/orchestration/cleanup — detect and clean orphaned resources */
export const POST: RequestHandler = async ({ url }) => {
	const dryRun = url.searchParams.get('dryRun') === 'true';
	const projectPath = url.searchParams.get('projectPath');

	if (!projectPath) {
		return json({ error: 'projectPath query parameter required' }, { status: 400 });
	}

	try {
		const activeRuns = await listActiveRuns();
		const activeRunIds = new Set(activeRuns.map((r) => r.runId));
		const orphans = await detectOrphanWorktrees(projectPath, activeRunIds);

		if (dryRun) {
			return json({
				dryRun: true,
				orphans: orphans.map((o) => ({ path: o.path, branch: o.branch, locked: o.isLocked })),
				count: orphans.length,
			});
		}

		const result = await cleanupOrphanWorktrees(projectPath, orphans);
		const locksRemoved = await cleanStaleLocks(projectPath);

		return json({
			cleaned: result.cleaned,
			errors: result.errors,
			locksRemoved,
			total: orphans.length,
		});
	} catch (err) {
		return json({ error: (err as Error).message || 'Cleanup failed' }, { status: 500 });
	}
};
