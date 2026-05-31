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
 *      ADR-043 P2 — when `phaseToShip` is set, performs a PARTIAL ship instead:
 *      appends `phaseToShip` to `shipped_phases:`, splices a body entry under
 *      `## Shipped phases`, and keeps `status: accepted` (unless this is the
 *      last unshipped phase, in which case it flips to `shipped` as normal).
 *
 * Explicitly does NOT build, reload pm2, or push. Deploy remains a deliberate,
 * separate human step.
 *
 * Body:   { path: string, phaseToShip?: string }
 *           — vault-relative path of the ADR/decision note.
 *           — phaseToShip: phase ID to partially ship (ADR-043 P2); when absent,
 *             the full-ship-merge path runs (flips status → shipped).
 * Returns { success: true, merged: boolean, branch: string, newStatus: 'shipped' }
 *         { success: true, merged: boolean, branch: string, phaseShipped: string, advanced?: string }
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
import { branchForRun } from '$lib/agents/dispatch/run-branch.js';
import { unshippedPhases } from '$lib/vault/phases.js';

const execFileAsync = promisify(execFile);
/** Generous but bounded — a local merge + vault write should finish in < 10 s. */
const GIT_TIMEOUT = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayIso(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * ADR-043 P2 — splice a new entry as the FIRST item under the
 * `## Shipped phases` section.  If the section is absent, creates it after
 * `## Status` (or appends to the end as a fallback).
 *
 * The `entry` string should be a single markdown line (no leading/trailing
 * blank lines); the helper wraps it with the appropriate surrounding newlines.
 */
function spliceShippedPhaseEntry(body: string, entry: string): string {
	const SECTION_RE = /^##\s+Shipped phases[ \t]*$/m;
	const match = SECTION_RE.exec(body);

	if (match) {
		// Found the section — insert after the header line as the first item.
		// We always emit two newlines after the header so the entry is a
		// proper paragraph, then preserve whatever came after.
		const afterHeader = body.slice(match.index + match[0].length);
		// Strip any leading blank lines that were already there (avoid triple-blank).
		const trimmedAfter = afterHeader.replace(/^(\s*\n)+/, '');
		return (
			body.slice(0, match.index + match[0].length) +
			'\n\n' + entry + '\n' +
			(trimmedAfter ? '\n' + trimmedAfter : '')
		);
	}

	// Section absent — create it after ## Status, or append to end.
	const statusMatch = /^##\s+Status[ \t]*$/m.exec(body);
	if (statusMatch) {
		const insertAt = statusMatch.index + statusMatch[0].length;
		return (
			body.slice(0, insertAt) +
			'\n\n## Shipped phases\n\n' + entry + '\n' +
			body.slice(insertAt)
		);
	}

	return body.trimEnd() + '\n\n## Shipped phases\n\n' + entry + '\n';
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

	const { path, forceFinal, phaseToShip } = body as Record<string, unknown>;

	if (typeof path !== 'string' || !path) {
		return json({ success: false, error: 'path is required' }, { status: 400 });
	}
	// Path safety — same guards as /api/vault/decisions/transition
	if (path.includes('..') || path.startsWith('/') || !path.endsWith('.md')) {
		return json({ success: false, error: 'Invalid path' }, { status: 400 });
	}

	// ADR-043 P2 — validate phaseToShip when present.
	const phaseToShipStr = typeof phaseToShip === 'string' && phaseToShip.trim()
		? phaseToShip.trim()
		: null;

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

	// ── Phased-ADR guard (#62 — 2026-05-30; updated ADR-043 P2) ──────────────
	// ADR-043 P2 change: the guard now only fires when ALL of these are true:
	//   (a) no `phaseToShip` is set (caller is not doing a per-phase ship),
	//   (b) MORE than 1 phase is unshipped (exactly 1 = last phase → ship ok),
	//   (c) `forceFinal` is not true.
	// This lets `unshipped.length === 1` pass through to the full-ship path
	// (the "Ship final <Pn> & merge" button case).  When `phaseToShip` IS
	// provided, we skip this guard and validate in the per-phase block below.
	{
		const report = unshippedPhases(note.meta);
		if (!phaseToShipStr && report.unshippedPhases.length > 1 && forceFinal !== true) {
			return json(
				{
					success: false,
					error: 'unshipped-phases',
					phases: report.phases,
					shippedPhases: report.shippedPhases,
					unshippedPhases: report.unshippedPhases,
					hint: `ADR has unshipped phases: ${report.unshippedPhases
						.map((p) => `\`${p}\``)
						.join(', ')} — use "Ship <phase> & merge" to dispatch the next phase, "Mark <phase> shipped (no merge)" for a no-merge partial-ship, or re-call ship-merge with \`forceFinal: true\` to skip remaining.`,
				},
				{ status: 409 },
			);
		}
		// ADR-043 P2 — validate phaseToShip against the phases array.
		if (phaseToShipStr) {
			if (report.phases.length === 0) {
				return json(
					{ success: false, error: 'phaseToShip requires the ADR to declare phases:' },
					{ status: 400 },
				);
			}
			if (!report.phases.includes(phaseToShipStr)) {
				return json(
					{
						success: false,
						error: `phaseToShip "${phaseToShipStr}" not declared in phases: [${report.phases.join(', ')}]`,
					},
					{ status: 400 },
				);
			}
			if (report.shippedPhases.includes(phaseToShipStr)) {
				return json(
					{
						success: false,
						error: `phaseToShip "${phaseToShipStr}" is already in shipped_phases — use idempotent re-ship only if the merge was lost`,
					},
					{ status: 409 },
				);
			}
		}
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
	// ADR-022 branch-convention single-source-of-truth via branchForRun:
	//   tier 1 = handback.branch (authoritative), tier 2 = claude-soul/<adrKey>,
	//   tier 3 = legacy orchestration/run-X/Y for pre-ADR-022 rows.
	// ReviewableRun doesn't carry subjectPath; the request body `path` is it.
	const branch = branchForRun({ ...run, subjectPath: path });

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

	// ADR-043 P2 — capture first commit on branch BEFORE merge (for body entry).
	// Only needed when phaseToShip is set.  If already merged, we'll fall back
	// to the merge commit SHA below.
	let firstCommitSha = '';
	if (phaseToShipStr && !alreadyMerged) {
		try {
			const { stdout } = await execFileAsync(
				'git',
				['log', '--format=%H', '--reverse', `main..${branch}`],
				{ cwd: repoDir, timeout: GIT_TIMEOUT },
			);
			const shas = stdout.trim().split('\n').filter(Boolean);
			firstCommitSha = shas[0]?.slice(0, 8) ?? '';
		} catch {
			// Non-fatal — body entry will omit the first-commit reference.
		}
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

	// ── 6. Update note — full-ship OR per-phase partial-ship (ADR-043 P2) ─────

	// Capture merge commit SHA for the body entry (HEAD after merge).
	let mergeCommitSha = '';
	if (phaseToShipStr) {
		try {
			const { stdout } = await execFileAsync(
				'git',
				['rev-parse', '--short', 'HEAD'],
				{ cwd: repoDir, timeout: GIT_TIMEOUT },
			);
			mergeCommitSha = stdout.trim();
		} catch {
			// Non-fatal — body entry will omit the merge-commit reference.
		}
	}

	if (phaseToShipStr) {
		// ── ADR-043 P2: Per-phase partial ship ─────────────────────────────────
		// Re-fetch the note to get fresh content + shipped_phases (in case the
		// note was updated between the initial fetch and here).
		const freshNote = engine.getNote(path);
		if (!freshNote) {
			return json(
				{
					success: false,
					error: `Branch merged but note disappeared: ${path}. Update shipped_phases manually.`,
				},
				{ status: 500 },
			);
		}

		const currentShipped = Array.isArray(freshNote.meta.shipped_phases)
			? (freshNote.meta.shipped_phases as unknown[]).filter((p): p is string => typeof p === 'string')
			: [];
		const allPhases = Array.isArray(freshNote.meta.phases)
			? (freshNote.meta.phases as unknown[]).filter((p): p is string => typeof p === 'string')
			: [];
		const newShipped = [...currentShipped, phaseToShipStr];
		const isLastPhase = newShipped.length === allPhases.length;
		const today = todayIso();

		// Build the body entry.
		const firstRef = firstCommitSha ? `commit \`${firstCommitSha}\`` : 'branch';
		const mergeRef = mergeCommitSha ? ` merged via ${mergeCommitSha}` : '';
		const runRef = run.runId ? `, run \`${run.runId}\`` : '';
		const summaryTrunc = (typeof parsed.summary === 'string' && parsed.summary)
			? (' — ' + parsed.summary.slice(0, 200) + (parsed.summary.length > 200 ? '…' : ''))
			: '';
		const bodyEntry = `**${phaseToShipStr} shipped ${today}** (${firstRef}${mergeRef}${runRef})${summaryTrunc}`;

		const newContent = spliceShippedPhaseEntry(freshNote.content, bodyEntry);

		const metaPatch: Record<string, unknown> = {
			shipped_phases: newShipped,
		};
		if (isLastPhase) {
			metaPatch.status = 'shipped';
			metaPatch.shipped_on = today;
		}

		const phaseUpdateResult = await engine.updateNote(path, {
			meta: metaPatch,
			content: newContent,
		}, { actor: 'ship-merge', actorContext: `phase=${phaseToShipStr} adr=${path}` });

		if (!phaseUpdateResult.success) {
			return json(
				{
					success: false,
					error: `Branch merged but phase update failed: ${(phaseUpdateResult as { error?: string }).error ?? 'unknown error'}. Manually add "${phaseToShipStr}" to shipped_phases.`,
				},
				{ status: 500 },
			);
		}

		// Determine next active phase for the response.
		const remainingAfter = allPhases.filter((p) => !newShipped.includes(p));
		const nextPhase = remainingAfter[0] ?? null;

		// ── 7. Worktree reclamation (for phase ships too — same path) ──────────
		const worktreePath = join(repoDir, '.worktrees', `run-${run.startedAt}-${safeId(path)}`);
		try {
			await removeWorktree(worktreePath, true);
			await deleteBranch(repoDir, branch);
			console.log(`[ship-merge] reclaimed worktree ${worktreePath} + branch ${branch} (phase ship ${phaseToShipStr})`);
		} catch (err) {
			console.warn(
				`[ship-merge] worktree reclamation failed (non-fatal): ${(err as Error).message}`,
			);
		}

		return json({
			success: true,
			merged: !alreadyMerged,
			branch,
			path,
			phaseShipped: phaseToShipStr,
			...(nextPhase ? { advanced: nextPhase } : {}),
			...(isLastPhase ? { newStatus: 'shipped' } : {}),
		});
	}

	// ── Full-ship path (no phaseToShip or phaseToShip resolved to full-ship) ──
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
