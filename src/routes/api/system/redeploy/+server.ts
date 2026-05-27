import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '$lib/config.js';
import { soulHubHome } from '$lib/paths.js';
import { checkUpdateAccess } from '$lib/update-check/access-guard.js';
import { resetRedeployStatus } from '$lib/redeploy/index.js';
import { BUILD_SHA } from '$lib/build-info.js';

/**
 * POST /api/system/redeploy — ADR-016 guarded one-click rebuild & reload.
 *
 * RCE-class: spawns a DETACHED worker that runs `rm -rf build → npm run build
 * → pm2 reload soul-hub`, which kills this very process — so we spawn-and-
 * return rather than awaiting. The UI then polls GET /api/system/version until
 * `deploy.deployPending` is false.
 *
 * Unlike /api/system/update: NO `git pull`, NO dirty-tree check — the target
 * is local HEAD already on disk. Strictly less attack surface.
 *
 * Defense in order (fail-closed, mirrors /api/system/update exactly):
 *   1. `localRedeploy` flag off  → 404 (disabled install = missing route)
 *   2. Not same-origin / bearer  → 403 (checkUpdateAccess)
 *   3. `confirm !== true`        → 400
 *   4. `expectedSha` ≠ live HEAD → 409 (stale-tab guard)
 *   5. otherwise → spawn DETACHED scripts/redeploy.mjs, return {status:'started'}
 */
export const POST: RequestHandler = async ({ request }) => {
	// 1. Feature-flag gate. Before auth so a disabled install is
	//    indistinguishable from a missing route.
	if (config.features.localRedeploy !== true) {
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

	// 4. expectedSha must match the live HEAD — stops a stale tab triggering a
	//    redeploy to a SHA the operator never confirmed.
	const repoRoot = process.cwd();
	let headSha: string;
	try {
		const out = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: repoRoot,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 3000,
		}).trim();
		if (!/^[0-9a-f]{40}$/.test(out)) {
			return json({ error: 'git returned an unexpected HEAD value' }, { status: 409 });
		}
		headSha = out;
	} catch {
		return json({ error: 'git unavailable — cannot verify HEAD SHA' }, { status: 409 });
	}

	const expected = typeof body.expectedSha === 'string' ? body.expectedSha : '';
	if (expected && expected !== headSha) {
		return json(
			{ error: 'Stale tab — reload and try again', expected, head: headSha },
			{ status: 409 },
		);
	}

	// 5. Spawn the DETACHED redeployer. It outlives the pm2 reload that kills
	//    this process. Output → ~/.soul-hub/logs/redeploy.log.
	const scriptPath = resolve(repoRoot, 'scripts', 'redeploy.mjs');
	const logDir = resolve(soulHubHome(), 'logs');
	mkdirSync(logDir, { recursive: true });
	const logPath = resolve(logDir, 'redeploy.log');
	const logFd = openSync(logPath, 'a');

	// Reset status to a fresh `started` so the UI can't read a stale outcome
	// from a previous run during the brief window before redeploy.mjs writes.
	resetRedeployStatus(BUILD_SHA, headSha);

	try {
		const child = spawn(process.execPath, [scriptPath], {
			cwd: repoRoot,
			detached: true,
			stdio: ['ignore', logFd, logFd],
		});
		child.unref();
		return json({
			status: 'started',
			fromSha: BUILD_SHA,
			toSha: headSha,
			logPath,
		});
	} catch (err) {
		return json(
			{
				error: `Failed to start redeployer: ${err instanceof Error ? err.message : String(err)}`,
			},
			{ status: 500 },
		);
	}
};
