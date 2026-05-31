/** ADR-010 (soul-hub-agents) — per-dispatch git worktree provisioning for
 *  repo-scoped agents (those carrying a `repo` frontmatter field).
 *
 *  Reuses the orchestration engine's battle-tested worktree machinery
 *  (`createWorktree` — git mutex, --lock, auto-gitignore of `.worktrees/`) and
 *  adds a copy-on-write `node_modules` link so the agent can run
 *  `npm run check` / `build` in an isolated checkout immediately.
 *
 *  The hardened `claude-pty` spawn path is deliberately UNCHANGED: the PTY still
 *  launches in `vaultDir` (so ADR-004's cwd-derived transcript locator + run-tail
 *  are untouched). We inject a `cd <worktree>` directive into the task and the
 *  agent works in the worktree — the same cd-to-repo pattern the `developer`
 *  agent already uses, just pointed at an isolated tree instead of the shared
 *  checkout. This is what lets a coding agent run concurrently with the operator
 *  (and other agents) without rewriting a shared branch or the live `build/`. */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorktree, createWorktreeAt } from '../../orchestration/worktree.js';

const execFileAsync = promisify(execFile);

export interface AgentWorktree {
	worktreePath: string;
	branch: string;
	repoPath: string;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
	return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

/** Sanitize an arbitrary subject into a git-worktree-safe id (`[\w-]+`, per
 *  `worktree.ts` validateId). Takes the path basename, strips `.md`.
 *
 *  Exported so the Workbench endpoint can reconstruct the branch name for a
 *  paused `awaiting-operator-input` run without a schema change (ADR-026 P2b). */
export function safeId(s: string): string {
	const base = s.split('/').pop()?.replace(/\.md$/i, '') ?? s;
	return base.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task';
}

/** Provision an isolated git worktree for a repo-scoped agent dispatch.
 *  Returns the worktree path + branch, or throws (the caller aborts the
 *  dispatch BEFORE spawning — ADR-010 failure mode: never spawn into a
 *  half-provisioned state). */
export async function provisionAgentWorktree(
	repo: string,
	runKey: string,
	subject: string | undefined,
): Promise<AgentWorktree> {
	const repoPath = expandHome(repo);
	if (!existsSync(join(repoPath, '.git'))) {
		throw new Error(`agent repo is not a git repository: ${repoPath}`);
	}
	const taskId = safeId(subject ?? 'task');
	const { worktreePath, branch } = await createWorktree(repoPath, runKey, taskId);

	// Copy-on-write node_modules so the worktree runs check/build immediately.
	// macOS APFS `cp -Rc` is near-instant + space-shared. Best-effort: if it
	// fails (non-APFS / cross-device), the agent can `npm ci` in the worktree —
	// don't fail provisioning on the link step.
	const src = join(repoPath, 'node_modules');
	const dst = join(worktreePath, 'node_modules');
	if (existsSync(src) && !existsSync(dst)) {
		try {
			await execFileAsync('cp', ['-Rc', src, dst], { maxBuffer: 64 * 1024 * 1024 });
		} catch (err) {
			console.warn(`[agents/worktree] node_modules CoW link failed: ${(err as Error).message}`);
		}
	}
	return { worktreePath, branch, repoPath };
}

/** Guard a branch name: letters, digits, `/`, `-`, `_`, `.` — same chars git
 *  allows in practice. Max 200 chars. Throws on violation so the caller can
 *  surface a clear error rather than letting git fail cryptically. */
function guardBranch(b: string): string {
	if (!b || !/^[\w/.-]+$/.test(b) || b.length > 200) {
		throw new Error(`unsafe or empty branch name: ${JSON.stringify(b)}`);
	}
	return b;
}

/**
 * ADR-024 D2 — Re-provision the worktree for an EXISTING branch so a
 * resume-dispatch can work in the same tree the original run left behind.
 *
 * Idempotent:
 *   1. Scan `git worktree list --porcelain` for an entry already on `branch`.
 *      If one exists, re-use its path (no-op for git; just ensures node_modules).
 *   2. If none found, add a fresh worktree at `.worktrees/resume-<slug>`.
 *   3. CoW-link node_modules from the repo root (same as provisionAgentWorktree).
 *
 * Throws on bad branch name or missing git repo — the caller aborts the dispatch
 * before spawning, per ADR-010 failure mode. */
export async function provisionResumeWorktree(
	repo: string,
	branch: string,
): Promise<AgentWorktree> {
	const repoPath = expandHome(repo);
	if (!existsSync(join(repoPath, '.git'))) {
		throw new Error(`agent repo is not a git repository: ${repoPath}`);
	}
	const safeBranchName = guardBranch(branch);

	// 1. Scan existing worktrees for this branch.
	const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
		cwd: repoPath,
	});
	let existingPath: string | null = null;
	let currentWtPath = '';
	for (const line of stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			currentWtPath = line.slice('worktree '.length).trim();
		} else if (line.startsWith('branch refs/heads/')) {
			const b = line.slice('branch refs/heads/'.length).trim();
			if (b === safeBranchName) {
				existingPath = currentWtPath;
			}
		}
	}

	let worktreePath: string;
	if (existingPath) {
		// Reuse the existing worktree — idempotent.
		worktreePath = existingPath;
	} else {
		// 2. Add a new worktree for the existing branch.
		const slug = safeBranchName.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
		worktreePath = join(repoPath, '.worktrees', `resume-${slug}`);
		await execFileAsync('git', ['worktree', 'add', '--lock', worktreePath, safeBranchName], {
			cwd: repoPath,
		});
	}

	// 3. CoW node_modules (best-effort, same as provisionAgentWorktree).
	const src = join(repoPath, 'node_modules');
	const dst = join(worktreePath, 'node_modules');
	if (existsSync(src) && !existsSync(dst)) {
		try {
			await execFileAsync('cp', ['-Rc', src, dst], { maxBuffer: 64 * 1024 * 1024 });
		} catch (err) {
			console.warn(`[agents/worktree] node_modules CoW link failed: ${(err as Error).message}`);
		}
	}

	return { worktreePath, branch: safeBranchName, repoPath };
}

