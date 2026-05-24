/** Task handler: update-check (ADR-010).
 *
 *  Daily public-release drift check. Fetches GitHub /releases/latest and writes
 *  the cache the version endpoint + AppHeader banner read. Honours the run's
 *  abort signal so `killRun` cancels the in-flight fetch. No-ops on network
 *  error (refreshUpdateCache leaves the cache stale rather than throwing).
 *
 *  Only reconciled when `features.updateCheck` is true — the merge in
 *  applyAdditiveSchemaDefaults drops this task otherwise (ADR-010 F1). */

import type { TaskCtx, TaskFn } from '../task-types.js';
import { refreshUpdateCache } from '../../update-check/index.js';

export function updateCheckTaskFactory(_params: unknown): TaskFn {
	return async (ctx?: TaskCtx) => {
		const cache = await refreshUpdateCache(ctx?.signal);
		return cache
			? { ok: true, latestTag: cache.latestTag, checkedAt: cache.checkedAt }
			: { ok: false, note: 'fetch failed or no release; cache left stale' };
	};
}
