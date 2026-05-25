/**
 * Agent run-history persistence.
 *
 * Owns queries against `agent_runs` (table defined in
 * `src/lib/channels/whatsapp/heartbeat-state.ts`, the single migration owner
 * for `heartbeat.db`). Pattern matches `src/lib/scheduler/db.ts` —
 * heartbeat-state owns DDL, feature module owns DML + lookups.
 *
 * One row per terminal dispatch. We don't persist a `started` row + UPDATE on
 * finish (cf. scheduler_runs) because dispatcher generators are short-lived
 * and we'd need crash-recovery sweeping; keeping it as a single insert on
 * completion is simpler and matches what other modules need (lifetime stats,
 * recent-runs list). If long-running PTY dispatches need mid-flight
 * visibility, we add it here later.
 */

import type Database from 'better-sqlite3';
import { getHeartbeatDb } from '../channels/whatsapp/heartbeat-state.js';
import type { DispatchMode, DispatchResult } from './dispatch/types.js';

const RESULT_EXCERPT_LIMIT = 800;

/** A run can be in-flight or interrupted, not just terminal — ADR-002 Layer 1
 *  started-row observability. `running` is written at dispatch start; a startup
 *  sweep flips orphaned `running` rows (lost to a process restart) to
 *  `interrupted` so killed runs stay visible instead of vanishing. */
export type RunStatus = DispatchResult['status'] | 'running' | 'interrupted';

export interface AgentRunInput {
	runId: string;
	agentId: string;
	backend: string;
	model?: string;
	provider?: string;
	mode: DispatchMode;
	taskSpec: string;
	sourceMessage?: string;
	jid?: string;
	startedAt: number; // epoch ms
	finishedAt: number; // epoch ms
	durationMs: number;
	status: DispatchResult['status'];
	costUsd: number;
	numTurns: number;
	resultExcerpt?: string;
	errorMessage?: string;
	/** ADR-002 Layer 1 — Claude Code session UUID for transcript re-location. */
	claudeSessionId?: string;
}

export interface AgentRunRow {
	id: number;
	runId: string;
	agentId: string;
	backend: string;
	model: string | null;
	provider: string | null;
	mode: DispatchMode;
	taskSpec: string;
	sourceMessage: string | null;
	jid: string | null;
	startedAt: number;
	finishedAt: number | null;
	durationMs: number | null;
	status: RunStatus;
	costUsd: number;
	numTurns: number;
	resultExcerpt: string | null;
	errorMessage: string | null;
	claudeSessionId: string | null;
}

export interface AgentLifetimeStats {
	agentId: string;
	totalRuns: number;
	totalCostUsd: number;
	totalTurns: number;
	successRate: number; // 0..1
	lastRunAt: number | null;
	lastStatus: RunStatus | null;
}

const SELECT_COLS = `
	id,
	run_id          AS runId,
	agent_id        AS agentId,
	backend,
	model,
	provider,
	mode,
	task_spec       AS taskSpec,
	source_message  AS sourceMessage,
	jid,
	started_at      AS startedAt,
	finished_at     AS finishedAt,
	duration_ms     AS durationMs,
	status,
	cost_usd        AS costUsd,
	num_turns       AS numTurns,
	result_excerpt  AS resultExcerpt,
	error_message   AS errorMessage,
	claude_session_id AS claudeSessionId
`;

function db(): Database.Database {
	return getHeartbeatDb();
}

function truncate(text: string | undefined, limit: number): string | null {
	if (!text) return null;
	if (text.length <= limit) return text;
	return text.slice(0, limit) + '…';
}

/** Insert one terminal-state row. Caller is responsible for ensuring this
 *  fires exactly once per dispatch (we wrap that in `dispatch/index.ts`). */
