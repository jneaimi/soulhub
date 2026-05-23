import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getFilterStats,
	getFilterWorkerStatus,
} from '$lib/inbox/index.js';

/**
 * GET /api/inbox/filter/stats
 *
 * Aggregated view for the settings UI:
 *   - byCategory counts (queued + skipped + processed distribution)
 *   - rule count (system vs user)
 *   - cache size
 *   - worker status: enabled / llmAvailable / llmDisabled / lastTickAt /
 *     lastError / backoffUntilMs
 *
 * Cheap — pure SQL COUNT + in-memory state. Safe to poll every 5-10s.
 */
export const GET: RequestHandler = async () => {
	const stats = getFilterStats();
	const worker = getFilterWorkerStatus();
	return json({ stats, worker });
};
