/**
 * projects-graph ADR-026 — in-flight progress on the Workbench.
 *
 * Two suites:
 *
 *   1. `listRunningRuns` — DB-backed function that returns a Map of
 *      subject_path → RunningRunTelemetry for unfinished agent runs.
 *      Uses an in-memory better-sqlite3 DB (via the `_overrideDb` param
 *      added for testability) so the live ops.db stays untouched.
 *
 *   2. `computeLaneAndProgress` — pure helper in $lib/projects/worklist-lane.ts.
 *      Decides lane + progress given an item path, owner, blockers, and the
 *      running-runs Map.  No DB, no vault engine, no SvelteKit.
 *
 * Run via:
 *   node --import ./tests/vault-hygiene/register.mjs \
 *        --test --experimental-strip-types \
 *        tests/vault-hygiene/worklist-inflight-progress.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal agent_runs schema — only the columns listRunningRuns touches. */
function createTestDb(): Database.Database {
	const db = new Database(':memory:');
	db.exec(`
		CREATE TABLE agent_runs (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id          TEXT    NOT NULL,
			agent_id        TEXT    NOT NULL DEFAULT 'test-agent',
			backend         TEXT    NOT NULL DEFAULT 'claude-pty',
			mode            TEXT    NOT NULL DEFAULT 'production',
			task_spec       TEXT    NOT NULL DEFAULT 'test',
			started_at      INTEGER NOT NULL,
			finished_at     INTEGER,
			status          TEXT    NOT NULL,
			cost_usd        REAL    NOT NULL DEFAULT 0,
			num_turns       INTEGER NOT NULL DEFAULT 0,
			subject_path    TEXT
		)
	`);
	return db;
}

type InsertRow = {
	runId: string;
	startedAt: number;
	finishedAt?: number | null;
	status: string;
	costUsd: number;
	numTurns: number;
	subjectPath?: string | null;
};

