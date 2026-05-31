/**
 * POST /api/agents/merge-partial — ADR-042 D4
 *
 * Partial merge: lands the current worktree branch onto main for a single
 * declared phase of a phased ADR, then updates `shipped_phases` in the ADR's
 * frontmatter.  Leaves `status: accepted` so subsequent phases can continue
 * on the same worktree branch.  Auto-promotes to `shipped` when the merged
 * phase is the last one.
 *
 * Git operations mirror `POST /api/agents/ship-merge` (ADR-027 P1):
 *   1. HEAD must be `main`, working tree clean, branch must exist.
 *   2. Idempotency: branch already fully merged → skip git, still update frontmatter.
 *   3. Merge with `--no-ff` + ADR-slug message (ADR-009 drift detector compatible).
 *   4. Update `shipped_phases: [...existing, phase]`.
 *   5. If all phases shipped → promote `status: accepted → shipped` + cleanup worktree.
 *
 * Unlike `ship-merge`, this endpoint does NOT require a run record with green
 * gates.  Gate verification is an operator responsibility when invoking from
 * the CLI; the worktree is kept open for subsequent phases.
 *
 * Body:   { path: string, phase: string }
 * Returns { success: true, phase, lastPhase: boolean, merged: boolean, branch: string }
 *       | { success: false, error: string, mergeConflict?: boolean }
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { nonBenignDirtyPaths } from '$lib/agents/benign-drift.js';
import { safeId, expandHome } from '$lib/agents/dispatch/worktree-provision.js';
import { removeWorktree, deleteBranch } from '$lib/orchestration/worktree.js';
import { getVaultEngine } from '$lib/vault/index.js';
import { getAdrRunHistory } from '$lib/agents/runs.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;

function todayIso(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Best-effort worktree + branch cleanup on final-phase ship.
 *  Mirrors the cleanup path in `ship-merge` and the transition endpoint. */
