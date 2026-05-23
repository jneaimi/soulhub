/** GET /api/contracts/touching?path=<abs-or-relative> — soul-hub-governance ADR-002 (P2).
 *
 *  The design-time question: "what contracts does a change to this file touch?"
 *  Served from the compiled cache (instant, offline-safe); compiles on demand
 *  when the cache is cold and the vault engine is up. Same answer the CLI and the
 *  global advisory hook resolve — this endpoint is the chat/agent/web surface. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { freshCache, touching } from '$lib/contracts/registry.js';

export const GET: RequestHandler = async ({ url }) => {
	const raw = url.searchParams.get('path');
	if (!raw) return json({ ok: false, error: 'path query param is required' }, { status: 400 });

	// Expand ~ and resolve relative paths (cwd is the soul-hub repo under PM2).
	const abs = raw.startsWith('~') ? resolve(homedir(), raw.slice(1).replace(/^\/+/, '')) : resolve(raw);

	const reg = freshCache();
	const contracts = touching(abs, reg).map((c) => ({
		id: c.id,
		area: c.area,
		guarantees: c.guarantees,
		falsifier: c.falsifier,
		dependsOn: c.dependsOn ?? [],
	}));

	return json({
		ok: true,
		path: abs,
		registryLoaded: reg !== null,
		compiledAt: reg?.compiledAt ?? null,
		count: contracts.length,
		contracts,
	});
};
