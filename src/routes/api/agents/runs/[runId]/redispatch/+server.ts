/**
 * POST /api/agents/runs/[runId]/redispatch — ADR-020 P2.
 *
 * Re-dispatch a TERMINAL run against the same ADR. Reuses the per-ADR
 * worktree (ADR-022) — same branch, prior commits at HEAD — and auto-builds
 * a structured continuation prompt that primes the new agent with the prior
 * run's status, cost, branch, last commit, and `git diff main..HEAD --stat`.
 *
 * Unlike `bump-continue` (ADR-019 P2 — same Claude session, pause→resume on
 * paused runs), this endpoint fires a FRESH Claude session against a TERMINAL
 * run. The session is new; only the worktree state carries forward via
 * ADR-022's `subjectPath`-keyed worktree reuse.
 *
 * Workflow:
 *   1. Validate run is in `TERMINAL_FOR_REDISPATCH` (not running, not paused).
 *   2. Require `subjectPath` — no artifact means no per-ADR worktree to reuse.
 *   3. Resolve repo + worktree path (ADR-022 formula).
 *   4. Build the continuation prompt with `buildRedispatchPrompt`.
 *   5. Fire-and-forget `dispatchAgent` with the same `subjectPath`, no
 *      `resumeSessionId` (fresh session), and an explicit `phase` derived
 *      from prior run history (or honour the operator's `phase` body field).
 *
 * Body (optional):
 *   ```json
 *   { "operatorContext": "remaining: ship the gate-runner + update CLAUDE.md",
 *     "phase": "finish" }
 *   ```
 *
 * Same-origin-strict guard (Sec-Fetch-Site = same-origin); curl/external = 403.
 *
 * Status semantics:
 *   200 → re-dispatch launched (returns `{ ok, runId, prior, branch, worktreePath, phase }`)
 *   400 → run not terminal, or has no subjectPath
 *   403 → cross-origin call rejected
 *   404 → run not found
 *   500 → internal error
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAgentRun, derivePhase } from '$lib/agents/runs.js';
import { resolveProjectRepo } from '$lib/agents/dispatch/resolve-project-repo.js';
import { safeId, expandHome } from '$lib/agents/dispatch/worktree-provision.js';
import { getVaultEngine } from '$lib/vault/index.js';
import { buildRedispatchPrompt, type GitRunner } from '$lib/agents/dispatch/redispatch-prompt.js';

const execFileAsync = promisify(execFile);

/** Statuses where re-dispatch is meaningful — every TERMINAL state where the
 *  worktree might hold partial work the next dispatch should pick up.
 *  `running` and the `awaiting-*` statuses are excluded: those are handled by
 *  the existing pause/bump-continue path (ADR-019 P2). */
const TERMINAL_FOR_REDISPATCH = new Set([
	'success',
	'goal_achieved',
	'error',
	'timeout',
	'cancelled',
	'interrupted',
	'budget-exceeded',
]);

export const POST: RequestHandler = async ({ request, params }) => {
	// Same-origin guard — write-effect endpoint, browser-only.
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite !== 'same-origin') {
		return json(
			{ error: 'Forbidden — redispatch requires a same-origin browser request' },
			{ status: 403 },
		);
	}

	const runId = params.runId;
	if (!runId) return json({ error: 'runId required' }, { status: 400 });

	const run = getAgentRun(runId);
	if (!run) return json({ error: `Run '${runId}' not found` }, { status: 404 });

	if (!TERMINAL_FOR_REDISPATCH.has(run.status)) {
		return json(
			{
				error:
					`Run is in status '${run.status}' — redispatch only applies to terminal states: ` +
					[...TERMINAL_FOR_REDISPATCH].join(', '),
			},
			{ status: 400 },
		);
	}

	if (!run.subjectPath) {
		return json(
			{
				error:
					'Run has no subject_path — re-dispatch needs a per-ADR worktree (ADR-022). ' +
					'For no-artifact runs, use the standard dispatch endpoint.',
			},
			{ status: 400 },
		);
	}

	// Parse optional body. Empty / non-JSON falls back to defaults.
	let operatorContext: string | undefined;
	let explicitPhase: string | undefined;
	try {
		const body = (await request.json().catch(() => ({}))) as {
			operatorContext?: unknown;
			phase?: unknown;
		};
		if (typeof body.operatorContext === 'string') operatorContext = body.operatorContext;
		if (typeof body.phase === 'string' && body.phase.trim()) explicitPhase = body.phase.trim();
	} catch {
		/* empty body is fine */
	}

	// Resolve repo: prefer the run's own `repo` (set at dispatch time per
	// ADR-031 P1); fall back to project binding via the artifact's index.
	const repo =
		run.repo ??
		resolveProjectRepo(run.subjectPath, (p) => getVaultEngine()?.getNote(p));
	if (!repo) {
		return json(
			{
				error:
					'No repo binding — cannot reuse worktree. Add `repo:` to the project index ' +
					'or set `repo:` on the original run.',
			},
			{ status: 400 },
		);
	}

	const repoPath = expandHome(repo);
	const adrKey = safeId(run.subjectPath);
	const worktreePath = join(repoPath, '.worktrees', adrKey);
	const branch = `claude-soul/${adrKey}`;

	if (!existsSync(worktreePath)) {
		return json(
			{
				error:
					`Worktree missing at ${worktreePath}. ADR-022 cleans worktrees on ship/reject — ` +
					'the prior run was probably shipped or rejected. Use the standard dispatch endpoint ' +
					'to start a fresh attempt against this ADR.',
			},
			{ status: 400 },
		);
	}

	// Build the continuation prompt. Git failures degrade gracefully via the
	// builder's internal try/catch.
	const runGit: GitRunner = async (args) => {
		const { stdout } = await execFileAsync('git', ['-C', worktreePath, ...args], {
			maxBuffer: 4 * 1024 * 1024,
		});
		return stdout;
	};
	const promptBody = await buildRedispatchPrompt(
		{ prior: run, worktreePath, branch, operatorContext },
		runGit,
	);

	// Phase precedence: operator's explicit body field wins; otherwise derive
	// from prior run history (ADR-020 P1). For terminal-success priors this
	// will be 'follow-up'; for failures, 'retry-N'.
	const phase = explicitPhase ?? derivePhase(run.subjectPath) ?? 'finish';

	// Detached fire-and-forget. Sub-100ms response; the multi-minute PTY run
	// proceeds asynchronously and surfaces through the same workbench lanes.
	void (async () => {
		try {
			const { dispatchAgent } = await import('$lib/agents/dispatch/index.js');
			const gen = dispatchAgent(run.agentId, promptBody, {
				mode: 'production',
				// NO resumeSessionId — fresh Claude session. The worktree carries
				// the work forward (ADR-022 reuses by subjectPath alone).
				subjectPath: run.subjectPath ?? undefined,
				phase,
				// ADR-006 P2 — re-dispatches are pausable by default (background work).
				pausableOnCeiling: true,
			});
			while (!(await gen.next()).done) {
				/* drain */
			}
		} catch (err) {
			console.error(
				`[agents/redispatch] re-dispatch failed for run ${runId}: ${(err as Error).message}`,
			);
		}
	})();

	return json({
		ok: true,
		runId,
		prior: {
			status: run.status,
			costUsd: run.costUsd,
			numTurns: run.numTurns,
			phase: run.phase,
		},
		branch,
		worktreePath,
		phase,
	});
};
