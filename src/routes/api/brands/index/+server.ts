/**
 * /api/brands/index — canonical brand-index (ADR-031 CP1).
 *
 * GET builds the brand-index from catalog/brands/, atomically writes
 * catalog/brand-index.json, and returns it. Same hybrid-storage contract as
 * /api/components/index: the HTTP body and the disk file are byte-identical at
 * write time.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	buildBrandIndex,
	writeBrandIndexToDisk,
	serializeBrandIndex,
} from '$lib/naseej/brand-index.js';

export const GET: RequestHandler = async () => {
	const index = await buildBrandIndex();
	try {
		await writeBrandIndexToDisk(index);
	} catch {
		// Disk write is best-effort — the built index is still returned.
	}
	return new Response(serializeBrandIndex(index), {
		headers: { 'content-type': 'application/json' },
	});
};
