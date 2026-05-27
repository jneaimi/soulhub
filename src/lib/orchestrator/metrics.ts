/**
 * Orchestrator falsifier instrumentation — surfaces the data the
 * 4-week observation period (per WhatsApp ADR-005 §Falsifier) needs.
 *
 * Reads `agent_runs` filtered to orchestrator-driven dispatches (the
 * subset where `mode='production' AND jid IS NOT NULL` — UI/test
 * dispatches and scheduler-fired runs leave `jid` null). Returns a
 * single aggregated payload the dashboard renders verbatim.
 *
 * Known gaps documented in ADR-005:
 *   - Orchestrator's OWN Gemini Flash cost is NOT in `agent_runs`
 *     (only the dispatched agent's cost is). Phase 11 candidate.
 *   - Slash-command vs natural-language path ratio not counted —
 *     would need a separate path counter in `_inbound`.
 *   - Confidence distribution not logged — orchestrator throws away
 *     the value after the gate; would need a new column or table.
 */

import type Database from 'better-sqlite3';
import { getHeartbeatDb } from '../channels/whatsapp/heartbeat-state.js';
import type { DispatchResult } from '../agents/dispatch/types.js';

export interface OrchestratorMetrics {
	period: { fromMs: number; toMs: number; days: number };
	dispatches: {
		total: number;
		byStatus: Record<DispatchResult['status'], number>;
	};
	cancelRate: number; // 0..1
	successRate: number; // 0..1
	costUsd: number; // sum of dispatched-agent cost; orchestrator-own cost not included (see header)
	avgDurationMs: number;
	byBackend: Record<string, number>;
	byAgent: Array<{
		agentId: string;
		runs: number;
		successRate: number;
		costUsd: number;
		lastRunAt: number | null;
	}>;
	recent: Array<{
		runId: string;
		agentId: string;
		backend: string;
		status: DispatchResult['status'];
		startedAt: number;
		durationMs: number | null;
		costUsd: number;
		jid: string;
		taskSpec: string | null;
	}>;
	/** Phase 3 trigger: claude-cli-flag timeout count over last 14d. ADR
	 *  threshold is ≥3 in 2w. Reported regardless of period filter. */
	cliFlagTimeouts14d: number;
}

function db(): Database.Database {
	return getHeartbeatDb();
}

const DEFAULT_DAYS = 30;
const RECENT_LIMIT = 20;
const TOP_AGENTS_LIMIT = 10;

