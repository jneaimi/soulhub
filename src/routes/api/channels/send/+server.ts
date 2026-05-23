import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAdapter } from '$lib/channels/registry.js';

/** POST /api/channels/send — send a message via a specific channel.
 *  Used by the Naseej `channel-send-text@1.0.0` component (and any other
 *  caller that needs to route arbitrary text through a channel adapter).
 *
 *  Body: `{ channel: 'telegram' | 'whatsapp', text: string }`
 *  Response: `{ ok: boolean, message_id?: string, delivered_at?: string, error?: string }`
 *
 *  Status codes: 200 on adapter success, 400 on bad input or adapter
 *  refusal (channel disabled, unconfigured, send error), 404 on unknown
 *  channel id.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const { channel, text } = body as Record<string, unknown>;

	if (!channel || typeof channel !== 'string') {
		return json({ ok: false, error: 'channel is required and must be a string' }, { status: 400 });
	}
	if (typeof text !== 'string' || !text) {
		return json({ ok: false, error: 'text is required and must be a non-empty string' }, { status: 400 });
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
			{ ok: false, error: `Channel "${adapter.meta.name}" not configured; missing env: ${missing.join(', ')}` },
			{ status: 400 },
		);
	}

	const startedAt = new Date();
	const result = await adapter.send(text);
	if (!result.ok) {
		return json({ ok: false, error: result.error ?? 'send failed' }, { status: 400 });
	}

	return json({
		ok: true,
		message_id: result.messageId ?? '',
		delivered_at: new Date().toISOString(),
		started_at: startedAt.toISOString(),
	});
};
