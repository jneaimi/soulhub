import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { APP_NAME, APP_VERSION } from '$lib/version.js';

/**
 * GET /api/system/version — report the running build's name + semver.
 *
 * Cheap, dependency-free, and always available (the version is inlined at
 * build time). Used by the release/update spine: a client or the `npm run
 * update` flow can read this to know what version is live before/after a pull.
 */
export const GET: RequestHandler = async () => {
	return json({ name: APP_NAME, version: APP_VERSION });
};