export function recordAgentRun(input: AgentRunInput): number {
	const result = db()
		.prepare(
			`INSERT INTO agent_runs (
				run_id, agent_id, backend, model, provider, mode,
				task_spec, source_message, jid,
				started_at, finished_at, duration_ms, status,
				cost_usd, num_turns, result_excerpt, error_message, claude_session_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.runId,
			input.agentId,
			input.backend,
			input.model ?? null,
			input.provider ?? null,
			input.mode,
			truncate(input.taskSpec, 4_000),
			truncate(input.sourceMessage, 4_000),
			input.jid ?? null,
			input.startedAt,
			input.finishedAt,
			input.durationMs,
			input.status,
			input.costUsd,
			input.numTurns,
			truncate(input.resultExcerpt, RESULT_EXCERPT_LIMIT),
			truncate(input.errorMessage, 1_000),
			input.claudeSessionId ?? null,
		);
	return Number(result.lastInsertRowid);
}

export interface AgentRunStartInput {
	runId: string;
	agentId: string;
	backend: string;
	model?: string;
	provider?: string;
	mode: DispatchMode;
	taskSpec: string;
	sourceMessage?: string;
	jid?: string;
	startedAt: number;
	/** projects-graph ADR-018 S2b — vault path of the artifact this run works
	 *  on, so the Workbench in_flight lane can find it. Unset for non-artifact
	 *  dispatches (orchestrator / CI). */
	subjectPath?: string;
}

/** ADR-002 Layer 1 — insert a `running` row the moment a dispatch starts, so
 *  in-flight and later-killed runs are visible on the audit page instead of
 *  appearing only on terminal completion. Paired with `finishAgentRun`. */
export function startAgentRun(input: AgentRunStartInput): number {
	const result = db()
		.prepare(
			`INSERT INTO agent_runs (
				run_id, agent_id, backend, model, provider, mode,
				task_spec, source_message, jid,
				started_at, status, subject_path
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
		)
		.run(
			input.runId,
			input.agentId,
			input.backend,
			input.model ?? null,
			input.provider ?? null,
			input.mode,
			truncate(input.taskSpec, 4_000),
			truncate(input.sourceMessage, 4_000),
			input.jid ?? null,
			input.startedAt,
			input.subjectPath ?? null,
		);
	return Number(result.lastInsertRowid);
}

/** projects-graph ADR-018 S2b — vault paths with an in-flight (unfinished)
 *  agent run. Drives the Workbench `in_flight` lane. */
export function listRunningSubjectPaths(): Set<string> {
	const rows = db()
		.prepare(
			`SELECT DISTINCT subject_path AS p FROM agent_runs
			 WHERE finished_at IS NULL AND subject_path IS NOT NULL`,
		)
		.all() as { p: string }[];
	return new Set(rows.map((r) => r.p));
}

export interface AgentRunFinishInput {
	runId: string;
	finishedAt: number;
	durationMs: number;
	status: RunStatus;
	costUsd: number;
	numTurns: number;
	resultExcerpt?: string;
	errorMessage?: string;
	claudeSessionId?: string;
}

/** Flip the `running` row for this runId to its terminal status + metrics.
 *  Returns the number of rows updated — 0 means no matching open row existed
 *  (the caller should fall back to a full `recordAgentRun` insert). */
export function finishAgentRun(input: AgentRunFinishInput): number {
	const result = db()
		.prepare(
			`UPDATE agent_runs SET
				finished_at = ?, duration_ms = ?, status = ?,
				cost_usd = ?, num_turns = ?, result_excerpt = ?,
				error_message = ?, claude_session_id = COALESCE(?, claude_session_id)
			WHERE run_id = ? AND finished_at IS NULL`,
		)
		.run(
			input.finishedAt,
			input.durationMs,
			input.status,
			input.costUsd,
			input.numTurns,
			truncate(input.resultExcerpt, RESULT_EXCERPT_LIMIT),
			truncate(input.errorMessage, 1_000),
			input.claudeSessionId ?? null,
			input.runId,
		);
	return result.changes;
}

/** ADR-006 Phase 2 — directly set the terminal status of a run row by runId,
 *  even one already `finished_at`-stamped. Used by the budget-approval gate:
 *  a paused run sits at `awaiting-budget-approval` (finished_at set); an
 *  operator "Stop" flips it to `budget-exceeded`, and the abandonment sweep
 *  flips stale ones the same way. Returns rows updated. */
export function setRunStatus(
	runId: string,
	status: RunStatus,
	opts: { errorMessage?: string } = {},
): number {
	const result = db()
		.prepare(
			`UPDATE agent_runs SET status = ?, error_message = COALESCE(?, error_message)
			 WHERE run_id = ?`,
		)
		.run(status, opts.errorMessage ?? null, runId);
	return result.changes;
}

/** ADR-006 Phase 2 — sweep paused budget-approval runs the operator never
 *  actioned. After `maxAgeMs` (default 6h, matching the Telegram button TTL)
 *  a still-`awaiting-budget-approval` row is flipped to `budget-exceeded` so it
 *  doesn't linger as actionable. The session transcript stays on disk; only the
 *  status changes. Returns rows swept. */
export function sweepAbandonedBudgetApprovals(maxAgeMs = 6 * 60 * 60 * 1000): number {
	const cutoff = Date.now() - maxAgeMs;
	const result = db()
		.prepare(
			`UPDATE agent_runs SET
				status = 'budget-exceeded',
				error_message = 'budget approval abandoned — no operator grant within the window'
			WHERE status = 'awaiting-budget-approval' AND started_at < ?`,
		)
		.run(cutoff);
	return result.changes;
}

/** Startup sweep — flip orphaned `running` rows (lost to a process restart /
 *  crash before they could finish) to `interrupted` so they stay visible.
 *  `maxAgeMs` guards against killing a genuinely-still-running dispatch in a
 *  multi-process setup; default 15m comfortably exceeds the longest budget. */
export function sweepInterruptedRuns(maxAgeMs = 900_000): number {
	const cutoff = Date.now() - maxAgeMs;
	const now = Date.now();
	const result = db()
		.prepare(
			`UPDATE agent_runs SET
				status = 'interrupted', finished_at = ?,
				duration_ms = ? - started_at,
				error_message = 'interrupted — process restart or crash before completion'
			WHERE status = 'running' AND finished_at IS NULL AND started_at < ?`,
		)
		.run(now, now, cutoff);
	return result.changes;
}

/** Lifetime stats for one agent. Excludes test-mode dispatches by default. */
export function getAgentStats(agentId: string, opts: { includeTest?: boolean } = {}): AgentLifetimeStats {
	const modeFilter = opts.includeTest ? '' : "AND mode = 'production'";
	const row = db()
		.prepare(
			`SELECT
				COUNT(*)                                          AS totalRuns,
				COALESCE(SUM(cost_usd), 0)                        AS totalCostUsd,
				COALESCE(SUM(num_turns), 0)                       AS totalTurns,
				COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 0) AS successRate,
				MAX(started_at)                                   AS lastRunAt
			FROM agent_runs
			WHERE agent_id = ? ${modeFilter}`,
		)
		.get(agentId) as Omit<AgentLifetimeStats, 'agentId' | 'lastStatus'>;

	const lastStatusRow = db()
		.prepare(
			`SELECT status FROM agent_runs
			WHERE agent_id = ? ${modeFilter}
			ORDER BY started_at DESC LIMIT 1`,
		)
		.get(agentId) as { status: RunStatus } | undefined;

	return {
		agentId,
		totalRuns: Number(row?.totalRuns ?? 0),
		totalCostUsd: Number(row?.totalCostUsd ?? 0),
		totalTurns: Number(row?.totalTurns ?? 0),
		successRate: Number(row?.successRate ?? 0),
		lastRunAt: row?.lastRunAt ? Number(row.lastRunAt) : null,
		lastStatus: lastStatusRow?.status ?? null,
	};
}

/** Batched stats lookup — single query for the `/api/agents` list endpoint. */
export function getAgentStatsBatch(
	agentIds: string[],
	opts: { includeTest?: boolean } = {},
): Map<string, AgentLifetimeStats> {
	const out = new Map<string, AgentLifetimeStats>();
	if (agentIds.length === 0) return out;

	const placeholders = agentIds.map(() => '?').join(',');
	const modeFilter = opts.includeTest ? '' : "AND mode = 'production'";

	const rows = db()
		.prepare(
			`SELECT
				agent_id                                   AS agentId,
				COUNT(*)                                   AS totalRuns,
				COALESCE(SUM(cost_usd), 0)                 AS totalCostUsd,
				COALESCE(SUM(num_turns), 0)                AS totalTurns,
				COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT(*), 0), 0) AS successRate,
				MAX(started_at)                            AS lastRunAt
			FROM agent_runs
			WHERE agent_id IN (${placeholders}) ${modeFilter}
			GROUP BY agent_id`,
		)
		.all(...agentIds) as Array<{
			agentId: string;
			totalRuns: number;
			totalCostUsd: number;
			totalTurns: number;
			successRate: number;
			lastRunAt: number | null;
		}>;

	// Last-status separately — single query per requested agent would be
	// chatty, so we use a window function in one go.
	const statusRows = db()
		.prepare(
			`SELECT agent_id AS agentId, status, started_at
			FROM (
				SELECT agent_id, status, started_at,
					ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY started_at DESC) AS rn
				FROM agent_runs
				WHERE agent_id IN (${placeholders}) ${modeFilter}
			)
			WHERE rn = 1`,
		)
		.all(...agentIds) as Array<{ agentId: string; status: RunStatus }>;

	const statusMap = new Map(statusRows.map((r) => [r.agentId, r.status]));

	for (const id of agentIds) {
		const r = rows.find((row) => row.agentId === id);
		out.set(id, {
			agentId: id,
			totalRuns: Number(r?.totalRuns ?? 0),
			totalCostUsd: Number(r?.totalCostUsd ?? 0),
			totalTurns: Number(r?.totalTurns ?? 0),
			successRate: Number(r?.successRate ?? 0),
			lastRunAt: r?.lastRunAt ? Number(r.lastRunAt) : null,
			lastStatus: statusMap.get(id) ?? null,
		});
	}
	return out;
}

/** Recent runs for one agent, newest first. Default 50, capped at 500. */
export function listAgentRuns(
	agentId: string,
	opts: { limit?: number; mode?: DispatchMode } = {},
): AgentRunRow[] {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
	const modeFilter = opts.mode ? 'AND mode = ?' : '';
	const args: unknown[] = [agentId];
	if (opts.mode) args.push(opts.mode);
	args.push(limit);

	return db()
		.prepare(
			`SELECT ${SELECT_COLS}
			FROM agent_runs
			WHERE agent_id = ? ${modeFilter}
			ORDER BY started_at DESC
			LIMIT ?`,
		)
		.all(...args) as AgentRunRow[];
}

/** ADR-007 — open paused runs awaiting a budget decision, newest-first. The
 *  web budget-approval surface lists these, merges each with its pending
 *  approval detail (ceilings + TTL), and drives the same resume/stop engine the
 *  Telegram buttons use. */
export function listAwaitingBudgetApprovals(): AgentRunRow[] {
	return db()
		.prepare(
			`SELECT ${SELECT_COLS}
			FROM agent_runs
			WHERE status = 'awaiting-budget-approval'
			ORDER BY started_at DESC`,
		)
		.all() as AgentRunRow[];
}

/** List runs for a single conversation (WhatsApp `jid`), newest-first. Used
 *  by the conversation-context helper to feed the orchestrator a thin slice
 *  of recent agent activity for the same chat. */
export function listAgentRunsByJid(
	jid: string,
	opts: { limit?: number; mode?: DispatchMode } = {},
): AgentRunRow[] {
	const limit = Math.min(Math.max(opts.limit ?? 5, 1), 100);
	const modeFilter = opts.mode ? 'AND mode = ?' : '';
	const args: unknown[] = [jid];
	if (opts.mode) args.push(opts.mode);
	args.push(limit);

	return db()
		.prepare(
			`SELECT ${SELECT_COLS}
			FROM agent_runs
			WHERE jid = ? ${modeFilter}
			ORDER BY started_at DESC
			LIMIT ?`,
		)
		.all(...args) as AgentRunRow[];
}
