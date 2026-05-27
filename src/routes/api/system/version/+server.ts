import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { APP_NAME, APP_VERSION } from '$lib/version.js';
import { getUpdateState, readUpdateStatus } from '$lib/update-check/index.js';
import { readRedeployStatus } from '$lib/redeploy/index.js';
import { getDeployBlock, makeRealGitRunner } from '$lib/redeploy/detect.js';
import { BUILD_SHA } from '$lib/build-info.js';
import { config } from '$lib/config.js';

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
 *
 * ADR-016 — when `localRedeploy` feature flag is on, also appends a `deploy`
 * block with the SHA-delta between the running build and live HEAD. This block
 * is entirely omitted when the flag is off (public installs see nothing).
 * Must stay <50 ms and never throw — any git failure degrades to
 * `deployPending: false`.
 */
export const GET: RequestHandler = async () => {
	const update = getUpdateState(APP_VERSION);

	const base = {
		name: APP_NAME,
		version: APP_VERSION,
		latestVersion: update.latestVersion,
		releaseUrl: update.releaseUrl,
		checkedAt: update.checkedAt,
		updateAvailable: update.updateAvailable,
		// ADR-011 — live one-click-update progress/outcome (null when none has run).
		updateStatus: readUpdateStatus(),
	};

	// ADR-016 — deploy-pending block. Omitted entirely when localRedeploy is off
	// so public installs see no surface and the endpoint signature is unchanged.
	if (config.features.localRedeploy !== true) {
		return json(base);
	}

	const git = makeRealGitRunner(process.cwd());
	const deploy = getDeployBlock(BUILD_SHA, git, readRedeployStatus);

	return json({ ...base, deploy });
};
