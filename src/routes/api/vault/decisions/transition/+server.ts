/** POST /api/vault/decisions/transition — flip a decision's status frontmatter.
 *
 *  Per ADR-037 Phase 2 + Phase 3a. Wraps `engine.updateNote` with a small policy:
 *    - accept  (proposed → accepted)  → status, accepted_on: <today>
 *    - reject  (proposed → rejected)  → status, rejected_on: <today>, reason required
 *    - park    (proposed → parked)    → status, parked_on: <today>, review_after optional
 *    - ship    (accepted → shipped)   → status, shipped_on: <today>            [Phase 3a]
 *
 *  ADR-043 P2 — per-phase partial ship:
 *    - ship + phaseToShip set → appends phaseToShip to shipped_phases:, splices a
 *      body entry under ## Shipped phases, keeps status: accepted (unless it's the
 *      last phase, in which case flips to shipped).  Used by:
 *      • "Mark {Pn} shipped (no merge)" for AI phases without a branch merge.
 *      • "Mark {Pn} shipped (manual)" for human-owned phases (Decision §3).
 *
 *  Body: { path: string, action: 'accept' | 'reject' | 'park' | 'ship',
 *          reason?: string, reviewAfter?: string (YYYY-MM-DD),
 *          phaseToShip?: string }
 *
 *  Returns: { success: true, path, newStatus } or { success: false, error }.
 *  Engine.updateNote re-validates frontmatter, writes via temp-file rename,
 *  re-indexes, and enqueues a vault git commit (per ADR-019). */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getVaultEngine } from '$lib/vault/index.js';
import { getAgent, listAgents } from '$lib/agents/store.js';
import { getAdrRunHistory } from '$lib/agents/runs.js';
import { safeId, expandHome } from '$lib/agents/dispatch/worktree-provision.js';
import { removeWorktree, deleteBranch } from '$lib/orchestration/worktree.js';
import { resolveAgentForWork, clusterFromTags } from '$lib/projects/dispatch-routing.js';
import { resolveProjectRepo } from '$lib/agents/dispatch/resolve-project-repo.js';
import { unshippedPhases } from '$lib/vault/phases.js';

/** Build the routing inputs (roster + repoMap) from the live agent store.
 *  Pure read; no side-effects.  Used by the accept-action assignee
 *  resolver below. */
function buildRosterAndRepoMap(): {
	roster: Set<string>;
	repoMap: Map<string, string | undefined>;
} {
	const { agents } = listAgents();
	const roster = new Set<string>();
	const repoMap = new Map<string, string | undefined>();
	for (const a of agents) {
		roster.add(a.id.toLowerCase());
		repoMap.set(a.id.toLowerCase(), a.repo);
	}
	return { roster, repoMap };
}

/** ADR-022 D4 — clean up the per-ADR worktree + branch at terminal lifecycle
 *  transitions (ship or reject).  Best-effort: failures are logged but do
 *  NOT fail the transition (frontmatter is already updated successfully).
 *  Legacy per-run worktrees (`.worktrees/run-<startedAt>-<slug>`) are cleaned
 *  by the boot-time orphan sweep, not here. */
async function cleanupAdrWorktree(subjectPath: string): Promise<void> {
	try {
		// Resolve the repo from the most recent dispatch against this ADR.
		// Falls back to SOUL_HUB_REPO (or the cwd) for cluster projects that
		// inherit soul-hub via parent_project before ADR-031 P1 backfilled `repo`.
		const history = getAdrRunHistory(subjectPath);
		const lastRun = history.runs.length > 0 ? history.runs[history.runs.length - 1] : null;
		const repo = lastRun?.repo
			?? process.env.SOUL_HUB_REPO
			?? process.cwd();
		const repoPath = expandHome(repo);

		// ADR-022 convention: worktree at `<repo>/.worktrees/<adrKey>` on
		// branch `claude-soul/<adrKey>`.
		const adrKey = safeId(subjectPath);
		const worktreePath = join(repoPath, '.worktrees', adrKey);
		const branch = `claude-soul/${adrKey}`;

		if (existsSync(worktreePath)) {
			await removeWorktree(worktreePath, true);
			console.log(`[adr-lifecycle] removed worktree ${worktreePath} (transition cleanup)`);
		}
		// deleteBranch is a no-op when the branch doesn't exist, so we don't
		// need to pre-check.
		await deleteBranch(repoPath, branch).catch(() => { /* branch may not exist */ });
	} catch (err) {
		console.warn(
			`[adr-lifecycle] worktree cleanup failed for ${subjectPath}: ${(err as Error).message}`,
		);
	}
}

