/**
 * Redeploy-status helpers (ADR-016 + ADR-018) — local-operator sibling of
 * src/lib/update-check/index.ts.
 *
 * Status file: ~/.soul-hub/data/redeploy-status.json
 * Written by:  scripts/redeploy.mjs (detached worker)
 *              reconcileRedeployStatusOnBoot (on every server start — ADR-018)
 * Read by:     GET /api/system/version (`deploy.redeployStatus`)
 *              POST /api/system/redeploy (before spawn)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { soulHubDataFile } from '../paths.js';

/** Live status written by scripts/redeploy.mjs during a redeploy run.
 *  Mirrors the shape of UpdateStatus but for the local-deploy flow. */
export interface RedeployStatus {
	state: 'idle' | 'started' | 'building' | 'reloading' | 'done' | 'failed';
	startedAt?: string;
	finishedAt?: string;
	/** git SHA the build was running from (BUILD_SHA at request time). */
	fromSha?: string;
	/** git HEAD SHA being deployed to. */
	toSha?: string;
	/** Error message on state === 'failed'. */
	error?: string;
}

/** Read the current redeploy status. Returns `{ state: 'idle' }` when no
 *  redeploy has run or the file is corrupt. Never throws. */
export function readRedeployStatus(): RedeployStatus {
	try {
		const raw = readFileSync(soulHubDataFile('redeploy-status.json'), 'utf-8');
		const parsed = JSON.parse(raw) as Partial<RedeployStatus>;
		if (typeof parsed.state === 'string') return parsed as RedeployStatus;
	} catch {
		/* no file yet or corrupt — treat as idle */
	}
	return { state: 'idle' };
}

/**
 * ADR-018 — Reconcile any in-flight redeploy status on server boot.
 *
 * A fresh server start is proof that no redeploy can still be in flight:
 * the detached worker either wrote `done` / `failed`, or it was killed by
 * the very `pm2 reload` it triggered — leaving the status frozen at
 * `building` or `reloading`. Derive truth from the running build's SHA:
 *
 *   state ∈ {building, reloading} AND toSha === buildSha
 *     → this build IS the reload target → write state:done
 *
 *   state ∈ {building, reloading} otherwise (no toSha, or toSha ≠ buildSha)
 *     → the in-flight deploy did NOT reach this build → write state:failed
 *
 *   state ∈ {done, failed, idle, started} or missing file
 *     → terminal / already resolved; nothing to do
 *
 * Best-effort: any write failure is logged but never crashes boot.
 * Idempotent: a second call on a terminal status is a no-op.
 */
export function reconcileRedeployStatusOnBoot(buildSha: string): void {
	const status = readRedeployStatus();

	// Only act on the two genuinely stuck-by-reload states.
	if (status.state !== 'building' && status.state !== 'reloading') return;

	const now = new Date().toISOString();
	let reconciled: RedeployStatus;

	if (status.toSha && status.toSha === buildSha) {
		// The current server WAS built from toSha → the reload succeeded.
		reconciled = { ...status, state: 'done', finishedAt: now };
	} else {
		// toSha is absent or different — the in-flight deploy didn't produce this build.
		reconciled = {
			...status,
			state: 'failed',
			finishedAt: now,
			error:
				'reload did not reach target — worker likely terminated by its own reload; see redeploy.log',
		};
	}

	try {
		writeFileSync(
			soulHubDataFile('redeploy-status.json'),
			JSON.stringify(reconciled, null, 2) + '\n',
			'utf-8',
		);
		const suffix = status.toSha ? ` (toSha=${status.toSha.slice(0, 8)})` : '';
		console.log(`[redeploy] boot reconcile: ${status.state} → ${reconciled.state}${suffix}`);
	} catch (e) {
		console.error(
			'[redeploy] WARNING: boot reconcile write failed (non-fatal):',
			(e as Error).message,
		);
	}
}

/** Reset the status to a fresh `started` before spawning the redeployer, so
 *  the UI can never read a stale `done`/`failed` from a previous run during
 *  the brief window before redeploy.mjs writes its own first status.
 *  Best-effort — a write failure must not abort the spawn. */
export function resetRedeployStatus(fromSha: string, toSha: string): void {
	try {
		const now = new Date().toISOString();
		const status: RedeployStatus = {
			state: 'started',
			startedAt: now,
			fromSha,
			toSha,
		};
		writeFileSync(
			soulHubDataFile('redeploy-status.json'),
			JSON.stringify(status, null, 2) + '\n',
			'utf-8',
		);
	} catch {
		/* best-effort */
	}
}
