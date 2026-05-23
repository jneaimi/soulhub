import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { config } from '$lib/config.js';

/** GET /api/config — expose terminal + interface defaults to frontend */
export const GET: RequestHandler = async () => {
	return json({
		terminal: config.terminal,
		interface: config.interface,
	});
};
