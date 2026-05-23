/**
 * ADR-009 §3 + Phase 5 — model A/B with sticky-per-conversationKey
 * branch assignment. ADR-034 (2026-05-14) extended from three branches to
 * five and promoted DeepSeek V4 Pro to primary (Path A) after a smoke
 * battery showed 7/7 tool selection + per-prompt-correct dispatch
 * confirmation, while GLM-4.6 silently failed `scheduleReminder` (replied
 * "OK I'll remind you" without ever calling the tool).
 *
 * The five branches, in BRANCHES order (least-loaded picker reads
 * position 0 first when load is tied — operationally the "default"):
 *   - `deepseek-v4-pro`    → `deepseek/deepseek-v4-pro` (PRIMARY since
 *                            2026-05-14; MoE 1.6T/49B active, 1M ctx,
 *                            $0.435/$0.87 per M tok)
 *   - `deepseek-v4-flash`  → `deepseek/deepseek-v4-flash` (cost fallback;
 *                            MoE 284B/13B active, 1M ctx, $0.126/$0.252)
 *   - `sonnet-4.6`         → `anthropic/claude-sonnet-4.6` (quality
 *                            benchmark, Tau-bench 0.862, $3/$15)
 *   - `minimax-m2`         → `minimax/minimax-m2` (AA Intelligence Index #1
 *                            agentic; $0.30/$1.20 estimated)
 *   - `glm-4.6`            → `z-ai/glm-4.6` (DEMOTED 2026-05-14 — silent-
 *                            fail on scheduleReminder; kept as a cheap
 *                            fallback while telemetry observes whether the
 *                            silent-fail recurs; $0.39/$1.90)
 *
 * Sticky assignment via the `model_branch_assignment` table — once a
 * conversationKey lands on a branch, it stays there. New keys go to the
 * least-loaded branch (proper round-robin only when load is roughly equal,
 * but this self-corrects if a branch fails fast and gets retired).
 *
 * Override for debug / staged rollout: `ORCHESTRATOR_V2_BRANCH_OVERRIDE=glm-4.6`
 * forces every key to that branch, bypassing both the existing assignment
 * and the round-robin. Useful for "test only this branch for the next 24h"
 * and the ADR-034 smoke battery.
 */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';
import { isBranchOverBudget } from './branch-costs.js';

export interface ModelBranch {
	/** Short label that lands in `proposal_history.model_branch` and
	 *  telemetry. Stable across model version bumps. */
	name: string;
	/** OpenRouter model id passed to `openrouter(modelId)`. */
	model: string;
}

export const BRANCHES: readonly ModelBranch[] = [
	{ name: 'deepseek-v4-pro', model: 'deepseek/deepseek-v4-pro' },
	{ name: 'deepseek-v4-flash', model: 'deepseek/deepseek-v4-flash' },
	{ name: 'sonnet-4.6', model: 'anthropic/claude-sonnet-4.6' },
	{ name: 'minimax-m2', model: 'minimax/minimax-m2' },
	{ name: 'glm-4.6', model: 'z-ai/glm-4.6' },
] as const;

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS model_branch_assignment (
			conversation_key TEXT PRIMARY KEY,
			model_branch TEXT NOT NULL,
			assigned_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_model_branch_assignment_branch
			ON model_branch_assignment(model_branch);
	`);
}

function db(): Database {
	const handle = getInboxDb();
	if (!schemaReady) {
		ensureSchema(handle);
		schemaReady = true;
	}
	return handle;
}

/** Sticky branch assignment for a conversation. Reads the assignment table;
 *  on first sighting picks the least-loaded branch and persists. Falls back
 *  to BRANCHES[0] when the env override is set to an unknown name (warns
 *  rather than crashing — the A/B should never block chat). */
export function pickBranchForKey(conversationKey: string): ModelBranch {
	const override = process.env.ORCHESTRATOR_V2_BRANCH_OVERRIDE;
	if (override) {
		const forced = BRANCHES.find((b) => b.name === override);
		if (forced) return forced;
		console.warn(
			`[orchestrator-v2/branches] ORCHESTRATOR_V2_BRANCH_OVERRIDE="${override}" not in BRANCHES — falling back to assignment`,
		);
	}

	const handle = db();
	const existing = handle
		.prepare(
			`SELECT model_branch FROM model_branch_assignment WHERE conversation_key = ?`,
		)
		.get(conversationKey) as { model_branch: string } | undefined;
	if (existing) {
		const found = BRANCHES.find((b) => b.name === existing.model_branch);
		if (found) return found;
		// Stored branch is unknown (rare — schema drift after a branch rename).
		// Drop the row and re-assign so the user lands on a current branch.
		handle
			.prepare(`DELETE FROM model_branch_assignment WHERE conversation_key = ?`)
			.run(conversationKey);
	}

	const next = pickLeastLoaded(handle);
	handle
		.prepare(
			`INSERT OR REPLACE INTO model_branch_assignment
				(conversation_key, model_branch, assigned_at)
				VALUES (?, ?, ?)`,
		)
		.run(conversationKey, next.name, Date.now());
	return next;
}

function pickLeastLoaded(handle: Database): ModelBranch {
	const rows = handle
		.prepare(
			`SELECT model_branch, COUNT(*) AS n
				FROM model_branch_assignment
				GROUP BY model_branch`,
		)
		.all() as Array<{ model_branch: string; n: number }>;
	const counts = new Map<string, number>(rows.map((r) => [r.model_branch, r.n]));

	// ADR-009 Phase 6 — exclude branches that have crossed the cost cap in
	// the trailing 14-day window. If ALL branches are over budget (the A/B
	// has degenerated into "everything is too expensive"), fall back to the
	// least-loaded one anyway — chat must keep working; the user sees the
	// budget alert and decides what to do.
	const eligible = BRANCHES.filter((b) => !isBranchOverBudget(b.name));
	const candidates = eligible.length > 0 ? eligible : BRANCHES;

	let pick = candidates[0];
	let pickCount = counts.get(pick.name) ?? 0;
	for (const b of candidates.slice(1)) {
		const c = counts.get(b.name) ?? 0;
		if (c < pickCount) {
			pick = b;
			pickCount = c;
		}
	}
	return pick;
}

/** Snapshot of current sticky assignments — used by Phase 7 analytics
 *  and the `/api/analytics/branches` endpoint that arrives later. */
export function getBranchAssignmentCounts(): Record<string, number> {
	const handle = db();
	const rows = handle
		.prepare(
			`SELECT model_branch, COUNT(*) AS n
				FROM model_branch_assignment
				GROUP BY model_branch
				ORDER BY model_branch`,
		)
		.all() as Array<{ model_branch: string; n: number }>;
	const out: Record<string, number> = {};
	for (const b of BRANCHES) out[b.name] = 0;
	for (const r of rows) out[r.model_branch] = r.n;
	return out;
}

/** Test-only / debug-only — wipes the assignment table. Used by smoke tests. */
export function clearAllBranchAssignments(): void {
	db().exec(`DELETE FROM model_branch_assignment`);
}
