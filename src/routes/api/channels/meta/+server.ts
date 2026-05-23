import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAllChannelMeta } from '$lib/channels/registry.js';

/** GET /api/channels/meta — list all channel adapters with their metadata and env status */
export const GET: RequestHandler = async () => {
	const metas = getAllChannelMeta();

	const channels = metas.map((m) => ({
		...m,
		configured: m.fields.every((f) => !!process.env[f.env]),
		missingEnv: m.fields.filter((f) => !process.env[f.env]).map((f) => f.env),
	}));

	return json(channels);
};
