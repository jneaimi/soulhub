/** ADR-026 P2 — ask-operator sentinel + persistence unit tests.
 *
 *  Covers:
 *    1. parseAskOperator — happy path: clean marker and ANSI-escaped / chunk-
 *       straddled input both yield the question string.
 *    2. parseAskOperator — sad path: prose mentions, malformed JSON, partial
 *       markers all return null without throwing.
 *    3. Persistence round-trip: an `awaiting-operator-input` run inserted with
 *       `OPERATOR_QUESTION: <q>` in error_message is retrieved by
 *       `listAwaitingOperatorInput` and carries the question.
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/ask-operator.test.ts */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Section 1: parseAskOperator — happy paths ──────────────────────────────

describe('parseAskOperator — happy paths', () => {
	test('extracts question from a clean marker', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const text =
			'Some preamble\n<<<ASK_OPERATOR>>>{"question":"Which branch should I target?"} <<<END_ASK_OPERATOR>>>\n rest';
		assert.equal(parseAskOperator(text), 'Which branch should I target?');
	});

	test('extracts question when ANSI escape codes surround the marker', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		// Simulate what stripAnsi(combined) looks like — the ANSI codes are already
		// stripped before parseAskOperator is called in production. We verify the
		// regex still works on a stripped version with realistic surrounding noise.
		const ansiStripped =
			'output\x1b[0m<<<ASK_OPERATOR>>>{"question":"Should I overwrite foo.md?"} <<<END_ASK_OPERATOR>>>\x1b[0m';
		// stripAnsi removes escape sequences — simulate it:
		const stripped = ansiStripped.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
		assert.equal(parseAskOperator(stripped), 'Should I overwrite foo.md?');
	});

	test('extracts question from concatenated chunks (sentinel straddles chunks)', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		// The accumulator is the combination of all chunks — simulate two chunks
		// joined together where the sentinel spans the join.
		const chunk1 = 'Some output <<<ASK_OPERA';
		const chunk2 = 'TOR>>>{"question":"Proceed?"}<<<END_ASK_OPERATOR>>>';
		const combined = chunk1 + chunk2;
		assert.equal(parseAskOperator(combined), 'Proceed?');
	});

	test('handles whitespace between marker and JSON', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const text = '<<<ASK_OPERATOR>>>   \n  {"question":"Multi-line spacing ok?"}  \n<<<END_ASK_OPERATOR>>>';
		assert.equal(parseAskOperator(text), 'Multi-line spacing ok?');
	});
});

// ── Section 2: parseAskOperator — sad paths ────────────────────────────────

describe('parseAskOperator — sad paths', () => {
	test('prose mentioning ask_operator does NOT match', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const prose =
			'I could use ask_operator here but instead I will just proceed with the default.';
		assert.equal(parseAskOperator(prose), null);
	});

	test('partial start marker with no end does NOT match', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const partial = '<<<ASK_OPERATOR>>>{"question":"incomplete..."}';
		assert.equal(parseAskOperator(partial), null);
	});

	test('malformed JSON inside the marker returns null without throwing', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const bad = '<<<ASK_OPERATOR>>>{not valid json}<<<END_ASK_OPERATOR>>>';
		assert.equal(parseAskOperator(bad), null);
	});

	test('valid JSON but missing .question field returns null', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const noQ = '<<<ASK_OPERATOR>>>{"answer":"42"}<<<END_ASK_OPERATOR>>>';
		assert.equal(parseAskOperator(noQ), null);
	});

	test('.question is not a string returns null', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const wrongType = '<<<ASK_OPERATOR>>>{"question":123}<<<END_ASK_OPERATOR>>>';
		assert.equal(parseAskOperator(wrongType), null);
	});

	test('empty string returns null', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		assert.equal(parseAskOperator(''), null);
	});

	test('blank question (whitespace only) returns null', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const blank = '<<<ASK_OPERATOR>>>{"question":"   "}<<<END_ASK_OPERATOR>>>';
		assert.equal(parseAskOperator(blank), null);
	});
});

