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
export type RunStatus =
	| DispatchResult['status']
	| 'running'
	| 'interrupted'
	/** ADR-012 P1 — a production coding dispatch that reported success-like
	 *  (`success`/`goal_achieved`) but produced NO reviewable artifact (no
	 *  committed orchestration branch AND no parseable hand-back). Recorded
	 *  instead of a false `goal_achieved`, and surfaced in the Waiting-on-you
	 *  lane so the run doesn't silently fall back to ready_for_ai. */
	| 'completed-no-artifact';

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
	// ADR-012 P1 — RunStatus (not just DispatchResult['status']) so the
	// deliverable-gated `completed-no-artifact` can be persisted via this path too.
	status: RunStatus;
	costUsd: number;
	numTurns: number;
	resultExcerpt?: string;
	errorMessage?: string;
	/** ADR-002 Layer 1 — Claude Code session UUID for transcript re-location. */
	claudeSessionId?: string;
	/** ADR-026 D3 — raw ```json``` hand-back block, stored untruncated. */
	handback?: string;
	/** ADR-031 P1 — expanded absolute path of the repo this run operated in.
	 *  null = legacy/soul-hub (backward compatible). Written by the dispatcher
	 *  using the resolved `effectiveRepo` (project repo ?? agent.repo). */
	repo?: string;
	/** ADR-020 P1 — phase tag for this run.  Conventional values: 'initial' |
	 *  'P1' | 'P2' | 'finish' | 'falsifier' | 'iterate-N'. */
	phase?: string;
	/** ADR-020 P4 — JSON-serialised scope snapshot ({allowed_paths,
	 *  forbidden_paths}). Mirrors the value the start row would have written;
	 *  the hook reads this back by claude_session_id. */
	scopeJson?: string;
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
	/** ADR-026 P2b — vault path of the artifact this run works on (null for
	 *  non-artifact dispatches). Populated by `startAgentRun`; exposed here so
	 *  the Workbench can surface awaiting-operator items per subject. */
	subjectPath: string | null;
	/** ADR-026 D3 — raw ```json``` hand-back block, stored untruncated.
	 *  Null for runs predating this column or non-coding dispatches. */
	handback: string | null;
	/** ADR-031 P1 — expanded absolute path of the repo this run operated in.
	 *  null = legacy/soul-hub. ship-merge and review-handoff fall back to
	 *  `SOUL_HUB_REPO ?? cwd` when null. */
	repo: string | null;
	/** ADR-020 P1 — phase tag for this run (descriptive, not validated).
	 *  Conventional values: 'initial' | 'P1' | 'P2' | 'finish' | 'falsifier' |
	 *  'iterate-N'. null = pre-migration runs, treated as 'initial' at read time.
	 *  The drawer's per-ADR run-history strip groups by phase + sums cumulative
	 *  cost. Foundation for ADR-020 P2 (resume UX) and P3 (cumulative budget). */
	phase: string | null;
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
	claude_session_id AS claudeSessionId,
	subject_path    AS subjectPath,
	handback        AS handback,
	repo            AS repo,
	phase           AS phase
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
				cost_usd, num_turns, result_excerpt, error_message, claude_session_id,
				handback, repo, phase, scope_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			// ADR-026 D3 — stored untruncated; the hand-back block is ~1 KB max.
			input.handback ?? null,
			// ADR-031 P1 — persist the run's repo; null = legacy/soul-hub.
			input.repo ?? null,
			// ADR-020 P1 — phase tag; null = pre-migration / un-tagged, treated
			// as 'initial' at read time.
			input.phase ?? null,
			// ADR-020 P4 — scope snapshot; null = hook bypass (no enforcement).
			input.scopeJson ?? null,
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
	/** ADR-031 P1 — expanded absolute path of the repo this run operates in.
	 *  null = legacy/soul-hub (backward compatible). Written at dispatch-start
	 *  so review-handoff and ship-merge can route git to the right repo. */
	repo?: string;
	/** ADR-020 P1 — phase tag for this run.  Conventional values: 'initial' |
	 *  'P1' | 'P2' | 'finish' | 'falsifier' | 'iterate-N'.  Descriptive, not
	 *  validated; the operator/dispatcher sets it.  Absent → null in DB →
	 *  treated as 'initial' at read time. */
	phase?: string;
	/** ADR-020 P4 — JSON-serialised `{ allowed_paths, forbidden_paths }`
	 *  snapshot from the ADR's frontmatter (or `opts.scope` override). The
	 *  dispatch-scope-guard.sh PreToolUse hook reads this back by
	 *  claude_session_id to refuse out-of-scope writes. null = no enforcement
	 *  (legacy runs or ADRs without a `scope:` block). */
	scopeJson?: string;
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
				started_at, status, subject_path, repo, phase, scope_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
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
			// ADR-031 P1 — persist repo at run start so review-handoff can read it
			// even if the process crashes before finishAgentRun.
			input.repo ?? null,
			// ADR-020 P1 — phase tag at run start; null when caller doesn't set
			// it (legacy/un-tagged dispatches), treated as 'initial' at read time.
			input.phase ?? null,
			// ADR-020 P4 — scope_json snapshot at run start; null = hook bypass
			// (no enforcement). Hook joins on claude_session_id once the dispatcher
			// has set it via updateRunSessionId.
			input.scopeJson ?? null,
		);
	return Number(result.lastInsertRowid);
}

