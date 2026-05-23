/**
 * GET /api/openrouter/balance — return current OpenRouter spend + limit.
 *
 * Always 200. Returns `{ available: false }` when the key is missing or
 * the live fetch failed and no cache is warm — the UI uses that flag to
 * hide the chip cleanly.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getOpenRouterBalance } from '$lib/agents/openrouter-balance.js';

export const GET: RequestHandler = async ({ url }) => {
	const force = url.searchParams.get('force') === '1';
	const balance = await getOpenRouterBalance(force);
	if (!balance) return json({ available: false });
	return json({ available: true, ...balance });
};
