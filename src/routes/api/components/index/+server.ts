/**
 * GET /api/components/index — typed catalog-index for AI-as-author.
 *
 * ADR-027 P2.1. Returns the full catalog-index document (components + recipes
 * + worked examples) AI authoring agents fetch once to compose recipes.
 *
 * Side-effect: every successful GET writes `catalog/catalog-index.json` to
 * disk atomically (tmp+rename), byte-identical to the response body. The
 * disk file is the audit-trail + offline-AI surface. ADR-027 P2.2 will move
 * the disk write onto the POST /api/components + POST /api/recipes
 * publish-gate success path; for P2.1 the endpoint itself keeps the disk
 * file fresh on every fetch.
 *
 * Failure mode: build errors return 500 with `{ error }`. The disk file is
 * never partially updated — atomic rename either lands the new payload or
 * leaves the previous one untouched.
 */
import type { RequestHandler } from './$types';
import {
	buildCatalogIndex,
	serializeCatalogIndex,
	writeCatalogIndexToDisk,
} from '$lib/naseej/catalog-index.js';

export const GET: RequestHandler = async () => {
	let payload: string;
	try {
		const index = await buildCatalogIndex();
		payload = serializeCatalogIndex(index);
		await writeCatalogIndexToDisk(index);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(JSON.stringify({ error: message }), {
			status: 500,
			headers: { 'content-type': 'application/json' },
		});
	}
	return new Response(payload, {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
};