/** ADR-020 P1 — auto-derive a phase tag when the caller doesn't supply one.
 *  Looks at prior finished runs for the same `subjectPath`:
 *    - no priors             → 'initial'
 *    - has any prior success → 'follow-up'   (post-ship continuation)
 *    - only failures         → 'retry-N'     (N = prior failures + 1)
 *  Returns null when `subjectPath` is absent (non-artifact dispatch — no ADR
 *  to group by). Caller-supplied `opts.phase` always wins; this is the fallback
 *  so the column populates even when the dispatcher call site forgot to label.
 *
 *  Closes the dark-column gap surfaced 2026-05-29: schema + persistence existed
 *  but only `bump-continue` was injecting a value, so `agent_runs.phase` was
 *  NULL for every chat / scheduler / hygiene / orchestrator dispatch, defeating
 *  the workbench drawer's per-phase grouping and blocking ADR-020 P3's
 *  cumulative-budget aggregation. */
const SUCCESS_STATUSES_FOR_PHASE = new Set(['success', 'goal_achieved']);
const FAILURE_STATUSES_FOR_PHASE = new Set([
	'error',
	'timeout',
	'cancelled',
	'interrupted',
	'budget-exceeded',
]);

export function derivePhase(subjectPath: string | undefined | null): string | null {
	if (!subjectPath) return null;
	const priors = db()
		.prepare(
			`SELECT status FROM agent_runs
			 WHERE subject_path = ? AND finished_at IS NOT NULL`,
		)
		.all(subjectPath) as Array<{ status: string }>;
	if (priors.length === 0) return 'initial';
	if (priors.some((p) => SUCCESS_STATUSES_FOR_PHASE.has(p.status))) return 'follow-up';
	const failures = priors.filter((p) => FAILURE_STATUSES_FOR_PHASE.has(p.status)).length;
	if (failures > 0) return `retry-${failures + 1}`;
	return 'initial';
}

/** ADR-020 P3 — cumulative `cost_usd` across all finished runs of one
 *  vault artifact. Drives the dispatcher's per-ADR budget gate: a fresh
 *  dispatch refuses when `cumulativeAdrSpend(subjectPath) +
 *  agent.budget.max_usd > dispatch_budget_usd`.
 *
 *  Excludes:
 *   - In-flight rows (`finished_at IS NULL`) — they're not terminal; ADR-022 D3
 *     already refuses concurrent dispatches so they can't double-count anyway.
 *   - `status = 'error'` runs — bug fix #61 (2026-05-29). The premise: if a run
 *     ended in `error` (PTY crash, stall, infra fault, operator-cancelled mid-
 *     run via the error-tagged exit), the operator's budget was wasted by a
 *     fault, not consumed by productive work. Counting it against the cap
 *     punishes the operator twice — first the wasted spend, then headroom for
 *     a fresh attempt. The other terminal statuses (`success`, `goal_achieved`,
 *     `budget-exceeded`, `cancelled`, `interrupted`, `awaiting-*`) DO count
 *     because the work either succeeded, partial-shipped, or was an explicit
 *     operator/budget choice — the spend was the operator's call.
 *
 *  Returns 0 when no qualifying terminal runs exist or `subjectPath` is absent. */
