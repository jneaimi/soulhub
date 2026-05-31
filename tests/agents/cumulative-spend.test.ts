/** ADR-020 P3 — `cumulativeAdrSpend` + `resolveAdrBudget` unit tests.
 *
 *  P3 ships the per-ADR cumulative budget gate. Two pure pieces back the
 *  dispatcher refusal:
 *    - `cumulativeAdrSpend(subjectPath)` sums `cost_usd` of all terminal runs
 *      for one artifact (in-flight rows excluded — ADR-022 D3 already refuses
 *      concurrent dispatches so they can't double-count).
 *    - `resolveAdrBudget(subjectPath, getNote)` reads the optional
 *      `dispatch_budget_usd` cap from the ADR's own frontmatter; returns
 *      `undefined` when absent or non-positive (backward-compat: no gate).
 *
 *  Together: dispatcher refuses when `cumulative + agent.budget.max_usd >
 *  adrCap`. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { resolveAdrBudget } from '../../src/lib/agents/dispatch/resolve-adr-budget.ts';
import type { NoteRepoShape } from '../../src/lib/agents/dispatch/resolve-project-repo.ts';

// ── cumulativeAdrSpend ───────────────────────────────────────────────────────

/** Mirror of `cumulativeAdrSpend` from src/lib/agents/runs.ts, parameterised
 *  on a db instance. Keep in sync with the production fn — the `status !=
 *  'error'` exclusion is the #61 bug fix. */
function cumulativeAdrSpend(
	db: import('better-sqlite3').Database,
	subjectPath: string | undefined | null,
): number {
	if (!subjectPath) return 0;
	const row = db
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
		subject_path    TEXT
	)
`;

function insertTerminal(
	db: import('better-sqlite3').Database,
	runId: string,
	subjectPath: string,
	cost: number,
	status: string = 'success',
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO agent_runs
			(run_id, agent_id, backend, mode, task_spec, started_at, finished_at, status, cost_usd, subject_path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(runId, 'soul-hub-implementer', 'claude-pty', 'production', 'task', now - 5000, now, status, cost, subjectPath);
}

function insertRunning(
	db: import('better-sqlite3').Database,
	runId: string,
	subjectPath: string,
	cost: number,
): void {
	// In-flight row: cost_usd may be live-updating but finished_at IS NULL.
	db.prepare(
		`INSERT INTO agent_runs
			(run_id, agent_id, backend, mode, task_spec, started_at, status, cost_usd, subject_path)
		 VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
	).run(runId, 'soul-hub-implementer', 'claude-pty', 'production', 'task', Date.now(), cost, subjectPath);
}

describe('cumulativeAdrSpend', () => {
	test('no subjectPath → 0', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		assert.strictEqual(cumulativeAdrSpend(db, undefined), 0);
		assert.strictEqual(cumulativeAdrSpend(db, null), 0);
		assert.strictEqual(cumulativeAdrSpend(db, ''), 0);
	});

	test('no rows → 0', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		assert.strictEqual(
			cumulativeAdrSpend(db, 'projects/x/adr-001.md'),
			0,
		);
	});

	test('sums productive terminal statuses; excludes `error` (#61)', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/soul-hub-agents/adr-011-general-implementer.md';
		insertTerminal(db, 'r1', sp, 9.51, 'error'); // wasted — excluded
		insertTerminal(db, 'r2', sp, 11.24, 'success');
		insertTerminal(db, 'r3', sp, 3.26, 'goal_achieved');
		// 11.24 + 3.26 = 14.50 (error row excluded)
		assert.strictEqual(
			Math.round(cumulativeAdrSpend(db, sp) * 100) / 100,
			14.5,
		);
	});

	test('`error` runs excluded — bug-induced waste no longer counts (#61)', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-042.md';
		// Real-world shape: PTY exit 143, stall, and operator-cancelled mid-run
		// (the actual #60 trigger). $22.66 wasted; with the bug, this would
		// blow the operator's $25 cap before they even start a productive run.
		insertTerminal(db, 'r1', sp, 8.06, 'error'); // PTY exited 143
		insertTerminal(db, 'r2', sp, 5.08, 'error'); // PTY exited 143
		insertTerminal(db, 'r3', sp, 9.52, 'error'); // operator-cancelled
		assert.strictEqual(cumulativeAdrSpend(db, sp), 0);
	});

	test('budget-exceeded / cancelled / interrupted DO count — operator/budget choices', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-003.md';
		// These statuses represent explicit choices (the agent did real work,
		// the operator chose to pause/stop). Spend was the operator's call.
		insertTerminal(db, 'r1', sp, 5.0, 'budget-exceeded');
		insertTerminal(db, 'r2', sp, 3.0, 'cancelled');
		insertTerminal(db, 'r3', sp, 1.0, 'interrupted');
		assert.strictEqual(cumulativeAdrSpend(db, sp), 9.0);
	});

	test('mixed: productive + wasted = only productive counts', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-004.md';
		insertTerminal(db, 'r1', sp, 10.0, 'goal_achieved');
		insertTerminal(db, 'r2', sp, 5.0, 'error'); // bug
		insertTerminal(db, 'r3', sp, 2.0, 'budget-exceeded');
		// 10 + 2 = 12 (error excluded)
		assert.strictEqual(cumulativeAdrSpend(db, sp), 12.0);
	});

	test('in-flight rows (finished_at IS NULL) are excluded', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-002.md';
		insertTerminal(db, 'r1', sp, 5.0);
		// A concurrent run that hasn't terminated yet — ADR-022 D3 should
		// have refused it, but the sum query must not count it either.
		insertRunning(db, 'r2', sp, 2.0);
		assert.strictEqual(cumulativeAdrSpend(db, sp), 5.0);
	});

	test('subject_path isolation', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		insertTerminal(db, 'r1', 'projects/x/adr-001.md', 10);
		insertTerminal(db, 'r2', 'projects/x/adr-002.md', 7);
		assert.strictEqual(cumulativeAdrSpend(db, 'projects/x/adr-001.md'), 10);
		assert.strictEqual(cumulativeAdrSpend(db, 'projects/x/adr-002.md'), 7);
	});
});

