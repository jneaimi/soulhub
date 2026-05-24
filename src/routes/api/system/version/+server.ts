import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { APP_NAME, APP_VERSION } from '$lib/version.js';
import { getUpdateState } from '$lib/update-check/index.js';

/**
 * GET /api/system/version — report the running build's name + semver, plus the
 * latest published release (ADR-010) when the update-check cache has been
 * populated.
 *
 * `version` is inlined at build time (cheap, always available). `latestVersion`
 * / `releaseUrl` / `updateAvailable` are a single local cache-file read
 * (~/.soul-hub/data/update-check.json) — never a live GitHub fetch — so this
 * stays well under 50ms with the network down and returns
 * `latestVersion: null` on a cold cache (ADR-010 F2). The daily `update-check`
 * scheduler task refreshes the cache; on the operator's private instance
 * (feature flag off) that task never runs, so `latestVersion` stays null.
 */
export const GET: RequestHandler = async () => {
	const update = getUpdateState(APP_VERSION);
	return json({
		name: APP_NAME,
		version: APP_VERSION,
		latestVersion: update.latestVersion,
		releaseUrl: update.releaseUrl,
		checkedAt: update.checkedAt,
		updateAvailable: update.updateAvailable,
	});
};