export function cumulativeAdrSpend(subjectPath: string | undefined | null): number {
	if (!subjectPath) return 0;
	const row = db()
		.prepare(
			`SELECT COALESCE(SUM(cost_usd), 0) AS total
			 FROM agent_runs
			 WHERE subject_path = ?
			   AND finished_at IS NOT NULL
			   AND status != 'error'`,
		)
		.get(subjectPath) as { total: number };
	return Number(row?.total ?? 0);
}

/** ADR-020 P4 — stamp `claude_session_id` on the running row immediately at
 *  dispatch start (not just at finish, where it lands via
 *  `finishAgentRun`'s COALESCE). The dispatch-scope-guard.sh PreToolUse hook
 *  joins `agent_runs ON claude_session_id` to look up `scope_json`, so it
 *  needs a real value mid-run, not NULL.
 *
 *  Best-effort: no-op when `claudeSessionId` is falsy (other backends may not
 *  surface it at start). Returns rows-updated for logging. */
export function updateRunSessionId(runId: string, claudeSessionId: string | undefined | null): number {
	if (!claudeSessionId) return 0;
	const res = db()
		.prepare(`UPDATE agent_runs SET claude_session_id = ? WHERE run_id = ? AND claude_session_id IS NULL`)
		.run(claudeSessionId, runId);
	return Number(res.changes);
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

/** projects-graph ADR-026 — live telemetry for in-flight agent runs, keyed by
 *  subject_path. Enriches the Workbench `in_flight` lane with cost / turn /
 *  elapsed data so the operator can see real progress without a page reload.
 *
 *  When multiple unfinished rows share a subject_path (edge case: a crashed run
 *  followed by a fresh dispatch before the crash-sweep fires), the most-recently-
 *  started row wins.
 *
 *  @param _overrideDb  Optional DB instance injected by tests; production code
 *    omits this and uses the module-level singleton via `db()`. */
export interface RunningRunTelemetry {
	costUsd: number;
	numTurns: number;
	startedAt: number; // epoch ms
	status: string;
}

export function listRunningRuns(
	_overrideDb?: Database.Database,
): Map<string, RunningRunTelemetry> {
	const database = _overrideDb ?? db();
	const rows = database
		.prepare(
			`SELECT subject_path AS p, cost_usd AS costUsd, num_turns AS numTurns,
			        started_at AS startedAt, status
			 FROM agent_runs
			 WHERE finished_at IS NULL AND subject_path IS NOT NULL`,
		)
		.all() as Array<{
		p: string;
		costUsd: number;
		numTurns: number;
		startedAt: number;
		status: string;
	}>;
	const out = new Map<string, RunningRunTelemetry>();
	for (const r of rows) {
		// Keep most-recently-started row per subject_path.
		const existing = out.get(r.p);
		if (!existing || r.startedAt > existing.startedAt) {
			out.set(r.p, {
				costUsd: Number(r.costUsd),
				numTurns: Number(r.numTurns),
				startedAt: Number(r.startedAt),
				status: r.status,
			});
		}
	}
	return out;
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
	/** ADR-026 D3 — raw ```json``` hand-back block, stored untruncated. */
	handback?: string;
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
				error_message = ?, claude_session_id = COALESCE(?, claude_session_id),
				handback = COALESCE(?, handback)
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
			// ADR-026 D3 — stored untruncated; COALESCE keeps the existing value if
			// this finish call somehow provides no hand-back (defensive).
			input.handback ?? null,
			input.runId,
		);
	return result.changes;
}

/** ADR-026 P3 — persist live cost/turns from the poll loop into the `running`
 *  row so the board chip can show real numbers mid-run instead of `$0.00 · 0t`.
 *  Only touches unfinished rows (WHERE finished_at IS NULL) so a finish() that
 *  races with a progress tick can never clobber the final values. Best-effort —
 *  callers ignore the return value; failures are logged upstream. */