export function getOrchestratorMetrics(days = DEFAULT_DAYS): OrchestratorMetrics {
	const now = Date.now();
	const fromMs = now - days * 86_400_000;

	const aggRow = db()
		.prepare(
			`SELECT
				COUNT(*)                                                                         AS total,
				COALESCE(SUM(CASE WHEN status='success'         THEN 1 ELSE 0 END), 0)           AS s_success,
				COALESCE(SUM(CASE WHEN status='error'           THEN 1 ELSE 0 END), 0)           AS s_error,
				COALESCE(SUM(CASE WHEN status='cancelled'       THEN 1 ELSE 0 END), 0)           AS s_cancelled,
				COALESCE(SUM(CASE WHEN status='timeout'         THEN 1 ELSE 0 END), 0)           AS s_timeout,
				COALESCE(SUM(CASE WHEN status='budget-exceeded' THEN 1 ELSE 0 END), 0)           AS s_budget,
				COALESCE(SUM(CASE WHEN status='goal_achieved'   THEN 1 ELSE 0 END), 0)           AS s_goal_achieved,
				COALESCE(SUM(CASE WHEN status='awaiting-budget-approval' THEN 1 ELSE 0 END), 0)   AS s_awaiting,
				COALESCE(SUM(CASE WHEN status='awaiting-operator-input' THEN 1 ELSE 0 END), 0)  AS s_awaiting_operator,
				COALESCE(SUM(cost_usd), 0)                                                        AS costUsd,
				COALESCE(AVG(duration_ms), 0)                                                     AS avgDurationMs
			 FROM agent_runs
			 WHERE mode = 'production' AND jid IS NOT NULL AND started_at >= ?`,
		)
		.get(fromMs) as {
			total: number;
			s_success: number;
			s_error: number;
			s_cancelled: number;
			s_timeout: number;
			s_budget: number;
			s_goal_achieved: number;
			s_awaiting: number;
			s_awaiting_operator: number;
			costUsd: number;
			avgDurationMs: number;
		};

	const total = Number(aggRow.total);

	const backendRows = db()
		.prepare(
			`SELECT backend, COUNT(*) AS n
			 FROM agent_runs
			 WHERE mode = 'production' AND jid IS NOT NULL AND started_at >= ?
			 GROUP BY backend`,
		)
		.all(fromMs) as Array<{ backend: string; n: number }>;

	const byBackend: Record<string, number> = {};
	for (const r of backendRows) byBackend[r.backend] = Number(r.n);

	const topAgentRows = db()
		.prepare(
			`SELECT
				agent_id                                                                          AS agentId,
				COUNT(*)                                                                          AS runs,
				COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 0) AS successRate,
				COALESCE(SUM(cost_usd), 0)                                                        AS costUsd,
				MAX(started_at)                                                                   AS lastRunAt
			 FROM agent_runs
			 WHERE mode = 'production' AND jid IS NOT NULL AND started_at >= ?
			 GROUP BY agent_id
			 ORDER BY runs DESC, lastRunAt DESC
			 LIMIT ?`,
		)
		.all(fromMs, TOP_AGENTS_LIMIT) as Array<{
			agentId: string;
			runs: number;
			successRate: number;
			costUsd: number;
			lastRunAt: number | null;
		}>;

	const recentRows = db()
		.prepare(
			`SELECT
				run_id          AS runId,
				agent_id        AS agentId,
				backend,
				status,
				started_at      AS startedAt,
				duration_ms     AS durationMs,
				cost_usd        AS costUsd,
				jid,
				task_spec       AS taskSpec
			 FROM agent_runs
			 WHERE mode = 'production' AND jid IS NOT NULL AND started_at >= ?
			 ORDER BY started_at DESC
			 LIMIT ?`,
		)
		.all(fromMs, RECENT_LIMIT) as OrchestratorMetrics['recent'];

	// Phase 3 trigger window — fixed 14 days regardless of dashboard period.
	const cliFlagTimeoutsRow = db()
		.prepare(
			`SELECT COUNT(*) AS n
			 FROM agent_runs
			 WHERE backend = 'claude-cli-flag'
			   AND status = 'timeout'
			   AND started_at >= ?`,
		)
		.get(now - 14 * 86_400_000) as { n: number };

	return {
		period: { fromMs, toMs: now, days },
		dispatches: {
			total,
			byStatus: {
				success: Number(aggRow.s_success),
				error: Number(aggRow.s_error),
				cancelled: Number(aggRow.s_cancelled),
				timeout: Number(aggRow.s_timeout),
				'budget-exceeded': Number(aggRow.s_budget),
				goal_achieved: Number(aggRow.s_goal_achieved),
				'awaiting-budget-approval': Number(aggRow.s_awaiting),
				// ADR-026 P2 — operator-input paused runs.
				'awaiting-operator-input': Number(aggRow.s_awaiting_operator),
			},
		},
		cancelRate: total > 0 ? Number(aggRow.s_cancelled) / total : 0,
		successRate: total > 0 ? Number(aggRow.s_success) / total : 0,
		costUsd: Number(aggRow.costUsd),
		avgDurationMs: Number(aggRow.avgDurationMs),
		byBackend,
		byAgent: topAgentRows.map((r) => ({
			agentId: r.agentId,
			runs: Number(r.runs),
			successRate: Number(r.successRate),
			costUsd: Number(r.costUsd),
			lastRunAt: r.lastRunAt ? Number(r.lastRunAt) : null,
		})),
		recent: recentRows.map((r) => ({
			...r,
			startedAt: Number(r.startedAt),
			durationMs: r.durationMs == null ? null : Number(r.durationMs),
			costUsd: Number(r.costUsd),
		})),
		cliFlagTimeouts14d: Number(cliFlagTimeoutsRow.n),
	};
}
