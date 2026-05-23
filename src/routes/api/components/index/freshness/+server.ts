/**
 * GET /api/components/index/freshness — catalog-index disk-file freshness probe.
 *
 * ADR-027 P2.2. Compares the mtime of `catalog/catalog-index.json` against
 * the newest `BLOCK.md` / `recipe.yaml` mtime. Returns:
 *   exists, fresh, indexPath, indexMtime, newestSource, newestSourceMtime,
 *   ageSeconds (positive = index newer; negative = index stale by N seconds).
 *
 * Consumed by `soul doctor` to flag stale catalog-index without the CLI
 * needing to know where soul-hub is checked out on disk.
 */
import type { RequestHandler } from './$types';
import { getCatalogIndexFreshness } from '$lib/naseej/catalog-index.js';

export const GET: RequestHandler = async () => {
	const freshness = await getCatalogIndexFreshness();
	return new Response(JSON.stringify(freshness), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
};
