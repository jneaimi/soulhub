import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAdapter } from '$lib/channels/registry.js';

/** POST /api/channels/test — send a test message via a channel */
export const POST: RequestHandler = async ({ request }) => {
	const { channel } = await request.json();

	if (!channel || typeof channel !== 'string') {
		return json({ ok: false, error: 'Missing channel id' }, { status: 400 });
	}

	const adapter = getAdapter(channel);
	if (!adapter) {
		return json({ ok: false, error: `Unknown channel: ${channel}` }, { status: 404 });
	}

	if (!adapter.isConfigured()) {
		const missing = adapter.meta.fields
			.filter((f) => !process.env[f.env])
			.map((f) => f.env);
		return json(
			{ ok: false, error: `Missing env vars: ${missing.join(', ')}` },
			{ status: 400 },
		);
	}

	const result = await adapter.send('Soul Hub connected — channel test successful.');
	return json(result, { status: result.ok ? 200 : 502 });
};
