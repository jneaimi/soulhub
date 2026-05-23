/**
 * Naseej audit query module.
 *
 * Owns DML against the `naseej_runs` + `naseej_publish_log` tables (defined
 * in `./audit-db.ts`). Pattern matches `src/lib/agents/runs.ts`: feature
 * module here, single-migration-owner over in audit-db.ts.
 *
 * All writes are wrapped to **never throw upstream** — audit is non-critical
 * (a failed insert must never break a real recipe run or a real publish gate).
 * Errors are caught + logged to stderr and absorbed.
 */

import type Database from 'better-sqlite3';
import { getNaseejDb } from './audit-db.js';

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'paused';
export type RunMode = 'production' | 'test' | 'oneshot';
export type RunSource = 'api' | 'scheduler' | 'cli' | 'chat';
export type PublishStatus = 'passed' | 'failed';

export interface RecordRunStartInput {
	runId: string;
	recipe: string;
	recipeVersion: string;
	project: string;
	mode: RunMode;
	source: RunSource;
	startedAt: number; // epoch ms
}

export interface RecordRunEndInput {
	runId: string;
	status: Exclude<RunStatus, 'running'>;
	finishedAt: number;
	durationMs: number;
	stepsJson?: string;
	error?: string;
	failedStep?: string;
	costUsd?: number;
}

export interface RecordPublishInput {
	component: string;
	version?: string;
	publishedAt: number;
	status: PublishStatus;
	checksJson: string;
	durationMs: number;
}

export interface NaseejRunRow {
	id: number;
	runId: string;
	recipe: string;
	recipeVersion: string;
	project: string;
	status: RunStatus;
	startedAt: number;
	finishedAt: number | null;
	durationMs: number | null;
	mode: RunMode;
	source: RunSource;
	stepsJson: string | null;
	error: string | null;
	failedStep: string | null;
	costUsd: number | null;
}

export interface NaseejPublishRow {
	id: number;
	component: string;
	version: string | null;
	publishedAt: number;
	status: PublishStatus;
	checksJson: string;
	durationMs: number;
}

const RUNS_COLS = `
	id,
	run_id          AS runId,
	recipe,
	recipe_version  AS recipeVersion,
	project,
	status,
	started_at      AS startedAt,
	finished_at     AS finishedAt,
	duration_ms     AS durationMs,
	mode,
	source,
	steps_json      AS stepsJson,
	error,
	failed_step     AS failedStep,
	cost_usd        AS costUsd
`;

const PUBLISH_COLS = `
	id,
	component,
	version,
	published_at    AS publishedAt,
	status,
	checks_json     AS checksJson,
	duration_ms     AS durationMs
`;

function db(): Database.Database {
	return getNaseejDb();
}

/** Audit writes are non-critical: never let an audit DB failure surface to
 *  the caller. Wraps the body in try/catch + logs. */
function safe(label: string, body: () => void): void {
	try {
		body();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[naseej-audit] ${label} failed: ${msg}`);
	}
}

/** Insert a `naseej_runs` row at recipe-start with status='running'. */
export function recordRunStart(input: RecordRunStartInput): void {
	safe('recordRunStart', () => {
		db()
			.prepare(
				`INSERT INTO naseej_runs (
					run_id, recipe, recipe_version, project,
					status, started_at, mode, source
				) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
			)
			.run(
				input.runId,
				input.recipe,
				input.recipeVersion,
				input.project,
				input.startedAt,
				input.mode,
				input.source,
			);
	});
}

/** Update the matching `naseej_runs` row at recipe-end. */
export function recordRunEnd(input: RecordRunEndInput): void {
	safe('recordRunEnd', () => {
		db()
			.prepare(
				`UPDATE naseej_runs SET
					status        = ?,
					finished_at   = ?,
					duration_ms   = ?,
					steps_json    = ?,
					error         = ?,
					failed_step   = ?,
					cost_usd      = ?
				 WHERE run_id = ?`,
			)
			.run(
				input.status,
				input.finishedAt,
				input.durationMs,
				input.stepsJson ?? null,
				input.error ?? null,
				input.failedStep ?? null,
				input.costUsd ?? null,
				input.runId,
			);
	});
}

/** Insert a `naseej_publish_log` row. Fires on every POST /api/components
 *  attempt (passed AND failed — both are signal). */
export function recordPublish(input: RecordPublishInput): void {
	safe('recordPublish', () => {
		db()
			.prepare(
				`INSERT INTO naseej_publish_log (
					component, version, published_at, status, checks_json, duration_ms
				) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.component,
				input.version ?? null,
				input.publishedAt,
				input.status,
				input.checksJson,
				input.durationMs,
			);
	});
}

export interface ListRunsOptions {
	limit?: number;
	recipe?: string;
	status?: RunStatus;
	project?: string;
}

export function listRuns(opts: ListRunsOptions = {}): NaseejRunRow[] {
	const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
	const where: string[] = [];
	const params: unknown[] = [];
	if (opts.recipe) {
		where.push('recipe = ?');
		params.push(opts.recipe);
	}
	if (opts.status) {
		where.push('status = ?');
		params.push(opts.status);
	}
	if (opts.project) {
		where.push('project = ?');
		params.push(opts.project);
	}
	const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
	return db()
		.prepare(
			`SELECT ${RUNS_COLS} FROM naseej_runs ${whereClause}
			 ORDER BY started_at DESC LIMIT ?`,
		)
		.all(...params, limit) as NaseejRunRow[];
}

export interface ListPublishesOptions {
	limit?: number;
	component?: string;
	status?: PublishStatus;
}

export function listPublishes(opts: ListPublishesOptions = {}): NaseejPublishRow[] {
	const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
	const where: string[] = [];
	const params: unknown[] = [];
	if (opts.component) {
		where.push('component = ?');
		params.push(opts.component);
	}
	if (opts.status) {
		where.push('status = ?');
		params.push(opts.status);
	}
	const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
	return db()
		.prepare(
			`SELECT ${PUBLISH_COLS} FROM naseej_publish_log ${whereClause}
			 ORDER BY published_at DESC LIMIT ?`,
		)
		.all(...params, limit) as NaseejPublishRow[];
}

/** Cheap aggregate for the falsifier check (ADR-021 § Falsifier). */
export function countRuns(): number {
	const row = db().prepare(`SELECT COUNT(*) AS n FROM naseej_runs`).get() as { n: number };
	return row.n;
}

/** Update an in-flight run's status (ADR-011 — used when a human/gate step
 *  enters pause and again when it resumes). Non-throwing per the audit-is-
 *  non-critical contract. */
export function updateRunStatus(runId: string, status: RunStatus): void {
	safe('updateRunStatus', () => {
		db()
			.prepare(`UPDATE naseej_runs SET status = ? WHERE run_id = ?`)
			.run(status, runId);
	});
}

/** Single-row lookup for ADR-018 SSE replay fallback. Returns null when
 *  the runId has no persisted row (run never started, or already pruned). */
export function getRunByRunId(runId: string): NaseejRunRow | null {
	const row = db()
		.prepare(`SELECT ${RUNS_COLS} FROM naseej_runs WHERE run_id = ? LIMIT 1`)
		.get(runId) as NaseejRunRow | undefined;
	return row ?? null;
}