/** ADR-022 — Per-ADR worktree provisioning.
 *
 *  Derives a stable ADR key from `subjectPath` (the vault artifact path,
 *  e.g. `projects/soul-hub-agents/adr-011-general-implementer-agent.md`)
 *  via the existing `safeId` helper.  The worktree lives at
 *  `<repo>/.worktrees/<adr-key>` on branch `claude-soul/<adr-key>`.
 *
 *  Idempotent — every dispatch against the same ADR reuses the same
 *  worktree, so subsequent dispatches see the previous run's commits at
 *  HEAD without operator intervention.  Three dispatches against ADR-011
 *  → one worktree, one feature branch, one cleanup at ship time.
 *
 *  Caller (`dispatch/index.ts`) selects this helper for any dispatch with
 *  a `subjectPath` set.  Non-ADR dispatches (orchestrator background
 *  jobs, ad-hoc CLI tests with no subject path) still use the per-run
 *  `provisionAgentWorktree`.  Explicit-resume dispatches
 *  (bump-continue, manual re-dispatch with `opts.resumeBranch`) still
 *  use `provisionResumeWorktree`. */
export async function provisionAdrWorktree(
	repo: string,
	subjectPath: string,
): Promise<AgentWorktree> {
	const repoPath = expandHome(repo);
	if (!existsSync(join(repoPath, '.git'))) {
		throw new Error(`agent repo is not a git repository: ${repoPath}`);
	}
	const adrKey = safeId(subjectPath);
	const { worktreePath, branch } = await createWorktreeAt(
		repoPath,
		adrKey,
		`claude-soul/${adrKey}`,
	);

	// Copy-on-write node_modules — same best-effort as provisionAgentWorktree.
	// Skipped if the worktree already has it (idempotent for the 2nd+ dispatch).
	const src = join(repoPath, 'node_modules');
	const dst = join(worktreePath, 'node_modules');
	if (existsSync(src) && !existsSync(dst)) {
		try {
			await execFileAsync('cp', ['-Rc', src, dst], { maxBuffer: 64 * 1024 * 1024 });
		} catch (err) {
			console.warn(`[agents/worktree] node_modules CoW link failed: ${(err as Error).message}`);
		}
	}
	return { worktreePath, branch, repoPath };
}

/** The directive prepended to a repo-scoped agent's task so it works in the
 *  provisioned worktree, not the shared checkout. */
export function worktreeDirective(wt: AgentWorktree): string {
	return [
		`[WORKTREE — ADR-010] You operate on \`${wt.repoPath}\` in a DEDICATED git worktree`,
		`provisioned for this run — isolated from the operator's checkout and the live build.`,
		``,
		`  path:   ${wt.worktreePath}`,
		`  branch: ${wt.branch}  (already created + checked out; node_modules is linked)`,
		``,
		`FIRST ACTION: \`cd ${wt.worktreePath}\` — work ONLY there.`,
		`Do NOT \`git checkout\` another branch and do NOT create a new branch; commit on the`,
		`current branch. Run all verification (npm run check / build / gates) inside this worktree.`,
		`Report the branch name in your hand-back so the human can ship it.`,
		``,
		`--- task follows ---`,
		``,
	].join('\n');
}