async function cleanupAdrWorktree(repoPath: string, subjectPath: string): Promise<void> {
	const adrKey = safeId(subjectPath);
	const branch = `claude-soul/${adrKey}`;
	const worktreePath = join(repoPath, '.worktrees', adrKey);
	try {
		if (existsSync(worktreePath)) {
			await removeWorktree(worktreePath, true);
			console.log(`[merge-partial] removed worktree ${worktreePath} (last-phase cleanup)`);
		}
		await deleteBranch(repoPath, branch).catch(() => { /* branch may not exist */ });
	} catch (err) {
		console.warn(
			`[merge-partial] worktree cleanup failed (non-fatal): ${(err as Error).message}`,
		);
	}
}

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

	const { path, phase } = body as Record<string, unknown>;

	if (typeof path !== 'string' || !path) {
		return json({ success: false, error: 'path is required' }, { status: 400 });
	}
	if (path.includes('..') || path.startsWith('/') || !path.endsWith('.md')) {
		return json({ success: false, error: 'Invalid path' }, { status: 400 });
	}
	if (typeof phase !== 'string' || !phase.trim()) {
		return json({ success: false, error: 'phase is required (e.g. "D1", "D2")' }, { status: 400 });
	}
	const phaseId = phase.trim();

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
				error: `merge-partial requires status 'accepted' (current: ${currentStatus || 'none'})`,
			},
			{ status: 409 },
		);
	}

	// ── Validate phases: field ────────────────────────────────────────────────
	const phasesRaw: unknown = note.meta.phases;
	if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) {
		return json(
			{
				success: false,
				error: `This ADR has no declared phases. Use 'soul adr ship' to ship a single-phase ADR.`,
			},
			{ status: 422 },
		);
	}
	const phases = phasesRaw as string[];
	if (!phases.includes(phaseId)) {
		return json(
			{
				success: false,
				error: `Phase '${phaseId}' not declared in phases: [${phases.join(', ')}]`,
			},
			{ status: 422 },
		);
	}

	// ── Idempotency: phase already shipped ────────────────────────────────────
	const shippedRaw: unknown = note.meta.shipped_phases;
	const existingShipped: string[] = Array.isArray(shippedRaw)
		? (shippedRaw as string[])
		: [];

	if (existingShipped.includes(phaseId)) {
		return json({
			success: true,
			phase: phaseId,
			lastPhase: existingShipped.length === phases.length,
			merged: false,
			branch: `claude-soul/${safeId(path)}`,
			alreadyShipped: true,
			message: `Phase '${phaseId}' is already in shipped_phases — no changes made.`,
		});
	}

	// ── Resolve branch (ADR-022 convention) ──────────────────────────────────
	// Prefer the run record's repo for cross-repo ADRs (ADR-031 P1 pattern);
	// fall back to env-var then cwd (soul-hub default).
	const history = getAdrRunHistory(path);
	const lastRun = history.runs.length > 0 ? history.runs[history.runs.length - 1] : null;
	const repoDir = expandHome(
		lastRun?.repo ?? process.env.SOUL_HUB_REPO ?? process.cwd(),
	);
	const adrKey = safeId(path);
	const branch = `claude-soul/${adrKey}`;

	// ── Git pre-flight ────────────────────────────────────────────────────────

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
				error: `Repository HEAD is on '${currentBranch}', not 'main'. Switch to main first.`,
			},
			{ status: 409 },
		);
	}

	// Working tree must be clean (benign auto-gen drift is tolerated).
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
					error: `Branch '${branch}' not found. The worktree may have been removed.`,
				},
				{ status: 409 },
			);
		}
	} catch {
		return json({ success: false, error: 'git branch check failed' }, { status: 503 });
	}

	// ── Idempotency: already merged? ──────────────────────────────────────────
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

	// ── Merge ─────────────────────────────────────────────────────────────────
	if (!alreadyMerged) {
		const slug = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
		const mergeMessage = `merge: ${slug} — phase ${phaseId} — ${note.title}`;
		try {
			await execFileAsync('git', ['merge', '--no-ff', '-m', mergeMessage, branch], {
				cwd: repoDir,
				timeout: GIT_TIMEOUT,
			});
		} catch (err) {
			try {
				await execFileAsync('git', ['merge', '--abort'], { cwd: repoDir, timeout: GIT_TIMEOUT });
			} catch {
				// Ignore — may not have been mid-merge state.
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			return json(
				{
					success: false,
					error: `Merge failed: ${errMsg}. Resolve conflicts manually.`,
					mergeConflict: true,
				},
				{ status: 409 },
			);
		}
	}

	// ── Update shipped_phases ─────────────────────────────────────────────────
	const newShipped = [...existingShipped, phaseId];
	const isLastPhase = newShipped.length === phases.length;

	const metaPatch: Record<string, unknown> = { shipped_phases: newShipped };
	if (isLastPhase) {
		// All phases done → promote to shipped (mirrors ship-merge / transition ship).
		metaPatch.status = 'shipped';
		metaPatch.shipped_on = todayIso();
	}

	const result = await engine.updateNote(path, { meta: metaPatch });
	if (!result.success) {
		// Merge succeeded but meta update failed — surface clearly.
		return json(
			{
				success: false,
				error: `Branch merged successfully but frontmatter update failed: ${(result as { error?: string }).error ?? 'unknown error'}. Update shipped_phases manually.`,
			},
			{ status: 500 },
		);
	}

	// ── Last-phase cleanup ────────────────────────────────────────────────────
	// When all phases are shipped we clean up the worktree + branch (same path
	// as ship-merge).  For partial merges we intentionally leave them open so
	// subsequent phases can continue on the same branch.
	if (isLastPhase) {
		await cleanupAdrWorktree(repoDir, path);
	}

	return json({
		success: true,
		phase: phaseId,
		lastPhase: isLastPhase,
		merged: !alreadyMerged,
		branch,
		path,
		newShippedPhases: newShipped,
		...(isLastPhase ? { newStatus: 'shipped' } : {}),
	});
};