// ── Section 2b: prompt-echo guard (ADR-026 P2 fix, found live 2026-05-26) ──

describe('parseAskOperator — prompt-echo guard', () => {
	test('sentinel that is part of the echoed task is IGNORED', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		// The injected task instructed the agent how to ask, embedding the
		// literal marker. That task echoes into the PTY accumulator. With the
		// task passed as promptEcho, the echo must NOT trigger a pause.
		const task =
			'When blocked, emit <<<ASK_OPERATOR>>>{"question":"<your one concise question>"}<<<END_ASK_OPERATOR>>> and stop.';
		const echoedOutput = `...terminal echo... ${task} ...more scrollback...`;
		assert.equal(parseAskOperator(echoedOutput, task), null);
	});

	test('a genuine agent question is NOT in the task, so it still matches', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const task = 'Add a priority badge to the Work-board cards.';
		const agentOutput =
			'<<<ASK_OPERATOR>>>{"question":"What priority levels and colors do you want?"}<<<END_ASK_OPERATOR>>>';
		assert.equal(
			parseAskOperator(agentOutput, task),
			'What priority levels and colors do you want?',
		);
	});

	test('guard is whitespace/line-wrap tolerant', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		// The terminal wraps the echoed question across lines; normalization
		// must still recognize it as the echoed task and ignore it.
		const task = 'Ask: <<<ASK_OPERATOR>>>{"question":"Which database should I migrate first and why"}<<<END_ASK_OPERATOR>>>';
		const wrapped =
			'<<<ASK_OPERATOR>>>{"question":"Which database should I\n   migrate first and why"}<<<END_ASK_OPERATOR>>>';
		assert.equal(parseAskOperator(wrapped, task), null);
	});

	test('no promptEcho passed → backward-compatible (matches)', async () => {
		const { parseAskOperator } = await import(
			'../../src/lib/agents/dispatch/ask-operator.ts'
		);
		const out = '<<<ASK_OPERATOR>>>{"question":"Proceed?"}<<<END_ASK_OPERATOR>>>';
		assert.equal(parseAskOperator(out), 'Proceed?');
	});
});

// ── Section 3: persistence round-trip ─────────────────────────────────────

