/**
 * POST /api/agents/ship-merge — projects-graph ADR-027 P1
 *
 * Atomic "Ship & merge" for green-gated coding ADR hand-backs.
 * Performs, in order:
 *   1. Re-verifies implementer gates from the DB run record (not the client
 *      payload) — refuses the merge if gates are not all green.
 *   2. Checks HEAD is `main`, working tree is clean, and the branch exists.
 *   3. Idempotency: if the branch is already merged (no commits ahead of main),
 *      skips the merge and only flips the status.
 *   4. Merges the orchestration branch to main with `--no-ff` and an
 *      ADR-slug commit message so ADR-009's drift detector recognises it.
 *   5. Flips the ADR status to `shipped` (ONLY on merge success).
 *
 * Explicitly does NOT build, reload pm2, or push. Deploy remains a deliberate,
 * separate human step.
 *
 * Body:   { path: string }  — vault-relative path of the ADR/decision note.
 * Returns { success: true, merged: boolean, branch: string, newStatus: 'shipped' }
 *       | { success: false, error: string, mergeConflict?: boolean }
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getReviewableRunForSubject } from '$lib/agents/runs.js';
import { nonBenignDirtyPaths } from '$lib/agents/benign-drift.js';
import { safeId, expandHome } from '$lib/agents/dispatch/worktree-provision.js';
import { removeWorktree, deleteBranch } from '$lib/orchestration/worktree.js';
import { getVaultEngine } from '$lib/vault/index.js';
import { parseHandback, handbackGatesGreen } from '$lib/agents/handback.js';

const execFileAsync = promisify(execFile);
/** Generous but bounded — a local merge + vault write should finish in < 10 s. */
const GIT_TIMEOUT = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayIso(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const POST: RequestHandler = async ({ request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ success: false, error: 'Vault not initialized' }, { status: 503 });
	}

	// ── Parse & validate body ─────────────────────────────────────────────────
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const { path } = body as Record<string, unknown>;

	if (typeof path !== 'string' || !path) {
		return json({ success: false, error: 'path is required' }, { status: 400 });
	}
	// Path safety — same guards as /api/vault/decisions/transition
	if (path.includes('..') || path.startsWith('/') || !path.endsWith('.md')) {
		return json({ success: false, error: 'Invalid path' }, { status: 400 });
	}

	// ── Vault note preconditions ──────────────────────────────────────────────
	const note = engine.getNote(path);
	if (!note) {
		return json({ success: false, error: `Note not found: ${path}` }, { status: 404 });
	}
	const currentStatus = String(note.meta.status ?? '').toLowerCase();
	if (currentStatus !== 'accepted') {
		return json(
			{
				success: false,
				error: `ship-merge requires status 'accepted' (current: ${currentStatus || 'none'})`,
			},
			{ status: 409 },
		);
	}

	// ── 1. Re-verify gates from the run record ────────────────────────────────
	const run = getReviewableRunForSubject(path);
	if (!run) {
		return json(
			{
				success: false,
				error: 'No reviewable run found for this subject. Dispatch to the implementer first.',
			},
			{ status: 422 },
		);
	}

	// Prefer the full untruncated handback column; fall back to the 800-char excerpt.
	const handbackRaw = run.handback ?? run.resultExcerpt;
	if (!handbackRaw) {
		return json(
			{
				success: false,
				error: 'No hand-back found in run record — cannot verify gates. Use Mark shipped (status only) instead.',
			},
			{ status: 422 },
		);
	}

	// ADR-028 — use the shared tolerant parser so unescaped prose in summary/
	// follow_ups cannot silently block a merge when the gate fields are green.
	const parsed = parseHandback(handbackRaw);
	if (!parsed) {
		return json(
			{
				success: false,
				error: 'Could not parse gate results from run record. Use Mark shipped (status only) instead.',
			},
			{ status: 422 },
		);
	}
	if (!handbackGatesGreen(parsed)) {
		return json(
			{
				success: false,
				error: 'Gates are not all green in the run record. Fix failing gates and re-dispatch before merging.',
			},
			{ status: 422 },
		);
	}

	// ── 2. Reconstruct branch from run record (NOT from client) ───────────────
	// Exact same formula as review-handoff, worklist, and worktree-provision.
	const branch = `orchestration/run-${run.startedAt}/${safeId(path)}`;

	// ADR-031 P1 — resolve the repo root from the run record so this endpoint
	// merges into the run's actual repo, not hardcoded soul-hub.  A null `repo`
	// (legacy runs, soul-hub dispatches) falls through to the same env-var escape
	// that was here before, keeping all existing behaviour unchanged.
	const repoDir = expandHome(run.repo ?? process.env.SOUL_HUB_REPO ?? process.cwd());

	// ── 3. Git pre-flight checks ──────────────────────────────────────────────

	// HEAD must be `main`.
	let currentBranch: string;
	try {
		const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
			cwd: repoDir,
			timeout: GIT_TIMEOUT,
		});
		currentBranch = stdout.trim();
	} catch {
		return json(
			{ success: false, error: 'git unavailable — cannot verify HEAD branch' },
			{ status: 503 },
		);
	}

	if (currentBranch !== 'main') {
		return json(
			{
				success: false,
				error: `Repository HEAD is on '${currentBranch}', not 'main'. Switch to main before running Ship & merge.`,
			},
			{ status: 409 },
		);
	}

	// Working tree must be clean — EXCEPT known benign auto-gen drift (ADR-018).
	// The GitNexus index-count block in AGENTS.md/CLAUDE.md is rewritten by every
	// `gitnexus analyze`, leaving those tracked files perpetually "modified" with
	// no deliverable content. Tolerating them is safe: only those exact paths are
	// ignored, any other dirty file still blocks, and git's own merge-safety
	// refuses the merge if the branch actually touches them.
	try {
		const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
			cwd: repoDir,
			timeout: GIT_TIMEOUT,
		});
		const dirty = nonBenignDirtyPaths(stdout);
		if (dirty.length > 0) {
			return json(
				{
					success: false,
					error: `Working tree has uncommitted changes (${dirty.join(', ')}). Commit or stash them before merging.`,
				},
				{ status: 409 },
			);
		}
	} catch {
		return json({ success: false, error: 'git status failed' }, { status: 503 });
	}

	// Branch must exist.
	try {
		const { stdout } = await execFileAsync(
			'git',
			['branch', '--list', branch, '--format=%(refname:short)'],
			{ cwd: repoDir, timeout: GIT_TIMEOUT },
		);
		const exists = stdout
			.split('\n')
			.map((b) => b.trim())
			.filter(Boolean)
			.includes(branch);
		if (!exists) {
			return json(
				{
					success: false,
					error: `Branch '${branch}' not found. The worktree may have been removed — use Mark shipped (status only) instead.`,
				},
				{ status: 409 },
			);
		}
	} catch {
		return json({ success: false, error: 'git branch check failed' }, { status: 503 });
	}

	// ── 4. Idempotency: already merged? ──────────────────────────────────────
	let alreadyMerged = false;
	try {
		const { stdout } = await execFileAsync(
			'git',
			['rev-list', '--count', `main..${branch}`],
			{ cwd: repoDir, timeout: GIT_TIMEOUT },
		);
		alreadyMerged = Number(stdout.trim()) === 0;
	} catch {
		// Cannot determine — proceed with the merge attempt.
	}

	// ── 5. Merge (skip if branch already fully merged) ────────────────────────
	if (!alreadyMerged) {
		// ADR-009-compatible message: include the file slug so the drift detector
		// (`adr-implementation-drift.ts`) picks it up via `line.includes(slug)`.
		const slug = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
		const mergeMessage = `merge: ${slug} — ${note.title}`;

		try {
			await execFileAsync('git', ['merge', '--no-ff', '-m', mergeMessage, branch], {
				cwd: repoDir,
				timeout: GIT_TIMEOUT,
			});
		} catch (err) {
			// Best-effort abort to leave the tree clean for the operator.
			try {
				await execFileAsync('git', ['merge', '--abort'], {
					cwd: repoDir,
					timeout: GIT_TIMEOUT,
				});
			} catch {
				// Ignore — may not have been mid-merge state.
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			return json(
				{
					success: false,
					error: `Merge failed: ${errMsg}. Resolve conflicts manually then use Mark shipped (status only).`,
					mergeConflict: true,
				},
				{ status: 409 },
			);
		}
	}

	// ── 6. Flip status to shipped (ONLY after successful merge) ──────────────
	const result = await engine.updateNote(path, {
		meta: { status: 'shipped', shipped_on: todayIso() },
	});
	if (!result.success) {
		// Merge succeeded but status update failed — surface a clear message so
		// the operator can manually update the ADR rather than re-attempting the merge.
		return json(
			{
				success: false,
				error: `Branch merged successfully but status flip failed: ${(result as { error?: string }).error ?? 'unknown error'}. The branch is on main — update the ADR status manually or run Mark shipped (status only).`,
			},
			{ status: 500 },
		);
	}

	// ── 7. Best-effort worktree reclamation (ADR-038 Layer A) ────────────────
	// Runs on both the just-merged path AND the alreadyMerged idempotent path
	// (a re-ship of an already-merged branch should still reclaim a lingering
	// worktree). Wrapped in try/catch — a cleanup hiccup MUST NOT roll back a
	// successful merge or status flip. The scheduled janitor (Layer B) is the
	// backstop for anything this misses.
	//
	// Worktree path formula mirrors worktree-provision.ts + worktree.ts:
	//   join(repoDir, '.worktrees', `run-${run.startedAt}-${safeId(path)}`)
	// which is `${runId}-${taskId}` = `run-<startedAt>-<safeId>` with
	// runId = `run-${run.startedAt}` and taskId = safeId(path).
	const worktreePath = join(repoDir, '.worktrees', `run-${run.startedAt}-${safeId(path)}`);
	try {
		await removeWorktree(worktreePath, /* force */ true);
		await deleteBranch(repoDir, branch);
		console.log(`[ship-merge] reclaimed worktree ${worktreePath} + branch ${branch}`);
	} catch (err) {
		// Non-fatal: log and let the janitor handle it on its next sweep.
		console.warn(
			`[ship-merge] worktree reclamation failed (non-fatal, janitor will sweep): ${(err as Error).message}`,
		);
	}

	return json({
		success: true,
		merged: !alreadyMerged,
		branch,
		path,
		newStatus: 'shipped',
	});
};
