import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { spawn, execSync } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '$lib/config.js';
import { APP_VERSION } from '$lib/version.js';
import { soulHubHome } from '$lib/paths.js';
import { checkUpdateAccess } from '$lib/update-check/access-guard.js';
import { readUpdateCache } from '$lib/update-check/index.js';

/**
 * POST /api/system/update — the ADR-011 guarded one-click update.
 *
 * RCE-class. It spawns a DETACHED updater that runs
 * `git pull → install → build → chokepoint resync → pm2 reload`, which kills
 * this very process — so we spawn-and-return rather than awaiting. The UI then
 * polls GET /api/system/version until the new version is live.
 *
 * Defense in order (fail-closed at every step):
 *   1. Feature flag off            → 404 (a disabled install reveals nothing)
 *   2. Not same-origin / no bearer → 403 (checkUpdateAccess — stricter than the
 *                                         file-API guard; blocks header-less
 *                                         curl, cross-site, and same-site)
 *   3. Missing confirm:true        → 400
 *   4. expectedVersion mismatch    → 409 (stale UI guard; defense in depth)
 *   5. otherwise                   → spawn detached, return { status:'started' }
 */

/** ADR-011 §2d — the only remote the spawned updater is allowed to pull from.
 *  Passed to update.mjs as `--verify-remote`; a tampered local `origin` aborts
 *  the pull. Forks change this constant (and their public repo) to match. */
const PUBLIC_REMOTE = 'https://github.com/jneaimi/soulhub';

export const POST: RequestHandler = async ({ request }) => {
	// 1. Public-only gate. Before auth so a disabled install is indistinguishable
	//    from a missing route.
	if (config.features.updateCheck !== true) {
		return json({ error: 'Not found' }, { status: 404 });
	}

	// 2. Strict access guard (same-origin browser fetch, or configured bearer).
	const access = checkUpdateAccess(request);
	if (!access.ok) {
		return json({ error: 'Forbidden', reason: access.reason }, { status: access.status ?? 403 });
	}

	// 3. Confirm payload.
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}
	if (body.confirm !== true) {
		return json({ error: 'confirm:true is required' }, { status: 400 });
	}

	// 4. expectedVersion must match the cached latest tag — stops a stale tab
	//    triggering an update to a version it never showed the operator.
	const cache = readUpdateCache();
	if (!cache?.latestTag) {
		return json({ error: 'No known update target — update-check cache is cold' }, { status: 409 });
	}
	const expected = typeof body.expectedVersion === 'string' ? body.expectedVersion : '';
	if (expected && expected !== cache.latestTag) {
		return json(
			{ error: 'Stale update target — reload and try again', expected, latest: cache.latestTag },
			{ status: 409 },
		);
	}

	// 5. Pre-flight dirty-tree check — synchronous, so the browser gets an
	//    immediate, actionable error instead of waiting out the 120s poll timeout
	//    when the detached updater would bail. Mirrors update.mjs: package-lock.json
	//    drift is tolerated (the updater discards + regenerates it); any OTHER
	//    uncommitted change blocks the pull.
	const repoRoot = process.cwd();
	try {
		const porcelain = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8' }).trim();
		const blocking = porcelain
			.split('\n')
			.filter((l) => l.trim() && !l.endsWith('package-lock.json'));
		if (blocking.length > 0) {
			return json(
				{
					error:
						'Update blocked: the install has uncommitted changes. Commit or stash them, then retry.',
					files: blocking.map((l) => l.slice(3)),
				},
				{ status: 409 },
			);
		}
	} catch {
		/* not a git checkout / git unavailable — let the updater handle it */
	}

	// 6. Spawn the DETACHED updater. It outlives the pm2 reload that kills this
	//    process. Output goes to ~/.soul-hub/logs/update.log so the operator can
	//    inspect a stalled/failed run ("check the terminal" in the UI timeout).
	const scriptPath = resolve(repoRoot, 'scripts', 'update.mjs');
	const logDir = resolve(soulHubHome(), 'logs');
	mkdirSync(logDir, { recursive: true });
	const logPath = resolve(logDir, 'update.log');
	const logFd = openSync(logPath, 'a');

	try {
		const child = spawn(
			process.execPath,
			[scriptPath, '--verify-remote', PUBLIC_REMOTE],
			{ cwd: repoRoot, detached: true, stdio: ['ignore', logFd, logFd] },
		);
		child.unref();
		return json({
			status: 'started',
			targetVersion: cache.latestTag,
			currentVersion: APP_VERSION,
			logPath,
		});
	} catch (err) {
		return json(
			{ error: `Failed to start updater: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 },
		);
	}
};