// ── resolveAdrBudget ─────────────────────────────────────────────────────────

function mkGetNote(notes: Record<string, NoteRepoShape>): (p: string) => NoteRepoShape | undefined {
	return (p) => notes[p];
}

describe('resolveAdrBudget', () => {
	test('no subjectPath → undefined', () => {
		assert.strictEqual(resolveAdrBudget(undefined, () => undefined), undefined);
	});

	test('note not indexed → undefined', () => {
		assert.strictEqual(
			resolveAdrBudget('projects/x/adr-001.md', mkGetNote({})),
			undefined,
		);
	});

	test('no dispatch_budget_usd field → undefined (gate skipped)', () => {
		const notes = {
			'projects/x/adr-001.md': { meta: { type: 'decision', status: 'accepted' } },
		};
		assert.strictEqual(
			resolveAdrBudget('projects/x/adr-001.md', mkGetNote(notes)),
			undefined,
		);
	});

	test('positive number → returned as-is', () => {
		const notes = {
			'projects/x/adr-001.md': { meta: { dispatch_budget_usd: 25 } },
		};
		assert.strictEqual(
			resolveAdrBudget('projects/x/adr-001.md', mkGetNote(notes)),
			25,
		);
	});

	test('string-numeric value → coerced', () => {
		const notes = {
			'projects/x/adr-001.md': { meta: { dispatch_budget_usd: '15.5' } },
		};
		assert.strictEqual(
			resolveAdrBudget('projects/x/adr-001.md', mkGetNote(notes)),
			15.5,
		);
	});

	test('zero or negative → undefined (operator typo guard)', () => {
		const zero = { 'projects/x/adr-001.md': { meta: { dispatch_budget_usd: 0 } } };
		const negative = { 'projects/x/adr-001.md': { meta: { dispatch_budget_usd: -5 } } };
		assert.strictEqual(
			resolveAdrBudget('projects/x/adr-001.md', mkGetNote(zero)),
			undefined,
		);
		assert.strictEqual(
			resolveAdrBudget('projects/x/adr-001.md', mkGetNote(negative)),
			undefined,
		);
	});

	test('non-numeric junk → undefined', () => {
		const notes = {
			'projects/x/adr-001.md': { meta: { dispatch_budget_usd: 'tbd' } },
		};
		assert.strictEqual(
			resolveAdrBudget('projects/x/adr-001.md', mkGetNote(notes)),
			undefined,
		);
	});
});

// ── Gate-decision integration (compose the two pieces) ───────────────────────

describe('P3 gate decision (cumulative + max vs cap)', () => {
	test('under cap → proceed', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-001.md';
		insertTerminal(db, 'r1', sp, 9.51, 'error');
		const cumulative = cumulativeAdrSpend(db, sp);
		const thisRunMax = 3.0;
		const cap = 15;
		assert.ok(cumulative + thisRunMax <= cap, 'should proceed');
	});

	test('at cap exactly → proceed (strict > refuses, not >=)', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-001.md';
		insertTerminal(db, 'r1', sp, 10, 'success');
		const cumulative = cumulativeAdrSpend(db, sp);
		const thisRunMax = 5;
		const cap = 15;
		assert.ok(cumulative + thisRunMax <= cap, 'exact-cap proceeds');
	});

	test('cumulative alone exceeds cap → refuse', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-001.md';
		insertTerminal(db, 'r1', sp, 20, 'success');
		const cumulative = cumulativeAdrSpend(db, sp);
		const thisRunMax = 0.5;
		const cap = 15;
		assert.ok(cumulative + thisRunMax > cap, 'should refuse');
	});

	test('cumulative + this-run exceeds → refuse', () => {
		const db = new Database(':memory:');
		db.exec(SCHEMA);
		const sp = 'projects/x/adr-001.md';
		insertTerminal(db, 'r1', sp, 12, 'success');
		const cumulative = cumulativeAdrSpend(db, sp);
		const thisRunMax = 5;
		const cap = 15;
		assert.ok(cumulative + thisRunMax > cap, 'should refuse');
	});
});
