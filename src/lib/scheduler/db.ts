/** Scheduler run-history persistence.
 *
 *  Owns the `scheduler_runs` table — domain-agnostic record of every task
 *  invocation. The schema migration lives in `heartbeat-state.ts` (the
 *  single migration owner for `heartbeat.db`); this module owns the
 *  queries.
 *
 *  Status values:
 *    started          run dispatched, fn() invoked
 *    success          fn() returned without throwing
 *    error            fn() threw
 *    overlap-skipped  noOverlap=true and a started row exists
 */

import type Database from 'better-sqlite3';
import { getHeartbeatDb } from '../channels/whatsapp/heartbeat-state.js';

export type RunStatus = 'started' | 'success' | 'error' | 'overlap-skipped';

export interface RunRow {
	id: number;
	taskId: string;
	scheduledFor: string;
	startedAt: string;
	finishedAt: string | null;
	status: RunStatus;
	durationMs: number | null;
	errorMessage: string | null;
	outputSummary: string | null;
}

const SELECT_COLS = `
	id,
	task_id        AS taskId,
	scheduled_for  AS scheduledFor,
	started_at     AS startedAt,
	finished_at    AS finishedAt,
	status,
	duration_ms    AS durationMs,
	error_message  AS errorMessage,
	output_summary AS outputSummary
`;

function db(): Database.Database {
	return getHeartbeatDb();
}

export interface RecordStartInput {
	taskId: string;
	scheduledFor: string; // ISO timestamp of the cron tick (or runNow time)
	startedAt?: string;   // ISO; defaults to now
}

/** Insert a `started` row. Returns the row id so the caller can later
 *  update it on completion. */
export function recordRunStarted(input: RecordStartInput): number {
	const startedAt = input.startedAt ?? new Date().toISOString();
	const result = db()
		.prepare(
			`INSERT INTO scheduler_runs (task_id, scheduled_for, started_at, status)
			 VALUES (?, ?, ?, 'started')`,
		)
		.run(input.taskId, input.scheduledFor, startedAt);
	return Number(result.lastInsertRowid);
}

/** Mark a previously-started row as `success`. */
export function recordRunFinished(
	runId: number,
	opts: { finishedAt?: string; durationMs?: number; outputSummary?: unknown } = {},
): void {
	const finishedAt = opts.finishedAt ?? new Date().toISOString();
	const summary = opts.outputSummary !== undefined
		? safeStringify(opts.outputSummary)
		: null;
	db()
		.prepare(
			`UPDATE scheduler_runs
			 SET finished_at = ?, status = 'success', duration_ms = ?, output_summary = ?
			 WHERE id = ?`,
		)
		.run(finishedAt, opts.durationMs ?? null, summary, runId);
}

/** Mark a previously-started row as `error`. */
export function recordRunError(
	runId: number,
	opts: { finishedAt?: string; durationMs?: number; errorMessage: string },
): void {
	const finishedAt = opts.finishedAt ?? new Date().toISOString();
	db()
		.prepare(
			`UPDATE scheduler_runs
			 SET finished_at = ?, status = 'error', duration_ms = ?, error_message = ?
			 WHERE id = ?`,
		)
		.run(finishedAt, opts.durationMs ?? null, opts.errorMessage, runId);
}

/** Insert an `overlap-skipped` row in one shot — never moves through
 *  `started`. Captures that the cron tick fired but was suppressed. */
export function recordRunSkippedOverlap(taskId: string, scheduledFor: string): number {
	const ts = new Date().toISOString();
	const result = db()
		.prepare(
			`INSERT INTO scheduler_runs
				(task_id, scheduled_for, started_at, finished_at, status, duration_ms)
			 VALUES (?, ?, ?, ?, 'overlap-skipped', 0)`,
		)
		.run(taskId, scheduledFor, ts, ts);
	return Number(result.lastInsertRowid);
}

/** True iff a `started` row exists for the task with no `finished_at`.
 *  Used by runner to enforce noOverlap across cron ticks. */
export function hasActiveRun(taskId: string): boolean {
	const row = db()
		.prepare(
			`SELECT 1 FROM scheduler_runs
			 WHERE task_id = ? AND status = 'started' AND finished_at IS NULL
			 LIMIT 1`,
		)
		.get(taskId);
	return row !== undefined;
}

export function lastSuccessfulRun(taskId: string): RunRow | null {
	const row = db()
		.prepare(
			`SELECT ${SELECT_COLS} FROM scheduler_runs
			 WHERE task_id = ? AND status = 'success'
			 ORDER BY started_at DESC LIMIT 1`,
		)
		.get(taskId) as RunRow | undefined;
	return row ?? null;
}

export function runHistory(taskId: string, limit = 50): RunRow[] {
	return db()
		.prepare(
			`SELECT ${SELECT_COLS} FROM scheduler_runs
			 WHERE task_id = ?
			 ORDER BY started_at DESC LIMIT ?`,
		)
		.all(taskId, limit) as RunRow[];
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify({ error: 'output_summary failed to serialise' });
	}
}