function insertRow(db: Database.Database, r: InsertRow): void {
	db.prepare(`
		INSERT INTO agent_runs
			(run_id, started_at, finished_at, status, cost_usd, num_turns, subject_path)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(r.runId, r.startedAt, r.finishedAt ?? null, r.status, r.costUsd, r.numTurns, r.subjectPath ?? null);
}

// ── Suite 1: listRunningRuns ──────────────────────────────────────────────────

describe('listRunningRuns', () => {
	let db: Database.Database;

	before(() => {
		db = createTestDb();
	});

	after(() => {
		db.close();
	});

	test('returns empty map when no running rows exist', async () => {
		const { listRunningRuns } = await import('$lib/agents/runs.ts');
		const result = listRunningRuns(db);
		assert.equal(result.size, 0);
	});

	test('returns running row keyed by subject_path with telemetry', async () => {
		const { listRunningRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		insertRow(db, {
			runId: 'run-001',
			startedAt: now - 120_000,
			finishedAt: null,
			status: 'running',
			costUsd: 0.15,
			numTurns: 8,
			subjectPath: 'projects/foo/adr-001.md',
		});

		const result = listRunningRuns(db);
		assert.equal(result.size, 1, 'should have 1 running item');

		const telemetry = result.get('projects/foo/adr-001.md');
		assert.ok(telemetry, 'telemetry keyed by subject_path');
		assert.equal(telemetry.numTurns, 8);
		assert.ok(Math.abs(telemetry.costUsd - 0.15) < 0.001, `costUsd mismatch: ${telemetry.costUsd}`);
		assert.equal(telemetry.startedAt, now - 120_000);
		assert.equal(telemetry.status, 'running');
	});

	test('excludes finished rows (finished_at IS NOT NULL)', async () => {
		const { listRunningRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		insertRow(db, {
			runId: 'run-002',
			startedAt: now - 60_000,
			finishedAt: now - 10_000, // finished!
			status: 'success',
			costUsd: 0.20,
			numTurns: 12,
			subjectPath: 'projects/bar/adr-002.md',
		});

		const result = listRunningRuns(db);
		// 'projects/foo/adr-001.md' from previous test is still running.
		// 'projects/bar/adr-002.md' is finished → must not appear.
		assert.ok(!result.has('projects/bar/adr-002.md'), 'finished run must be excluded');
		assert.ok(result.has('projects/foo/adr-001.md'), 'running run still present');
	});

	test('excludes rows with null subject_path', async () => {
		const { listRunningRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		insertRow(db, {
			runId: 'run-003',
			startedAt: now - 30_000,
			finishedAt: null,
			status: 'running',
			costUsd: 0.05,
			numTurns: 2,
			subjectPath: null, // orchestrator dispatch — no artifact
		});

		const result = listRunningRuns(db);
		// None of the map keys should be null / undefined.
		for (const key of result.keys()) {
			assert.ok(key != null && key.length > 0, `key must be non-empty, got: ${key}`);
		}
	});

	test('keeps most-recently-started row when multiple runs share a subject_path', async () => {
		const { listRunningRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		// Older crashed row (still unfinished — orphan sweep hasn't run yet).
		insertRow(db, {
			runId: 'run-004-old',
			startedAt: now - 600_000, // 10 min ago
			finishedAt: null,
			status: 'running',
			costUsd: 0.01,
			numTurns: 1,
			subjectPath: 'projects/baz/adr-003.md',
		});
		// Fresher replacement dispatch.
		insertRow(db, {
			runId: 'run-004-new',
			startedAt: now - 60_000, // 1 min ago
			finishedAt: null,
			status: 'running',
			costUsd: 0.07,
			numTurns: 4,
			subjectPath: 'projects/baz/adr-003.md',
		});

		const result = listRunningRuns(db);
		const telemetry = result.get('projects/baz/adr-003.md');
		assert.ok(telemetry, 'subject_path should be present');
		// Must be the NEWER row.
		assert.equal(telemetry.numTurns, 4, 'most-recently-started row wins');
		assert.ok(Math.abs(telemetry.costUsd - 0.07) < 0.001);
	});
});

// ── Suite 2: computeLaneAndProgress (pure helper) ─────────────────────────────

describe('computeLaneAndProgress', () => {
	test('in_flight + progress when subject_path is in running map', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const now = Date.now();
		const runningRuns = new Map([
			[
				'projects/foo/adr-001.md',
				{ costUsd: 0.22, numTurns: 10, startedAt: now - 300_000 },
			],
		]);

		const result = computeLaneAndProgress(
			'projects/foo/adr-001.md',
			'ai',
			[], // no unmet blockers
			runningRuns,
		);

		assert.equal(result.lane, 'in_flight');
		assert.ok(result.progress, 'progress should be present');
		assert.equal(result.progress.numTurns, 10);
		assert.ok(Math.abs(result.progress.costUsd - 0.22) < 0.001);
		assert.equal(result.progress.startedAt, now - 300_000);
	});

	test('ready_for_ai when AI-owned, no blockers, not in_flight', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress('projects/foo/adr-002.md', 'ai', [], new Map());
		assert.equal(result.lane, 'ready_for_ai');
		assert.equal(result.progress, undefined);
	});

	test('waiting_on_you when AI-owned but has unmet blockers', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress(
			'projects/foo/adr-003.md',
			'ai',
			['adr-001-blocker'],
			new Map(),
		);
		assert.equal(result.lane, 'waiting_on_you');
		assert.equal(result.progress, undefined);
	});

	test('ready_for_you when human-owned, no blockers, not in_flight', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress('projects/foo/adr-004.md', 'human', [], new Map());
		assert.equal(result.lane, 'ready_for_you');
	});

	test('waiting_on_ai when human-owned with unmet blockers', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress(
			'projects/foo/adr-005.md',
			'human',
			['adr-002-blocker'],
			new Map(),
		);
		assert.equal(result.lane, 'waiting_on_ai');
	});

	test('in_flight overrides blockers — running artifact bypasses blocked state', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const runningRuns = new Map([
			['projects/foo/adr-006.md', { costUsd: 0.1, numTurns: 5, startedAt: Date.now() }],
		]);

		// Even with unmet blockers, in_flight wins.
		const result = computeLaneAndProgress(
			'projects/foo/adr-006.md',
			'human',
			['some-blocker'],
			runningRuns,
		);
		assert.equal(result.lane, 'in_flight', 'in_flight overrides blocked state');
		assert.ok(result.progress, 'progress populated');
	});

	test('unassigned owner maps to ready_for_you when unblocked', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress('projects/foo/adr-007.md', 'unassigned', [], new Map());
		// unassigned is treated as non-ai → ready_for_you
		assert.equal(result.lane, 'ready_for_you');
	});
});
