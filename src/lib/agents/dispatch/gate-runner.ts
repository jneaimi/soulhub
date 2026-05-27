/**
 * soul-hub-agents ADR-016 — Auto-derive a gate verdict from a committed branch.
 *
 * When a production *coding* dispatch finishes `goal_achieved`/`success` with a
 * committed worktree branch but NO hand-back trailer (the agent forgot to emit
 * the ```json block), the review card cannot hydrate and Ship & merge is
 * stranded — even though the work is real and the gates may well be green.
 * (Surfaced live by soul-hub-chat ADR-002's dispatch, run #490: goal_achieved,
 *  49 turns, $3.90, 6 files committed, zero hand-back → blank card.)
 *
 * This module re-runs the generic gates (typecheck + build) against the
 * committed worktree and synthesizes a hand-back block, so the review card
 * hydrates from ground truth instead of the agent's (missing) self-report.
 *
 * Principle (the recurring workbench lesson): derive verdicts from the
 * artifact, never depend solely on the agent's free-text trailer. A forgetful
 * agent must never strand the UI — and the bar is never lowered: a genuine
 * build/typecheck failure synthesizes check/build = false → red gates →
 * Ship & merge stays blocked, exactly as a hand-back reporting red would.
 *
 * Async throughout: the build can take ~2 min and MUST NOT block the event
 * loop (this runs inside the server process), so every spawn is awaited via
 * execFile, never spawnSync.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { promisify } from 'node:util';
import { expandHome, safeId } from './worktree-provision.js';
import { isBenignDriftPath } from '../benign-drift.js';

const execFileAsync = promisify(execFile);

/** System bin dirs that must stay resolvable when the server spawns a build.
 *  Mirrors `scheduler/handlers/shell-script.ts` hardenPath — inlined here to
 *  keep the dispatch hot-path decoupled from the scheduler module. PM2/launchd
 *  strip PATH, so `npm`/`bash` would otherwise fail `ENOENT`. */
const SYSTEM_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
function hardenedPath(): string {
	const cur = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
	for (const d of SYSTEM_PATH_DIRS) if (!cur.includes(d)) cur.push(d);
	return cur.join(delimiter);
}

interface GateOutcome {
	ok: boolean;
	out: string;
}

/** Run a command in `cwd`, awaited (never blocks the loop). Non-zero exit or a
 *  timeout returns `{ ok: false }` with whatever output was captured — a failed
 *  gate must read as red, not throw. */
async function runIn(cwd: string, cmd: string, args: string[], timeoutMs: number): Promise<GateOutcome> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			cwd,
			env: { ...process.env, PATH: hardenedPath() },
			timeout: timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
		});
		return { ok: true, out: String(stdout) + String(stderr) };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? err.message ?? '') };
	}
}

export interface SynthesizeInput {
	branch: string;
	commits: string[];
	files_changed: string[];
	typecheckOk: boolean;
	buildOk: boolean;
}

/**
 * Pure: build the synthesized ```json hand-back block string from a re-run
 * gate outcome. Shaped to match the soul-hub-implementer hand-back exactly, so
 * the shared `parseHandback` + `handbackGatesGreen` consume it with no special
 * case (green iff typecheck && build both passed). Testable without any I/O.
 */
export function synthesizeHandback(input: SynthesizeInput): string {
	const green = input.typecheckOk && input.buildOk;
	const handback = {
		branch: input.branch,
		commits: input.commits,
		files_changed: input.files_changed,
		check_passed: input.typecheckOk,
		build_passed: input.buildOk,
		gate_results: {
			typecheck: input.typecheckOk ? 'pass' : 'fail',
			build: input.buildOk ? 'pass' : 'fail',
		},
		summary:
			'Auto-derived by gate-runner (soul-hub-agents ADR-016): the agent emitted no ' +
			'hand-back trailer, so typecheck + build were re-run server-side against the ' +
			'committed branch. ' +
			(green
				? 'Both gates green — safe to review/ship.'
				: 'One or more gates RED — review the branch before shipping.'),
		follow_ups: [] as string[],
	};
	return '```json\n' + JSON.stringify(handback, null, 2) + '\n```';
}

export interface DeriveGatesInput {
	/** Effective repo (project repo ?? agent.repo); `~`-form accepted. */
	repo: string;
	startedAt: number;
	subjectPath: string;
	/** Base branch the worktree was cut from. Default `main`. */
	base?: string;
}

/**
 * Re-run the generic gates against a finished run's committed worktree and
 * return a synthesized ```json hand-back block — or `null` when there's nothing
 * to validate (worktree already cleaned/merged, or branch has no commits).
 *
 * Idempotent + side-effect-free beyond reading git + running the build in the
 * worktree the run already created (which still carries its `node_modules`).
 */
export async function deriveHandbackFromBranch(input: DeriveGatesInput): Promise<string | null> {
	const repo = expandHome(input.repo);
	const base = input.base ?? 'main';
	const taskId = safeId(input.subjectPath);
	const branch = `orchestration/run-${input.startedAt}/${taskId}`;
	const worktreeDir = join(repo, '.worktrees', `run-${input.startedAt}-${taskId}`);

	// No worktree on disk → can't re-run gates (branch merged/discarded/cleaned).
	if (!existsSync(worktreeDir)) return null;

	// Commits ahead of base — proves a real artifact; bail if none.
	const commitsR = await runIn(repo, 'git', ['rev-list', `${base}..${branch}`], 15_000);
	const commits = commitsR.ok ? commitsR.out.trim().split('\n').filter(Boolean) : [];
	if (commits.length === 0) return null;

	const filesR = await runIn(repo, 'git', ['diff', '--name-only', `${base}..${branch}`], 15_000);
	const files_changed = (filesR.ok ? filesR.out.trim().split('\n') : [])
		.filter(Boolean)
		.filter((f) => !isBenignDriftPath(f)); // ADR-018 — shared benign-drift source of truth

	// Run the gates IN the worktree (it still has node_modules from the run).
	const typecheck = await runIn(worktreeDir, 'bash', ['scripts/typecheck-gate.sh'], 300_000);
	const build = await runIn(worktreeDir, 'npm', ['run', 'build'], 600_000);

	return synthesizeHandback({
		branch,
		commits,
		files_changed,
		typecheckOk: typecheck.ok,
		buildOk: build.ok,
	});
}
