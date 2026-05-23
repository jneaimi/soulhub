/** POST /api/routes/test — runs a tiny "ping" through `dispatchRoute()`
 *  to verify a route's primary + failover chain end-to-end. Used by the
 *  Settings → Routes Test buttons. Returns latency, which provider
 *  actually answered, and a short transcript snippet. Any error
 *  classifies into the same `network`/`unauthorized`/`unsupported`
 *  surface that channel/provider tests use. */

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import {
	dispatchRoute,
	hasRoute,
	UnsupportedProviderError,
	ProviderUnavailableError,
	RouteNotFoundError,
	AllProvidersFailedError,
} from '$lib/routes/index.js';

export const POST: RequestHandler = async ({ request }) => {
	let body: { name?: string };
	try {
		body = (await request.json()) as { name?: string };
	} catch {
		throw error(400, 'Invalid JSON.');
	}
	const name = body.name?.trim();
	if (!name) throw error(400, 'Missing route `name`.');
	if (!hasRoute(name)) throw error(404, `Route "${name}" is not configured.`);

	const start = Date.now();
	try {
		const result = await dispatchRoute(name, {
			messages: [{ role: 'user', content: 'ping — reply with the single word "pong".' }],
			maxOutputTokens: 50,
		});
		return json({
			ok: true,
			status: 'ok',
			latencyMs: Date.now() - start,
			answeredBy: result.answeredBy,
			text: result.text.slice(0, 200),
			usage: result.usage,
		});
	} catch (err) {
		const latencyMs = Date.now() - start;
		const message = err instanceof Error ? err.message : String(err);
		let kind: 'network' | 'unconfigured' | 'unauthorized' | 'unsupported' | 'invalid' = 'invalid';
		if (err instanceof RouteNotFoundError) kind = 'invalid';
		else if (err instanceof UnsupportedProviderError) kind = 'unsupported';
		else if (err instanceof ProviderUnavailableError) kind = 'unconfigured';
		else if (err instanceof AllProvidersFailedError) kind = 'network';
		return json({ ok: false, status: kind, latencyMs, error: message });
	}
};
