/**
 * /api/documents/index — canonical document-index (ADR-033 CP1).
 *
 * GET builds the document-index from catalog/documents/, atomically writes
 * catalog/document-index.json, and returns it. Same hybrid-storage contract as
 * /api/components/index + /api/brands/index.
 */
import type { RequestHandler } from './$types';
import {
	buildDocumentIndex,
	writeDocumentIndexToDisk,
	serializeDocumentIndex,
} from '$lib/naseej/document-index.js';

export const GET: RequestHandler = async () => {
	const index = await buildDocumentIndex();
	try {
		await writeDocumentIndexToDisk(index);
	} catch {
		// best-effort
	}
	return new Response(serializeDocumentIndex(index), {
		headers: { 'content-type': 'application/json' },
	});
};
