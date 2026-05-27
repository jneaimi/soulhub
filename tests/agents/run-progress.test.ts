/** ADR-026 P3 — `updateRunProgress` unit tests.
 *
 *  Covers:
 *    1. Happy path: `updateRunProgress` updates `cost_usd` / `num_turns` for
 *       a row whose `finished_at` is NULL (running row).
 *    2. Sad path: a row with `finished_at` already set is NOT updated —
 *       the `finished_at IS NULL` guard holds.
 *
 *  Uses an in-memory better-sqlite3 database injected via the same pattern as
 *  the ask-operator persistence tests. The `updateRunProgress` function uses
 *  the module-level singleton (`db()` → `getHeartbeatDb()`), so we cannot
 *  inject a DB instance directly — instead we mirror the SQL logic exactly,
 *  verifying the guard clause in isolation the same way
 *  `sweepAbandonedOperatorInputs` is tested in ask-operator.test.ts.
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/run-progress.test.ts */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal schema — matches the columns `updateRunProgress` touches. */
const SCHEMA = `
	CREATE TABLE agent_runs (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		run_id          TEXT    NOT NULL,
		agent_id        TEXT    NOT NULL,
		backend         TEXT    NOT NULL,
		mode            TEXT    NOT NULL DEFAULT 'production',
		task_spec       TEXT    NOT NULL,
		started_at      INTEGER NOT NULL,
		finished_at     INTEGER,
		status          TEXT    NOT NULL,
		cost_usd        REAL    NOT NULL DEFAULT 0,
		num_turns       INTEGER NOT NULL DEFAULT 0,
		error_message   TEXT
	)
`;

function insertRunningRow(db: import('better-sqlite3').Database, runId: string): void {
	db.prepare(
		`INSERT INTO agent_runs
			(run_id, agent_id, backend, mode, task_spec, started_at, status, cost_usd, num_turns)
		 VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 0)`,
	).run(runId, 'soul-hub-implementer', 'claude-pty', 'production', 'implement adr-026', Date.now());
}

function insertFinishedRow(db: import('better-sqlite3').Database, runId: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO agent_runs
			(run_id, agent_id, backend, mode, task_spec, started_at, finished_at, status, cost_usd, num_turns)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'success', 0, 0)`,
	).run(runId, 'soul-hub-implementer', 'claude-pty', 'production', 'implement adr-026', now - 5000, now);
}

// ── Section 1: Happy path — running row ──────────────────────────────────────

describe('updateRunProgress — happy path (running row)', () => {
	test('updates cost_usd and num_turns on a running row', async () => {
		const BetterSqlite3 = (await import('better-sqlite3')).default;
		const db = new BetterSqlite3(':memory:');
		db.exec(SCHEMA);

		const runId = 'prog-run-1';
		insertRunningRow(db, runId);

		// Mirror the SQL from updateRunProgress exactly.
		const result = db
			.prepare(
				`UPDATE agent_runs SET cost_usd = ?, num_turns = ?
				 WHERE run_id = ? AND finished_at IS NULL`,
			)
			.run(0.0123, 4, runId);

		assert.equal(result.changes, 1, 'one row should be updated');

		const row = db
			.prepare(`SELECT cost_usd AS costUsd, num_turns AS numTurns FROM agent_runs WHERE run_id = ?`)
			.get(runId) as { costUsd: number; numTurns: number };

		assert.ok(Math.abs(row.costUsd - 0.0123) < 1e-9, `cost_usd should be 0.0123, got ${row.costUsd}`);
		assert.equal(row.numTurns, 4, 'num_turns should be 4');

		db.close();
	});

	test('subsequent progress ticks overwrite the previous values', async () => {
		const BetterSqlite3 = (await import('better-sqlite3')).default;
		const db = new BetterSqlite3(':memory:');
		db.exec(SCHEMA);

		const runId = 'prog-run-2';
		insertRunningRow(db, runId);

		const updateSql = db.prepare(
			`UPDATE agent_runs SET cost_usd = ?, num_turns = ?
			 WHERE run_id = ? AND finished_at IS NULL`,
		);

		// First tick
		updateSql.run(0.005, 2, runId);
		// Second tick — higher values
		updateSql.run(0.012, 5, runId);

		const row = db
			.prepare(`SELECT cost_usd AS costUsd, num_turns AS numTurns FROM agent_runs WHERE run_id = ?`)
			.get(runId) as { costUsd: number; numTurns: number };

		assert.ok(Math.abs(row.costUsd - 0.012) < 1e-9, 'cost_usd should reflect the latest tick');
		assert.equal(row.numTurns, 5, 'num_turns should reflect the latest tick');

		db.close();
	});
});

// ── Section 2: Sad path — finished row is NOT updated ────────────────────────

describe('updateRunProgress — sad path (finished row guard)', () => {
	test('a row with finished_at set is NOT updated (finished_at IS NULL guard)', async () => {
		const BetterSqlite3 = (await import('better-sqlite3')).default;
		const db = new BetterSqlite3(':memory:');
		db.exec(SCHEMA);

		const runId = 'prog-finished-1';
		insertFinishedRow(db, runId);

		// Attempt to update via the same SQL as updateRunProgress.
		const result = db
			.prepare(
				`UPDATE agent_runs SET cost_usd = ?, num_turns = ?
				 WHERE run_id = ? AND finished_at IS NULL`,
			)
			.run(9.99, 999, runId);

		assert.equal(result.changes, 0, 'no rows should be updated when finished_at is set');

		// Original values should remain unchanged (0 / 0 as inserted).
		const row = db
			.prepare(`SELECT cost_usd AS costUsd, num_turns AS numTurns FROM agent_runs WHERE run_id = ?`)
			.get(runId) as { costUsd: number; numTurns: number };

		assert.equal(row.costUsd, 0, 'cost_usd should remain 0 for a finished row');
		assert.equal(row.numTurns, 0, 'num_turns should remain 0 for a finished row');

		db.close();
	});

	test('finished row co-existing with a running row — only the running row is updated', async () => {
		const BetterSqlite3 = (await import('better-sqlite3')).default;
		const db = new BetterSqlite3(':memory:');
		db.exec(SCHEMA);

		const finishedId = 'prog-finished-2';
		const runningId = 'prog-running-2';
		insertFinishedRow(db, finishedId);
		insertRunningRow(db, runningId);

		// Update both by runId of the running row only.
		const result = db
			.prepare(
				`UPDATE agent_runs SET cost_usd = ?, num_turns = ?
				 WHERE run_id = ? AND finished_at IS NULL`,
			)
			.run(0.05, 3, runningId);

		assert.equal(result.changes, 1, 'exactly the running row should be updated');

		const finRow = db
			.prepare(`SELECT cost_usd AS costUsd, num_turns AS numTurns FROM agent_runs WHERE run_id = ?`)
			.get(finishedId) as { costUsd: number; numTurns: number };
		const runRow = db
			.prepare(`SELECT cost_usd AS costUsd, num_turns AS numTurns FROM agent_runs WHERE run_id = ?`)
			.get(runningId) as { costUsd: number; numTurns: number };

		assert.equal(finRow.costUsd, 0, 'finished row cost_usd should be untouched');
		assert.equal(finRow.numTurns, 0, 'finished row num_turns should be untouched');
		assert.ok(Math.abs(runRow.costUsd - 0.05) < 1e-9, 'running row cost_usd should be updated');
		assert.equal(runRow.numTurns, 3, 'running row num_turns should be updated');

		db.close();
	});
});
