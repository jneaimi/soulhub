/** GET /api/routes/list — returns every configured route with its
 *  primary + failover chain, timeout, retry count, error policy, and
 *  the live circuit-breaker snapshot per provider. Used by the Settings
 *  → Routes section to render a read-only summary. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { circuitBreaker, listRoutes } from '$lib/routes/index.js';

export const GET: RequestHandler = async () => {
	const routes = listRoutes().map(({ name, config }) => ({
		name,
		description: config.description,
		default: config.default,
		failover: config.failover,
		timeoutMs: config.timeoutMs,
		retries: config.retries,
		onError: config.onError,
	}));
	return json({ ok: true, routes, circuit: circuitBreaker.snapshot() });
};
