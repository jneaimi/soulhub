/** ADR-020 P1 — `derivePhase` unit tests.
 *
 *  Closes the dark-column gap surfaced 2026-05-29: `agent_runs.phase` was NULL
 *  for every dispatch except `bump-continue`. `derivePhase` is the fallback the
 *  dispatcher now calls when `opts.phase` is absent.
 *
 *  Covers:
 *    1. No subjectPath → null (non-artifact dispatches stay un-tagged).
 *    2. No prior runs → 'initial'.
 *    3. Prior success → 'follow-up' (post-ship continuation).
 *    4. Only prior failures → 'retry-N' where N = failure count + 1.
 *    5. Mix of failure + success → 'follow-up' (success precedence).
 *    6. In-flight rows (finished_at IS NULL) are ignored — they're the dispatch
 *       we're about to write, not history.
 *
 *  Mirrors the SQL logic in isolation (same pattern as run-progress.test.ts)
 *  because the production function uses the module-level `db()` singleton. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

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
		subject_path    TEXT,
		phase           TEXT
	)
`;

const SUCCESS_STATUSES = new Set(['success', 'goal_achieved']);
const FAILURE_STATUSES = new Set([
	'error',
	'timeout',
	'cancelled',
	'interrupted',
	'budget-exceeded',
]);

/** Mirror of `derivePhase` from src/lib/agents/runs.ts, parameterised on a
 *  db instance for test isolation. Keep in sync with the production fn. */
function derivePhase(
	db: import('better-sqlite3').Database,
	subjectPath: string | undefined | null,
): string | null {
	if (!subjectPath) return null;
	const priors = db
		.prepare(
			`SELECT status FROM agent_runs
			 WHERE subject_path = ? AND finished_at IS NOT NULL`,
		)
		.all(subjectPath) as Array<{ status: string }>;
	if (priors.length === 0) return 'initial';
	if (priors.some((p) => SUCCESS_STATUSES.has(p.status))) return 'follow-up';
	const failures = priors.filter((p) => FAILURE_STATUSES.has(p.status)).length;
	if (failures > 0) return `retry-${failures + 1}`;
	return 'initial';
}

function insertFinished(
	db: import('better-sqlite3').Database,
	runId: string,
	subjectPath: string,
	status: string,
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO agent_runs
			(run_id, agent_id, backend, mode, task_spec, started_at, finished_at, status, subject_path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(runId, 'soul-hub-implementer', 'claude-pty', 'production', 'task', now - 5000, now, status, subjectPath);
}

function insertRunning(
	db: import('better-sqlite3').Database,
	runId: string,
	subjectPath: string,
): void {
	db.prepare(
		`INSERT INTO agent_runs
			(run_id, agent_id, backend, mode, task_spec, started_at, status, subject_path)
		 VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
	).run(runId, 'soul-hub-implementer', 'claude-pty', 'production', 'task', Date.now(), subjectPath);
}

describe('derivePhase', () => {
	test('no subjectPath → null (non-artifact dispatch)', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		assert.strictEqual(derivePhase(db, undefined), null);
		assert.strictEqual(derivePhase(db, null), null);
		assert.strictEqual(derivePhase(db, ''), null);
	});

	test('no prior runs → initial', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		assert.strictEqual(
			derivePhase(db, 'projects/soul-hub-agents/adr-099-fresh.md'),
			'initial',
		);
	});

	test('prior success → follow-up', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/soul-hub-agents/adr-019-resilient-operator-pause-recovery.md';
		insertFinished(db, 'r1', sp, 'success');
		assert.strictEqual(derivePhase(db, sp), 'follow-up');
	});

	test('prior goal_achieved → follow-up', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/soul-hub-agents/adr-021-hard-ceiling.md';
		insertFinished(db, 'r1', sp, 'goal_achieved');
		assert.strictEqual(derivePhase(db, sp), 'follow-up');
	});

	test('only failures → retry-N', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/soul-hub-agents/adr-011-general-implementer.md';
		insertFinished(db, 'r1', sp, 'error');
		insertFinished(db, 'r2', sp, 'error');
		// 2 prior failures → next attempt is retry-3
		assert.strictEqual(derivePhase(db, sp), 'retry-3');
	});

	test('mixed failure statuses count toward retry-N', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-001.md';
		insertFinished(db, 'r1', sp, 'error');
		insertFinished(db, 'r2', sp, 'timeout');
		insertFinished(db, 'r3', sp, 'budget-exceeded');
		assert.strictEqual(derivePhase(db, sp), 'retry-4');
	});

	test('success precedence: failures then success → follow-up', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-001.md';
		insertFinished(db, 'r1', sp, 'error');
		insertFinished(db, 'r2', sp, 'success');
		assert.strictEqual(derivePhase(db, sp), 'follow-up');
	});

	test('in-flight rows (finished_at IS NULL) are ignored', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-002.md';
		// In-flight row should not be counted as a prior — it IS the run we're
		// about to write the phase for, or a concurrent run guarded by ADR-022 D3.
		insertRunning(db, 'r1', sp);
		assert.strictEqual(derivePhase(db, sp), 'initial');
	});

	test('subject_path isolation: other ADRs do not contaminate', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		insertFinished(db, 'r1', 'projects/x/adr-001.md', 'success');
		assert.strictEqual(
			derivePhase(db, 'projects/x/adr-002.md'),
			'initial',
		);
	});
});