describe('listAwaitingOperatorInput — persistence round-trip', () => {
	test('run inserted with awaiting-operator-input status is returned with question', async () => {
		// Dynamic import after loader registration (avoids static import of
		// better-sqlite3 before the module graph is resolved).
		const BetterSqlite3 = (await import('better-sqlite3')).default;
		const { listAwaitingOperatorInput } = await import('../../src/lib/agents/runs.ts');

		const testDb = new BetterSqlite3(':memory:');
		testDb.exec(`
			CREATE TABLE agent_runs (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id          TEXT    NOT NULL,
				agent_id        TEXT    NOT NULL,
				backend         TEXT    NOT NULL,
				model           TEXT,
				provider        TEXT,
				mode            TEXT    NOT NULL DEFAULT 'production',
				task_spec       TEXT    NOT NULL,
				source_message  TEXT,
				jid             TEXT,
				started_at      INTEGER NOT NULL,
				finished_at     INTEGER,
				duration_ms     INTEGER,
				status          TEXT    NOT NULL,
				cost_usd        REAL    NOT NULL DEFAULT 0,
				num_turns       INTEGER NOT NULL DEFAULT 0,
				result_excerpt  TEXT,
				error_message   TEXT,
				claude_session_id TEXT,
				subject_path    TEXT,
				handback        TEXT
			)
		`);

		const question = 'Should I overwrite the existing output file?';
		const now = Date.now();

		// Insert a paused run the way dispatch/claude-pty produces it:
		// error_message = 'OPERATOR_QUESTION: <question>'
		testDb.prepare(`
			INSERT INTO agent_runs
				(run_id, agent_id, backend, mode, task_spec, started_at,
				 finished_at, duration_ms, status, cost_usd, num_turns, error_message)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			'abc12345', 'soul-hub-implementer', 'claude-pty', 'production',
			'implement adr-026', now, now + 5000, 5000,
			'awaiting-operator-input', 0.015, 3,
			`OPERATOR_QUESTION: ${question}`,
		);

		// Insert a budget-paused run that should NOT appear.
		testDb.prepare(`
			INSERT INTO agent_runs
				(run_id, agent_id, backend, mode, task_spec, started_at,
				 finished_at, duration_ms, status, cost_usd, num_turns)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			'def67890', 'researcher', 'claude-pty', 'production',
			'research task', now - 1000, now + 4000, 5000,
			'awaiting-budget-approval', 0.08, 5,
		);

		const rows = listAwaitingOperatorInput(testDb);

		assert.equal(rows.length, 1, 'should return exactly the awaiting-operator-input run');
		assert.equal(rows[0].runId, 'abc12345');
		assert.equal(rows[0].status, 'awaiting-operator-input');
		assert.ok(
			rows[0].errorMessage?.startsWith('OPERATOR_QUESTION: '),
			'errorMessage should carry the OPERATOR_QUESTION prefix',
		);
		assert.ok(
			rows[0].errorMessage?.includes(question),
			'errorMessage should contain the original question',
		);

		testDb.close();
	});

	test('sweepAbandonedOperatorInputs flips stale rows to timeout', async () => {
		const BetterSqlite3 = (await import('better-sqlite3')).default;
		// We cannot inject a DB into sweepAbandonedOperatorInputs (it uses the module
		// singleton). Instead verify the SQL logic by running equivalent statements
		// directly in an in-memory DB, mirroring what the function does.
		const testDb = new BetterSqlite3(':memory:');
		testDb.exec(`
			CREATE TABLE agent_runs (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id          TEXT    NOT NULL,
				agent_id        TEXT    NOT NULL,
				backend         TEXT    NOT NULL,
				mode            TEXT    NOT NULL DEFAULT 'production',
				task_spec       TEXT    NOT NULL,
				started_at      INTEGER NOT NULL,
				status          TEXT    NOT NULL,
				cost_usd        REAL    NOT NULL DEFAULT 0,
				num_turns       INTEGER NOT NULL DEFAULT 0,
				error_message   TEXT
			)
		`);

		const staleAt = Date.now() - 7 * 60 * 60 * 1000; // 7 hours ago
		const freshAt = Date.now() - 1 * 60 * 60 * 1000; // 1 hour ago

		testDb.prepare(
			`INSERT INTO agent_runs (run_id, agent_id, backend, mode, task_spec, started_at, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('stale1', 'agent', 'claude-pty', 'production', 'task', staleAt, 'awaiting-operator-input');

		testDb.prepare(
			`INSERT INTO agent_runs (run_id, agent_id, backend, mode, task_spec, started_at, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run('fresh1', 'agent', 'claude-pty', 'production', 'task', freshAt, 'awaiting-operator-input');

		// Mirror the sweep SQL from sweepAbandonedOperatorInputs
		const maxAgeMs = 6 * 60 * 60 * 1000;
		const cutoff = Date.now() - maxAgeMs;
		const result = testDb.prepare(
			`UPDATE agent_runs SET
				status = 'timeout',
				error_message = 'operator input not provided within the window'
			WHERE status = 'awaiting-operator-input' AND started_at < ?`
		).run(cutoff);

		assert.equal(result.changes, 1, 'only the stale row should be swept');

		const swept = testDb.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get('stale1') as { status: string };
		assert.equal(swept.status, 'timeout', 'stale row should be flipped to timeout');

		const alive = testDb.prepare(`SELECT status FROM agent_runs WHERE run_id = ?`).get('fresh1') as { status: string };
		assert.equal(alive.status, 'awaiting-operator-input', 'fresh row should remain unchanged');

		testDb.close();
	});
});
