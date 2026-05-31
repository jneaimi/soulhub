/**
 * projects-graph ADR-026 D3 — review hand-off card for finished, un-merged
 * coding dispatches.
 *
 * Suites:
 *
 *   1. `parseHandBack` — extracts the hand-back JSON from a result_excerpt:
 *      - valid fenced ```json``` block → HandBack returned
 *      - no JSON → null (no throw)
 *      - malformed / truncated JSON → null (no throw)
 *      - bare trailing JSON object (no fence) → HandBack returned
 *      - missing required fields → null
 *
 *   2. `isGatesGreen` — gate derivation:
 *      - all pass + check + build → true
 *      - one gate fail → false
 *      - check_passed false → false
 *      - build_passed false → false
 *      - empty gate_results + both passed → true
 *
 *   3. `computeLaneAndProgress` with reviewHandoff:
 *      - reviewHandoff present → waiting_on_you + payload carried
 *      - reviewHandoff + unmet blockers → still waiting_on_you + payload
 *      - in_flight beats reviewHandoff (priority 1 > 3)
 *      - awaitingOperator beats reviewHandoff (priority 2 > 3)
 *      - reviewHandoff beats plain blocked (priority 3 > 5)
 *
 *   4. `listReviewableRuns` — DB-backed function:
 *      - empty when no successful finished rows
 *      - returns run for goal_achieved + finished_at
 *      - returns run for success + finished_at
 *      - excludes runs with null subject_path
 *      - excludes running rows (finished_at IS NULL)
 *      - excludes failed/interrupted/timeout rows
 *      - keeps newest per subject_path
 *
 * Run via:
 *   node --import ./tests/vault-hygiene/register.mjs \
 *        --test --experimental-strip-types \
 *        tests/vault-hygiene/worklist-review-handback.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ── Suite 1: parseHandBack ────────────────────────────────────────────────────

describe('parseHandBack', () => {
	const validHandBack = {
		branch: 'orchestration/run-1716000000000/adr-026-impl',
		commits: ['abc123 feat: implement review hand-off'],
		files_changed: ['src/lib/agents/handback.ts'],
		check_passed: true,
		build_passed: true,
		gate_results: { typecheck_gate: 'pass', no_owner_domain: 'pass', cli_tsc: 'pass' },
		summary: 'Implemented ADR-026 D3 review hand-off lane.',
		follow_ups: ['Wire up Telegram notification on review-ready'],
	};

	test('valid fenced json block → HandBack returned', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');

		const excerpt = `Some agent output.\n\n\`\`\`json\n${JSON.stringify(validHandBack)}\n\`\`\``;
		const result = parseHandBack(excerpt);

		assert.ok(result, 'should return a HandBack');
		assert.equal(result.branch, validHandBack.branch);
		assert.equal(result.summary, validHandBack.summary);
		assert.deepEqual(result.follow_ups, validHandBack.follow_ups);
		assert.equal(result.check_passed, true);
		assert.equal(result.build_passed, true);
	});

	test('null input → null (no throw)', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const result = parseHandBack(null);
		assert.equal(result, null, 'null input should return null');
	});

	test('empty string → null', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const result = parseHandBack('');
		assert.equal(result, null);
	});

	test('no JSON in text → null (no throw)', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const result = parseHandBack('Just a plain text excerpt with no JSON at all.');
		assert.equal(result, null);
	});

	test('malformed JSON in fence → null (no throw)', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const excerpt = '```json\n{ "branch": "foo", "check_passed": true, MALFORMED\n```';
		assert.doesNotThrow(() => parseHandBack(excerpt));
		const result = parseHandBack(excerpt);
		assert.equal(result, null);
	});

	test('truncated JSON (no closing brace) → null (no throw)', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const excerpt = '```json\n{"branch":"foo","check_passed":true,"build_passed":true,"summary":"Impl';
		assert.doesNotThrow(() => parseHandBack(excerpt));
		const result = parseHandBack(excerpt);
		assert.equal(result, null);
	});

	test('bare trailing JSON object (no fence) → HandBack returned', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const excerpt = `Some preamble text.\n\n${JSON.stringify(validHandBack)}`;
		const result = parseHandBack(excerpt);
		assert.ok(result, 'should parse bare trailing JSON object');
		assert.equal(result.branch, validHandBack.branch);
	});

	test('JSON missing required field `branch` → null', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const bad = { ...validHandBack };
		delete (bad as Partial<typeof bad>).branch;
		const excerpt = `\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``;
		const result = parseHandBack(excerpt);
		assert.equal(result, null, 'missing branch → null');
	});

	test('JSON missing required field `summary` → null', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const bad = { ...validHandBack };
		delete (bad as Partial<typeof bad>).summary;
		const excerpt = `\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``;
		const result = parseHandBack(excerpt);
		assert.equal(result, null, 'missing summary → null');
	});

	test('follow_ups absent → HandBack still returned (optional field)', async () => {
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const minimal = {
			branch: 'orchestration/run-111/my-task',
			commits: [],
			files_changed: [],
			check_passed: false,
			build_passed: false,
			gate_results: {},
			summary: 'Minimal hand-back.',
		};
		const excerpt = `\`\`\`json\n${JSON.stringify(minimal)}\n\`\`\``;
		const result = parseHandBack(excerpt);
		assert.ok(result, 'should return HandBack even without follow_ups');
		assert.equal(result.branch, minimal.branch);
	});
});

// ── Suite 2: isGatesGreen ─────────────────────────────────────────────────────

describe('isGatesGreen', () => {
	async function make(
		overrides: Partial<{
			check_passed: boolean;
			build_passed: boolean;
			gate_results: Record<string, string>;
		}>,
	) {
		const { isGatesGreen } = await import('$lib/agents/handback.ts');
		const hb = {
			branch: 'b',
			commits: [],
			files_changed: [],
			check_passed: true,
			build_passed: true,
			gate_results: { typecheck_gate: 'pass' },
			summary: 's',
			follow_ups: [],
			...overrides,
		};
		return isGatesGreen(hb);
	}

	test('all pass + check + build → true', async () => {
		const green = await make({
			gate_results: { typecheck_gate: 'pass', no_owner_domain: 'pass', cli_tsc: 'pass' },
		});
		assert.equal(green, true);
	});

	test('one gate fail → false', async () => {
		const green = await make({
			gate_results: { typecheck_gate: 'pass', no_owner_domain: 'fail' },
		});
		assert.equal(green, false);
	});

	test('check_passed false → false', async () => {
		const green = await make({ check_passed: false });
		assert.equal(green, false);
	});

	test('build_passed false → false', async () => {
		const green = await make({ build_passed: false });
		assert.equal(green, false);
	});

	test('empty gate_results + both booleans true → true', async () => {
		const green = await make({ gate_results: {} });
		assert.equal(green, true);
	});
});

// ── Suite 3: computeLaneAndProgress with reviewHandoff ────────────────────────

describe('computeLaneAndProgress — reviewHandoff', () => {
	const reviewPayload = {
		branch: 'orchestration/run-1716000000000/adr-026-impl',
		summary: 'Implemented ADR-026 D3.',
		followUps: ['Wire Telegram notification'],
		gatesGreen: true,
		costUsd: 0.42,
	};

	test('reviewHandoff present → waiting_on_you + payload carried', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress(
			'projects/soul-hub/adr-026.md',
			'ai',
			[], // no blockers
			new Map(), // not running
			undefined, // no awaitingOperator
			reviewPayload,
		);

		assert.equal(result.lane, 'waiting_on_you');
		assert.ok(result.reviewHandoff, 'reviewHandoff payload must be present');
		assert.equal(result.reviewHandoff.branch, reviewPayload.branch);
		assert.equal(result.reviewHandoff.summary, reviewPayload.summary);
		assert.deepEqual(result.reviewHandoff.followUps, reviewPayload.followUps);
		assert.equal(result.reviewHandoff.gatesGreen, true);
		assert.ok(Math.abs(result.reviewHandoff.costUsd - 0.42) < 0.001);
		assert.equal(result.awaitingOperator, undefined, 'no awaitingOperator when reviewHandoff');
		assert.equal(result.progress, undefined);
	});

	test('reviewHandoff + unmet blockers → still waiting_on_you + payload (priority 3 > 5)', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress(
			'projects/soul-hub/adr-026.md',
			'ai',
			['adr-025-blocker'], // has unmet blocker — would be waiting_on_you without payload
			new Map(),
			undefined,
			reviewPayload,
		);

		assert.equal(result.lane, 'waiting_on_you');
		assert.ok(result.reviewHandoff, 'payload still carried even with blockers');
	});

	test('in_flight beats reviewHandoff (priority 1 > 3)', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const now = Date.now();
		const runningRuns = new Map([
			['projects/soul-hub/adr-026.md', { costUsd: 0.15, numTurns: 5, startedAt: now - 120_000 }],
		]);

		const result = computeLaneAndProgress(
			'projects/soul-hub/adr-026.md',
			'ai',
			[],
			runningRuns,
			undefined,
			reviewPayload,
		);

		assert.equal(result.lane, 'in_flight', 'in_flight beats reviewHandoff');
		assert.ok(result.progress, 'progress present');
		assert.equal(result.reviewHandoff, undefined, 'reviewHandoff absent when in_flight');
	});

	test('awaitingOperator beats reviewHandoff (priority 2 > 3)', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const awaitingPayload = {
			question: 'Which target env?',
			sessionId: 'sess-abc',
			branch: 'orchestration/run-999/my-task',
			agentId: 'soul-hub-implementer',
			runId: 'run-test-review',
		};

		const result = computeLaneAndProgress(
			'projects/soul-hub/adr-026.md',
			'ai',
			[],
			new Map(),
			awaitingPayload,
			reviewPayload,
		);

		assert.equal(result.lane, 'waiting_on_you');
		assert.ok(result.awaitingOperator, 'awaitingOperator carried');
		assert.equal(result.awaitingOperator.question, awaitingPayload.question);
		assert.equal(result.reviewHandoff, undefined, 'reviewHandoff absent when awaitingOperator wins');
	});

	test('no reviewHandoff + unblocked AI-owned → ready_for_ai (unchanged)', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress(
			'projects/soul-hub/adr-026.md',
			'ai',
			[],
			new Map(),
			undefined,
			undefined, // no reviewHandoff
		);

		assert.equal(result.lane, 'ready_for_ai');
		assert.equal(result.reviewHandoff, undefined);
	});
});

// ── Suite 4: listReviewableRuns ───────────────────────────────────────────────

describe('listReviewableRuns', () => {
	let db: Database.Database;

	/** Minimal agent_runs schema for the columns listReviewableRuns touches.
	 *  Includes `handback` (ADR-026 D3 migration v21). */
	function createTestDb(): Database.Database {
		const d = new Database(':memory:');
		d.exec(`
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
				result_excerpt  TEXT,
				subject_path    TEXT,
				handback        TEXT
			)
		`);
		return d;
	}

	type InsertRow = {
		runId: string;
		startedAt: number;
		finishedAt?: number | null;
		status: string;
		costUsd?: number;
		numTurns?: number;
		subjectPath?: string | null;
		resultExcerpt?: string | null;
	};

	function insertRow(d: Database.Database, r: InsertRow): void {
		d.prepare(`
			INSERT INTO agent_runs
				(run_id, started_at, finished_at, status, cost_usd, num_turns, subject_path, result_excerpt)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			r.runId,
			r.startedAt,
			r.finishedAt ?? null,
			r.status,
			r.costUsd ?? 0,
			r.numTurns ?? 0,
			r.subjectPath ?? null,
			r.resultExcerpt ?? null,
		);
	}

	before(() => {
		db = createTestDb();
	});

	after(() => {
		db.close();
	});

	test('empty when no successful finished rows', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const result = listReviewableRuns(db);
		assert.equal(result.size, 0);
	});

	test('returns run for goal_achieved + finished_at', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		insertRow(db, {
			runId: 'rev-001',
			startedAt: now - 300_000,
			finishedAt: now - 60_000,
			status: 'goal_achieved',
			costUsd: 0.55,
			numTurns: 20,
			subjectPath: 'projects/foo/adr-001.md',
		});

		const result = listReviewableRuns(db);
		assert.ok(result.has('projects/foo/adr-001.md'), 'goal_achieved run should appear');
		const run = result.get('projects/foo/adr-001.md')!;
		assert.equal(run.runId, 'rev-001');
		assert.ok(Math.abs(run.costUsd - 0.55) < 0.001);
		assert.equal(run.numTurns, 20);
	});

	test('returns run for success + finished_at', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		insertRow(db, {
			runId: 'rev-002',
			startedAt: now - 200_000,
			finishedAt: now - 50_000,
			status: 'success',
			costUsd: 0.30,
			numTurns: 10,
			subjectPath: 'projects/bar/adr-002.md',
		});

		const result = listReviewableRuns(db);
		assert.ok(result.has('projects/bar/adr-002.md'), 'success run should appear');
	});

	test('excludes runs with null subject_path', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		insertRow(db, {
			runId: 'rev-003-no-subject',
			startedAt: now - 100_000,
			finishedAt: now - 10_000,
			status: 'goal_achieved',
			subjectPath: null,
		});

		const result = listReviewableRuns(db);
		// All keys must be non-null non-empty strings.
		for (const key of result.keys()) {
			assert.ok(key != null && key.length > 0, `null/empty key found: ${key}`);
		}
	});

	test('excludes running rows (finished_at IS NULL)', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		insertRow(db, {
			runId: 'rev-004-running',
			startedAt: now - 60_000,
			finishedAt: null, // still running
			status: 'goal_achieved', // hypothetical — in practice running rows have status='running'
			subjectPath: 'projects/baz/adr-003.md',
		});

		const result = listReviewableRuns(db);
		assert.ok(!result.has('projects/baz/adr-003.md'), 'unfinished row must be excluded');
	});

	test('excludes failed/interrupted/timeout rows', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		for (const [status, subject] of [
			['failed', 'projects/qux/adr-004.md'],
			['interrupted', 'projects/qux/adr-005.md'],
			['timeout', 'projects/qux/adr-006.md'],
			['error', 'projects/qux/adr-007.md'],
		]) {
			insertRow(db, {
				runId: `rev-bad-${status}`,
				startedAt: now - 50_000,
				finishedAt: now - 10_000,
				status,
				subjectPath: subject,
			});
		}

		const result = listReviewableRuns(db);
		for (const subject of ['projects/qux/adr-004.md', 'projects/qux/adr-005.md',
			'projects/qux/adr-006.md', 'projects/qux/adr-007.md']) {
			assert.ok(!result.has(subject), `${subject} should be excluded`);
		}
	});

	test('keeps newest per subject_path (most-recently-started wins)', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const now = Date.now();

		// Older run
		insertRow(db, {
			runId: 'rev-old',
			startedAt: now - 600_000,
			finishedAt: now - 500_000,
			status: 'success',
			costUsd: 0.10,
			numTurns: 5,
			subjectPath: 'projects/dedup/adr-008.md',
		});
		// Newer run for the same subject
		insertRow(db, {
			runId: 'rev-new',
			startedAt: now - 60_000,
			finishedAt: now - 10_000,
			status: 'goal_achieved',
			costUsd: 0.80,
			numTurns: 30,
			subjectPath: 'projects/dedup/adr-008.md',
		});

		const result = listReviewableRuns(db);
		const run = result.get('projects/dedup/adr-008.md');
		assert.ok(run, 'subject should appear');
		assert.equal(run.runId, 'rev-new', 'newest run should win');
		assert.ok(Math.abs(run.costUsd - 0.80) < 0.001, 'newest cost');
		assert.equal(run.numTurns, 30, 'newest turns');
	});
});
