/**
 * ADR-009 Phase 6 — per-branch cost tracking + budget enforcement.
 *
 * Each successful `decideV2` turn upserts into `orchestrator_v2_branch_costs`,
 * keyed by `(branch_name, ymd)`. The 14-day rolling cost per branch is
 * computed by summing rows whose `ymd` is within the window.
 *
 * Budget cap: ADR-009 falsifier says **>$15/month projected** kills a branch.
 * Phase 6 expresses this as $10 per branch over 14 days (~$21/month
 * projected — slightly over the falsifier; alerts trigger early so the user
 * has time to retire before crossing). Configurable via `BRANCH_COST_CAP_USD`.
 *
 * Pricing per branch is hardcoded (not pulled from OpenRouter at runtime —
 * the gateway pricing rarely changes within a 14-day window and the
 * runtime fetch cost outweighs the precision gain). Numbers from ADR §3,
 * verified at the start of the A/B; if a provider changes pricing during
 * the test, just edit `BRANCH_PRICING`.
 */

import type { Database } from 'better-sqlite3';
import { getInboxDb } from '../inbox/db.js';

/** Cost cap per branch over the 14-day window. Default $10. Override via env. */
export const BRANCH_COST_CAP_USD = Number(process.env.BRANCH_COST_CAP_USD ?? 10);
export const BRANCH_WINDOW_DAYS = Number(process.env.BRANCH_WINDOW_DAYS ?? 14);

/** USD per million tokens (input / output). Approximate — see file header. */
const BRANCH_PRICING: Record<string, { inUsdPerM: number; outUsdPerM: number }> = {
	'glm-4.6': { inUsdPerM: 0.39, outUsdPerM: 1.9 },
	// Sonnet without prompt caching markers; with caching active in Phase 6+
	// the effective input rate drops ~10×. Recompute manually if caching
	// is wired before the A/B winner is picked.
	'sonnet-4.6': { inUsdPerM: 3, outUsdPerM: 15 },
	// MiniMax M2 OpenRouter pricing — estimate; adjust after first day's
	// telemetry shows the actual rate.
	'minimax-m2': { inUsdPerM: 0.3, outUsdPerM: 1.2 },
	// ADR-034 — DeepSeek V4 variants. Pricing from OpenRouter model cards as
	// of 2026-05-14. Both support 1M context. Per the ADR's "Engines play 2"
	// the actual telemetry will calibrate these against `cost_usd` over the
	// trailing 7-day window; alert at >20% divergence.
	'deepseek-v4-flash': { inUsdPerM: 0.126, outUsdPerM: 0.252 },
	'deepseek-v4-pro': { inUsdPerM: 0.435, outUsdPerM: 0.87 },
};

let schemaReady = false;

function ensureSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS orchestrator_v2_branch_costs (
			branch_name TEXT NOT NULL,
			ymd TEXT NOT NULL,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			turns INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (branch_name, ymd)
		);
		CREATE INDEX IF NOT EXISTS idx_branch_costs_ymd
			ON orchestrator_v2_branch_costs(ymd);
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

/** Convert tokens → USD using the branch's hardcoded rate. Returns 0 when
 *  the branch isn't in the pricing map (e.g. legacy `fixed-override`). */
export function priceTurn(
	branchName: string,
	inputTokens: number,
	outputTokens: number,
): number {
	const p = BRANCH_PRICING[branchName];
	if (!p) return 0;
	return (inputTokens / 1_000_000) * p.inUsdPerM + (outputTokens / 1_000_000) * p.outUsdPerM;
}

/** Upsert one turn's cost into the daily aggregate. Idempotent across
 *  parallel calls within the same ms — SQLite UPSERT is atomic. */
export function recordTurnCost(input: {
	branchName: string;
	ymd: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}): void {
	if (!input.branchName) return;
	db()
		.prepare(
			`INSERT INTO orchestrator_v2_branch_costs
				(branch_name, ymd, input_tokens, output_tokens, cost_usd, turns)
				VALUES (?, ?, ?, ?, ?, 1)
				ON CONFLICT(branch_name, ymd) DO UPDATE SET
					input_tokens = input_tokens + excluded.input_tokens,
					output_tokens = output_tokens + excluded.output_tokens,
					cost_usd = cost_usd + excluded.cost_usd,
					turns = turns + 1`,
		)
		.run(
			input.branchName,
			input.ymd,
			input.inputTokens,
			input.outputTokens,
			input.costUsd,
		);
}

export interface BranchCostStats {
	branchName: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	overBudget: boolean;
}

/** Aggregate per-branch cost over the trailing `windowDays`. */
export function getBranchCostStats(windowDays: number = BRANCH_WINDOW_DAYS): BranchCostStats[] {
	const cutoff = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
	const cutoffYmd = cutoff.toISOString().slice(0, 10);
	const rows = db()
		.prepare(
			`SELECT branch_name AS branchName,
				SUM(turns) AS turns,
				SUM(input_tokens) AS inputTokens,
				SUM(output_tokens) AS outputTokens,
				SUM(cost_usd) AS costUsd
			FROM orchestrator_v2_branch_costs
			WHERE ymd >= ?
			GROUP BY branch_name
			ORDER BY costUsd DESC`,
		)
		.all(cutoffYmd) as Array<{
		branchName: string;
		turns: number | null;
		inputTokens: number | null;
		outputTokens: number | null;
		costUsd: number | null;
	}>;
	return rows.map((r) => ({
		branchName: r.branchName,
		turns: r.turns ?? 0,
		inputTokens: r.inputTokens ?? 0,
		outputTokens: r.outputTokens ?? 0,
		costUsd: r.costUsd ?? 0,
		overBudget: (r.costUsd ?? 0) >= BRANCH_COST_CAP_USD,
	}));
}

/** Quick-path check — does this branch's 14-day spend exceed the cap?
 *  Used by `pickBranchForKey` to exclude over-budget branches when
 *  assigning NEW keys (existing sticky assignments aren't migrated). */
export function isBranchOverBudget(
	branchName: string,
	cap: number = BRANCH_COST_CAP_USD,
	windowDays: number = BRANCH_WINDOW_DAYS,
): boolean {
	const cutoff = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
	const cutoffYmd = cutoff.toISOString().slice(0, 10);
	const row = db()
		.prepare(
			`SELECT SUM(cost_usd) AS costUsd
				FROM orchestrator_v2_branch_costs
				WHERE branch_name = ? AND ymd >= ?`,
		)
		.get(branchName, cutoffYmd) as { costUsd: number | null } | undefined;
	return (row?.costUsd ?? 0) >= cap;
}

/** Test-only / debug-only — wipes the cost table. */
export function clearAllBranchCosts(): void {
	db().exec(`DELETE FROM orchestrator_v2_branch_costs`);
}
