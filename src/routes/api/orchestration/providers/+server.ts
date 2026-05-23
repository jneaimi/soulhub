import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { detectProviders } from '$lib/orchestration/providers/index.js';

/** GET /api/orchestration/providers — list available providers */
export const GET: RequestHandler = async () => {
	const available = await detectProviders();
	return json({ providers: available });
};