/**
 * ADR-043 P2 — splice a new entry as the FIRST item under `## Shipped phases`.
 * Mirror of the same helper in ship-merge/+server.ts; kept in sync deliberately.
 */
function spliceShippedPhaseEntry(body: string, entry: string): string {
	const SECTION_RE = /^##\s+Shipped phases[ \t]*$/m;
	const match = SECTION_RE.exec(body);

	if (match) {
		const afterHeader = body.slice(match.index + match[0].length);
		const trimmedAfter = afterHeader.replace(/^(\s*\n)+/, '');
		return (
			body.slice(0, match.index + match[0].length) +
			'\n\n' + entry + '\n' +
			(trimmedAfter ? '\n' + trimmedAfter : '')
		);
	}

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

type Action = 'accept' | 'reject' | 'park' | 'ship';

const ACTION_TO_STATUS: Record<Action, string> = {
	accept: 'accepted',
	reject: 'rejected',
	park: 'parked',
	ship: 'shipped',
};

/** projects-graph ADR-017 P3 — the canonical-6 lifecycle (and this endpoint's
 *  source-status guards) apply to any typed artifact, not just decisions.
 *  Tasks/risks/metrics/posts share the vocab (operator decision 2026-05-21),
 *  so they transition through the same endpoint. Types NOT in this set are
 *  refused — the lifecycle isn't meaningful for `index`/`reference`/etc. */
// projects-graph ADR-021 — design + requirements added in lock-step with the
// worklist's ACTIONABLE_TYPES, so any artifact that can surface in a lane can
// also have its status edited from the drawer.
const TRANSITIONABLE_TYPES = new Set([
	'decision',
	'task',
	'risk',
	'metric',
	'post',
	'design',
	'requirements',
]);

/** Per-action source status guard. accept/reject/park require `proposed`;
 *  ship requires `accepted`. */
const ACTION_FROM_STATUS: Record<Action, string> = {
	accept: 'proposed',
	reject: 'proposed',
	park: 'proposed',
	ship: 'accepted',
};

function todayIso(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

export const POST: RequestHandler = async ({ request }) => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ success: false, error: 'Vault not initialized' }, { status: 503 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const { path, action, reason, reviewAfter, assignee, phaseToShip } = body as Record<string, unknown>;

	// ADR-043 P2 — validate phaseToShip early so we can return a typed error.
	const phaseToShipStr = typeof phaseToShip === 'string' && phaseToShip.trim()
		? phaseToShip.trim()
		: null;

	if (typeof path !== 'string' || !path) {
		return json({ success: false, error: 'path is required' }, { status: 400 });
	}
	// Path safety — only vault notes, no traversal
	if (path.includes('..') || path.startsWith('/') || !path.endsWith('.md')) {
		return json({ success: false, error: 'Invalid path' }, { status: 400 });
	}

	if (typeof action !== 'string' || !(action in ACTION_TO_STATUS)) {
		return json(
			{ success: false, error: `action must be one of: ${Object.keys(ACTION_TO_STATUS).join(', ')}` },
			{ status: 400 },
		);
	}

	const existing = engine.getNote(path);
	if (!existing) {
		return json({ success: false, error: `Note not found: ${path}` }, { status: 404 });
	}
	if (!TRANSITIONABLE_TYPES.has(String(existing.meta.type ?? ''))) {
		return json(
			{
				success: false,
				error: `Type '${existing.meta.type}' has no lifecycle (allowed: ${[...TRANSITIONABLE_TYPES].join(', ')})`,
			},
			{ status: 400 },
		);
	}
	const currentStatus = String(existing.meta.status ?? '').toLowerCase();
	const requiredFrom = ACTION_FROM_STATUS[action as Action];
	if (currentStatus !== requiredFrom) {
		return json(
			{
				success: false,
				error: `${action} requires status '${requiredFrom}' (current: ${currentStatus || 'none'})`,
			},
			{ status: 409 },
		);
	}

	const newStatus = ACTION_TO_STATUS[action as Action];
	const today = todayIso();

	const metaPatch: Record<string, unknown> = { status: newStatus };
	if (action === 'accept') {
		metaPatch.accepted_on = today;
		// "Accept & hand to AI" (soul-hub-governance — the dispose→execute handoff):
		// optionally set ownership to an AI agent so the worklist moves the item
		// from ready_for_you → ready_for_ai. Validated against the live roster so a
		// typo'd assignee can't silently classify as human/unassigned.
		if (typeof assignee === 'string' && assignee.trim()) {
			const agentId = assignee.trim().toLowerCase();
			if (!getAgent(agentId)) {
				return json({ success: false, error: `unknown agent: ${agentId}` }, { status: 400 });
			}
			metaPatch.assignee = agentId;
		} else if (!existing.meta.assignee) {
			// CLI improvement — routing-aware assignee default for accept.
			// When the operator doesn't pass `--assignee` AND the note has no
			// existing assignee, resolve the most-likely target via the same
			// routing matrix the workbench uses (`resolveAgentForWork`).
			// Persists exactly what the AdrDrawer would show as the dispatch
			// target, eliminating the recurring "I accepted but no dispatch
			// button" friction caused by missing assignee + missing repo:.
			// Operator override (`--assignee foo`) is unchanged.
			const workType = typeof existing.meta.work_type === 'string'
				? existing.meta.work_type
				: null;
			const tags = Array.isArray(existing.meta.tags)
				? (existing.meta.tags as unknown[]).filter((t): t is string => typeof t === 'string')
				: [];
			const cluster = clusterFromTags(tags);
			const { roster, repoMap } = buildRosterAndRepoMap();
			const projectRepo = resolveProjectRepo(path, (p) => engine.getNote(p));
			const subjectHasProjectRepo = typeof projectRepo === 'string' && projectRepo.length > 0;
			const resolved = resolveAgentForWork(
				workType,
				null, // no explicit assignee — let the matrix pick
				roster,
				cluster,
				repoMap,
				subjectHasProjectRepo,
			);
			if (resolved) {
				metaPatch.assignee = resolved;
			}
			// If nothing routes (e.g. `decision`/`manual` work_type), leave
			// assignee unset — the workbench correctly classifies it as
			// human-owned.
		}
	} else if (action === 'ship') {
		if (phaseToShipStr) {
			// ADR-043 P2 — per-phase partial ship (no full status flip unless last phase).
			const report = unshippedPhases(existing.meta);
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
						error: `phaseToShip "${phaseToShipStr}" is already in shipped_phases — nothing to do`,
					},
					{ status: 409 },
				);
			}

			const newShipped = [...report.shippedPhases, phaseToShipStr];
			const isLastPhase = newShipped.length === report.phases.length;

			// Build and splice the body entry.
			const reasonStr = typeof reason === 'string' && reason.trim()
				? reason.trim()
				: 'owner-marked';
			const bodyEntry =
				`**${phaseToShipStr} shipped ${today}** (manual) — ${reasonStr}`;
			const newContent = spliceShippedPhaseEntry(existing.content, bodyEntry);

			metaPatch.shipped_phases = newShipped;
			if (isLastPhase) {
				metaPatch.status = 'shipped';
				metaPatch.shipped_on = today;
			} else {
				// Keep status: accepted; remove any accidentally-set status override.
				delete metaPatch.status;
			}

			const partialResult = await engine.updateNote(path, {
				meta: metaPatch,
				content: newContent,
			}, { actor: 'decisions-transition', actorContext: `phase=${phaseToShipStr} manual adr=${path}` });
			if (!partialResult.success) {
				return json({ success: false, error: (partialResult as { error?: string }).error }, { status: 500 });
			}

			const nextUnshipped = report.phases.find(
				(p) => !newShipped.includes(p),
			) ?? null;

			return json({
				success: true,
				path,
				phaseShipped: phaseToShipStr,
				newStatus: isLastPhase ? 'shipped' : 'accepted',
				...(nextUnshipped ? { advanced: nextUnshipped } : {}),
			});
		}
		// Full ship (no phaseToShip): existing behavior.
		metaPatch.shipped_on = today;
	} else if (action === 'reject') {
		if (typeof reason !== 'string' || !reason.trim()) {
			return json(
				{ success: false, error: 'reason is required for reject action' },
				{ status: 400 },
			);
		}
		metaPatch.rejected_on = today;
		metaPatch.rejection_reason = reason.trim();
	} else if (action === 'park') {
		metaPatch.parked_on = today;
		if (typeof reviewAfter === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reviewAfter)) {
			metaPatch.review_after = reviewAfter;
		}
		if (typeof reason === 'string' && reason.trim()) {
			metaPatch.park_reason = reason.trim();
		}
	}

	const result = await engine.updateNote(path, { meta: metaPatch });
	if (!result.success) {
		return json({ success: false, error: result.error }, { status: 500 });
	}

	// ADR-022 D4 — terminal-lifecycle worktree cleanup.  After a successful
	// `ship` or `reject` transition, remove the per-ADR worktree + delete the
	// branch (best-effort; failures don't fail the transition).
	// `accept`/`park` do not clean up — the worktree may still be needed for
	// further dispatches or operator follow-up.
	if (action === 'ship' || action === 'reject') {
		await cleanupAdrWorktree(path);
	}

	return json({ success: true, path, newStatus });
};
