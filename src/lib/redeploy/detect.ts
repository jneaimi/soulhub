/**
 * Deploy-pending detection helpers (ADR-016).
 *
 * Extracted as a pure, injectable function so the version endpoint
 * and its unit tests share the same logic (no live git / no process.cwd()
 * dependency in tests).
 */
import { execFileSync } from 'node:child_process';
import type { RedeployStatus } from './index.js';

/** Injectable git runner — real impl uses execFileSync, tests inject a stub. */
export interface GitRunner {
	/** Run `git rev-parse HEAD`. Returns null on any error. */
	revParseHead(): string | null;
	/** Run `git rev-list --count <baseSha>..HEAD`. Returns 0 on any error. */
	revListCount(baseSha: string): number;
}

/** Shape returned by getDeployBlock (embedded in the version endpoint response). */
export interface DeployBlock {
	deployedSha: string;
	headSha: string;
	deployPending: boolean;
	commitsBehind: number;
	redeployStatus: RedeployStatus;
}

/**
 * Compute the deploy-pending block for GET /api/system/version.
 *
 * Pure function of its inputs — no side effects, no process.cwd() calls.
 * Callers inject `buildSha`, `git`, and `readStatus` so this is testable.
 *
 * Rules:
 *   - `deployPending` is only true when ALL are true:
 *     1. buildSha is not 'unknown' (build was stamped)
 *     2. headSha is non-null (git is available)
 *     3. buildSha !== headSha (there are new commits)
 *   - On any git failure, headSha is null → deployPending is false (never
 *     false-positive).
 *   - `commitsBehind` is 0 when deployPending is false (avoid a second git
 *     call when we already know there's no drift).
 */
export function getDeployBlock(
	buildSha: string,
	git: GitRunner,
	readStatus: () => RedeployStatus,
): DeployBlock {
	const headSha = git.revParseHead();
	const deployPending =
		buildSha !== 'unknown' && headSha !== null && headSha !== buildSha;
	const commitsBehind =
		deployPending && headSha !== null ? git.revListCount(buildSha) : 0;

	return {
		deployedSha: buildSha,
		headSha: headSha ?? 'unknown',
		deployPending,
		commitsBehind,
		redeployStatus: readStatus(),
	};
}

/**
 * Real GitRunner backed by execFileSync.
 * Never throws — all git failures degrade gracefully.
 */
export function makeRealGitRunner(cwd: string): GitRunner {
	return {
		revParseHead(): string | null {
			try {
				const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
					cwd,
					encoding: 'utf-8',
					stdio: ['ignore', 'pipe', 'ignore'],
					timeout: 3000,
				}).trim();
				return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
			} catch {
				return null;
			}
		},
		revListCount(baseSha: string): number {
			try {
				const out = execFileSync('git', ['rev-list', '--count', `${baseSha}..HEAD`], {
					cwd,
					encoding: 'utf-8',
					stdio: ['ignore', 'pipe', 'ignore'],
					timeout: 3000,
				}).trim();
				const n = parseInt(out, 10);
				return isNaN(n) ? 0 : n;
			} catch {
				return 0;
			}
		},
	};
}