export function updateRunProgress(runId: string, p: { costUsd: number; numTurns: number }): void {
	db()
		.prepare(
			`UPDATE agent_runs SET cost_usd = ?, num_turns = ?
			 WHERE run_id = ? AND finished_at IS NULL`,
		)
		.run(p.costUsd, p.numTurns, runId);
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

/** ADR-005 gap #3 — fetch a single run by its runId (for the run-detail
 *  sub-agent drill-down). Returns null if unknown. */
export function getAgentRun(runId: string): AgentRunRow | null {
	const row = db()
		.prepare(`SELECT ${SELECT_COLS} FROM agent_runs WHERE run_id = ? LIMIT 1`)
		.get(runId);
	return (row as AgentRunRow) ?? null;
}

/** CLI helper — list recent runs across all agents with optional filters.
 *  Powers `soul run list [--status X] [--subject-path Y] [--limit N]`,
 *  eliminating the recurring `sqlite3 ~/.soul-hub/data/ops/ops.db` escape
 *  hatch operators reached for tonight.  Read-only; newest-first.
 *  Limit is bounded [1, 500] like `listAgentRuns`. */
export function listRecentRuns(opts: {
	status?: string;
	subjectPath?: string;
	agentId?: string;
	limit?: number;
} = {}): AgentRunRow[] {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
	const where: string[] = [];
	const args: unknown[] = [];
	if (opts.status) {
		where.push('status = ?');
		args.push(opts.status);
	}
	if (opts.subjectPath) {
		where.push('subject_path = ?');
		args.push(opts.subjectPath);
	}
	if (opts.agentId) {
		where.push('agent_id = ?');
		args.push(opts.agentId);
	}
	const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
	args.push(limit);
	return db()
		.prepare(
			`SELECT ${SELECT_COLS}
			FROM agent_runs
			${whereClause}
			ORDER BY started_at DESC
			LIMIT ?`,
		)
		.all(...args) as AgentRunRow[];
}

/** ADR-020 P1 — per-ADR run history.
 *
 *  Returns all runs for a given vault subject_path ordered oldest-first
 *  (so the drawer renders them as a timeline), plus a cumulative cost
 *  total across all runs.  Powers the drawer's "Run history" strip.
 *
 *  A run's `phase` is descriptive (not validated).  Conventional values:
 *    'initial' | 'P1' | 'P2' | 'finish' | 'falsifier' | 'iterate' | 'iterate-N'
 *  Null `phase` (pre-migration runs) reads as 'initial' at the UI layer.
 *
 *  @param subjectPath  Vault-relative path of the artifact, e.g.
 *                      `projects/soul-hub-agents/adr-011-...md`.  Returns an
 *                      empty history when no runs exist for it.
 *  @returns            `{ runs: AgentRunRow[]; cumulativeCostUsd: number }`.
 */
export interface AdrRunHistory {
	runs: AgentRunRow[];
	cumulativeCostUsd: number;
}

export function getAdrRunHistory(
	subjectPath: string,
	_overrideDb?: Database.Database,
): AdrRunHistory {
	if (!subjectPath) return { runs: [], cumulativeCostUsd: 0 };
	const database = _overrideDb ?? db();
	const rows = database
		.prepare(
			`SELECT ${SELECT_COLS}
			FROM agent_runs
			WHERE subject_path = ?
			ORDER BY started_at ASC`,
		)
		.all(subjectPath) as AgentRunRow[];
	const cumulativeCostUsd = rows.reduce((sum, r) => sum + (r.costUsd || 0), 0);
	return { runs: rows, cumulativeCostUsd };
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

/** ADR-026 P2 — open paused runs awaiting an operator answer, newest-first.
 *  The question lives in `error_message` prefixed with `OPERATOR_QUESTION: `.
 *
 *  @param _overrideDb  Optional DB instance injected by tests; production code
 *    omits this and uses the module-level singleton via `db()`. */
export function listAwaitingOperatorInput(
	_overrideDb?: Database.Database,
): AgentRunRow[] {
	const database = _overrideDb ?? db();
	return database
		.prepare(
			`SELECT ${SELECT_COLS}
			FROM agent_runs
			WHERE status = 'awaiting-operator-input'
			ORDER BY started_at DESC`,
		)
		.all() as AgentRunRow[];
}

/** ADR-026 P2 — sweep operator-input runs the operator never answered.
 *  After `maxAgeMs` (default 6h, matching the budget-approval TTL) a
 *  still-`awaiting-operator-input` row is flipped to `timeout` so it
 *  doesn't linger as actionable. Returns rows swept. */
export function sweepAbandonedOperatorInputs(maxAgeMs = 6 * 60 * 60 * 1000): number {
	const cutoff = Date.now() - maxAgeMs;
	const result = db()
		.prepare(
			`UPDATE agent_runs SET
				status = 'timeout',
				error_message = 'operator input not provided within the window'
			WHERE status = 'awaiting-operator-input' AND started_at < ?`,
		)
		.run(cutoff);
	return result.changes;
}

/** ADR-026 D3 — shape of one reviewable run entry returned by `listReviewableRuns`. */
export interface ReviewableRun {
	runId: string;
	status: RunStatus;
	costUsd: number;
	numTurns: number;
	startedAt: number; // epoch ms
	resultExcerpt: string | null;
	/** ADR-026 D3 — raw ```json``` hand-back block, stored untruncated.
	 *  Null for runs predating this column or non-coding dispatches.
	 *  The worklist parses this first; falls back to resultExcerpt if null. */
	handback: string | null;
}

/** ADR-026 D3 — latest finished reviewable run per subject_path for which the
 *  operator hasn't yet merged/shipped the branch.  Surfaces runs that are
 *  success-like (goal_achieved/success) OR carry a hand-back (soul-hub-agents
 *  ADR-017 — a hand-back is a deliverable even when a stall false-flagged the
 *  run `error`), with finished_at set and subject_path non-null.  Returns
 *  newest-first, deduplicated to one per subject_path.
 *
 *  @param _overrideDb  Optional DB instance injected by tests; production code
 *    omits this and uses the module-level singleton via `db()`. */
export function listReviewableRuns(
	_overrideDb?: Database.Database,
): Map<string, ReviewableRun> {
	const database = _overrideDb ?? db();
	const rows = database
		.prepare(
			`SELECT subject_path AS p, run_id AS runId, status,
			        cost_usd AS costUsd, num_turns AS numTurns,
			        started_at AS startedAt, result_excerpt AS resultExcerpt,
			        handback AS handback
			 FROM agent_runs
			 WHERE finished_at IS NOT NULL
			   AND subject_path IS NOT NULL
			   -- soul-hub-agents ADR-017 — reviewability follows the artifact, not
			   -- the status label: a hand-back means a real deliverable even when a
			   -- stall false-flagged the run 'error'. (Mirrors getReviewableRunForSubject.)
			   AND (status IN ('goal_achieved','success')
			        OR (handback IS NOT NULL AND length(handback) > 0))
			 ORDER BY started_at DESC`,
		)
		.all() as Array<{
		p: string;
		runId: string;
		status: string;
		costUsd: number;
		numTurns: number;
		startedAt: number;
		resultExcerpt: string | null;
		handback: string | null;
	}>;

	const out = new Map<string, ReviewableRun>();
	for (const r of rows) {
		// ORDER BY started_at DESC → first seen per subject_path is the newest.
		if (!out.has(r.p)) {
			out.set(r.p, {
				runId: r.runId,
				status: r.status as RunStatus,
				costUsd: Number(r.costUsd),
				numTurns: Number(r.numTurns),
				startedAt: Number(r.startedAt),
				resultExcerpt: r.resultExcerpt,
				handback: r.handback,
			});
		}
	}
	return out;
}

/** ADR-026 D3 (drawer hydration) — one reviewable run for a single subject,
 *  enriched with `claudeSessionId` so the drawer can offer "Send back to AI"
 *  (`--resume`) for a PAST completed run, not just a live in-drawer dispatch. */
export interface SubjectReviewRun extends ReviewableRun {
	/** Claude PTY session id, for `--resume` on Send-back / re-dispatch. */
	claudeSessionId: string | null;
	/** ADR-031 P1 — expanded absolute path of the repo this run operated in.
	 *  null = legacy/soul-hub. Used by ship-merge and review-handoff to route
	 *  git operations to the run's actual repo. */
	repo: string | null;
}

/** ADR-026 D3 (drawer hydration) — the latest finished successful run for ONE
 *  subject_path (goal_achieved/success, finished_at set). Returns null when the
 *  subject has no such run. Used by `/api/agents/review-handoff` so opening the
 *  drawer on a past dispatch re-shows the ADR-024 review card + Ship/Send-back,
 *  instead of the card only existing during a live dispatch stream.
 *
 *  @param _overrideDb  Optional DB instance injected by tests. */
export function getReviewableRunForSubject(
	subjectPath: string,
	_overrideDb?: Database.Database,
): SubjectReviewRun | null {
	const database = _overrideDb ?? db();
	const row = database
		.prepare(
			`SELECT run_id AS runId, status,
			        cost_usd AS costUsd, num_turns AS numTurns,
			        started_at AS startedAt, result_excerpt AS resultExcerpt,
			        handback AS handback, claude_session_id AS claudeSessionId,
			        repo AS repo
			 FROM agent_runs
			 WHERE subject_path = ?
			   AND finished_at IS NOT NULL
			   -- soul-hub-agents ADR-017 — reviewability derives from the ARTIFACT,
			   -- not the run's status label. A run that emitted a hand-back is a
			   -- real deliverable even when the stall-detector false-flagged it
			   -- 'error' (no end_turn after the hand-back; surfaced by ADR-003
			   -- run #491). The downstream branchLive check (review-handoff) +
			   -- ship-merge green-gate guard remain the safety floor.
			   AND (status IN ('goal_achieved','success')
			        OR (handback IS NOT NULL AND length(handback) > 0))
			 ORDER BY started_at DESC
			 LIMIT 1`,
		)
		.get(subjectPath) as
		| {
				runId: string;
				status: string;
				costUsd: number;
				numTurns: number;
				startedAt: number;
				resultExcerpt: string | null;
				handback: string | null;
				claudeSessionId: string | null;
				repo: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		runId: row.runId,
		status: row.status as RunStatus,
		costUsd: Number(row.costUsd),
		numTurns: Number(row.numTurns),
		startedAt: Number(row.startedAt),
		resultExcerpt: row.resultExcerpt,
		handback: row.handback,
		claudeSessionId: row.claudeSessionId ?? null,
		// ADR-031 P1 — repo is null for legacy/pre-migration runs; endpoints
		// fall back to SOUL_HUB_REPO ?? cwd when null.
		repo: row.repo ?? null,
	};
}

/** ADR-012 P1 — shape of one `completed-no-artifact` run for a subject. */
export interface NoArtifactRun {
	runId: string;
	costUsd: number;
	numTurns: number;
	startedAt: number; // epoch ms
	resultExcerpt: string | null;
}

/** ADR-012 P1 — latest `completed-no-artifact` run per subject_path (finished,
 *  subject set). These are dispatches that looked successful but left nothing
 *  to review; the worklist surfaces them in Waiting-on-you with a "no branch /
 *  hand-back — review manually" note instead of a silent ready_for_ai fallback.
 *  Mirrors `listReviewableRuns`: newest-first, deduped to one per subject.
 *
 *  @param _overrideDb  Optional DB instance injected by tests. */
export function listNoArtifactRuns(
	_overrideDb?: Database.Database,
): Map<string, NoArtifactRun> {
	const database = _overrideDb ?? db();
	const rows = database
		.prepare(
			`SELECT subject_path AS p, run_id AS runId,
			        cost_usd AS costUsd, num_turns AS numTurns,
			        started_at AS startedAt, result_excerpt AS resultExcerpt
			 FROM agent_runs
			 WHERE status = 'completed-no-artifact'
			   AND finished_at IS NOT NULL
			   AND subject_path IS NOT NULL
			 ORDER BY started_at DESC`,
		)
		.all() as Array<{
		p: string;
		runId: string;
		costUsd: number;
		numTurns: number;
		startedAt: number;
		resultExcerpt: string | null;
	}>;

	const out = new Map<string, NoArtifactRun>();
	for (const r of rows) {
		if (!out.has(r.p)) {
			out.set(r.p, {
				runId: r.runId,
				costUsd: Number(r.costUsd),
				numTurns: Number(r.numTurns),
				startedAt: Number(r.startedAt),
				resultExcerpt: r.resultExcerpt,
			});
		}
	}
	return out;
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
