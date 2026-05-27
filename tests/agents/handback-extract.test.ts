/** ADR-026 D3 + ADR-028 + ADR-029 + ADR-033 — `extractHandBackBlock`, `finishAgentRun` round-trip,
 *  worklist D3 false-red regression tests, ADR-028 tolerant parser tests,
 *  ADR-029 tolerant gate-value matching tests, and ADR-033 content-based gate matching tests.
 *
 *  Suites:
 *
 *   1. `extractHandBackBlock` — pure function:
 *      - returns the raw fenced block when present in a long output
 *      - block longer than 800 chars is returned intact (proves it's untruncated)
 *      - null when no fenced block found
 *      - null for null / empty input
 *      - only the first fenced json block is returned (there should only be one)
 *
 *   2. `finishAgentRun` + `listReviewableRuns` round-trip (in-memory DB):
 *      - handback longer than 800 chars is stored fully (not truncated)
 *      - listReviewableRuns returns the handback intact
 *      - resultExcerpt is still truncated at RESULT_EXCERPT_LIMIT (800 chars)
 *
 *   3. Worklist D3 / false-red bug regression:
 *      - a GREEN run stored with full handback → gatesGreen=true, non-empty summary
 *      - a run stored without handback (pre-migration null) falls back to resultExcerpt
 *
 *   4. ADR-028 tolerant parser (parseHandback):
 *      - well-formed JSON goes through strict path unchanged
 *      - unescaped quotes in summary → gates still correctly read as green
 *      - unescaped quotes in follow_ups → gates still correctly read as green
 *      - malformed gates (check_passed missing) → parsed as false, gatesGreen=false
 *      - no branch → returns null
 *      - backward-compat: parseHandBack alias works unchanged
 *
 *   5. ADR-029 tolerant gate-value matching (handbackGatesGreen):
 *      - annotated "pass (…)" values → gatesGreen=true  (the run #486 regression)
 *      - bare "pass" still → true (unchanged baseline)
 *      - "passed" and "PASS" (case variants) → true
 *      - "fail (…)" annotated failure → gatesGreen=false
 *      - "skipped" / "warn" / "error" / "pending" → gatesGreen=false
 *      - empty gate_results → true (no gates to fail)
 *      - check_passed=false overrides all-pass gate_results → false
 *      - build_passed=false overrides all-pass gate_results → false
 *
 *   6. ADR-033 content-based gate matching (isGateGreen / handbackGatesGreen):
 *      - count-prefixed "14/14 pass (…)" → true  (the ADR-018 live regression)
 *      - "3/3 pass" → true
 *      - "✓ pass" → true
 *      - "passing — see log" → true
 *      - "did not pass" → false (negated pass)
 *      - "tests did not pass" → false (negated pass)
 *      - "1 failed, 13 pass" → false (fail token wins over pass token)
 *      - "✗ 2 failing" → false (fail glyph + no pass)
 *      - "❌ gate failed" → false (fail emoji + fail token)
 *      - "0 == baseline 0" → false (no pass token — fail-closed)
 *      - "pass — 0 errors == baseline 0" → true (errors is NOT a fail token)
 *      - all ADR-029 suite cases unchanged (backward-compat)
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/handback-extract.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GREEN_HANDBACK = {
	branch: 'orchestration/run-1779000000000/adr-026-impl',
	commits: ['abc123 feat: persist hand-back block untruncated'],
	files_changed: [
		'src/lib/agents/handback.ts',
		'src/lib/agents/runs.ts',
		'src/lib/channels/whatsapp/heartbeat-state.ts',
		'src/lib/agents/dispatch/index.ts',
		'src/routes/api/vault/projects/[slug]/worklist/+server.ts',
	],
	check_passed: true,
	build_passed: true,
	gate_results: {
		typecheck_gate: 'pass',
		no_owner_domain: 'pass',
		cli_tsc: 'pass',
	},
	summary: 'Persists the full agent hand-back JSON block in a new untruncated `handback` column on agent_runs. The D3 review card now reads this column first so gate_results/summary/follow_ups always populate correctly even for long-output runs.',
	follow_ups: [
		'Wire Telegram notification on review-ready',
		'Backfill handback for existing rows if needed',
	],
};

/** Build a realistic long agent output where the hand-back sits at the END
 *  and would be truncated by the 800-char result_excerpt limit. */
function buildLongOutput(hb: object): string {
	const preamble = 'A'.repeat(2000) + '\n\n'; // well beyond 800 chars of preamble
	const fence = '```json\n' + JSON.stringify(hb, null, 2) + '\n```';
	return preamble + fence;
}

// ── Suite 1: extractHandBackBlock ─────────────────────────────────────────────

describe('extractHandBackBlock', () => {
	test('returns the raw fenced block when present in long output', async () => {
		const { extractHandBackBlock } = await import('$lib/agents/handback.ts');

		const output = buildLongOutput(GREEN_HANDBACK);
		const block = extractHandBackBlock(output);

		assert.ok(block, 'should return a non-null block');
		assert.ok(block.startsWith('```json'), 'block must start with the fence opener');
		assert.ok(block.endsWith('```'), 'block must end with the fence closer');
		// Must contain the summary verbatim.
		assert.ok(block.includes(GREEN_HANDBACK.summary), 'block must contain the summary');
	});

	test('block longer than 800 chars is returned intact (proves not truncated)', async () => {
		const { extractHandBackBlock } = await import('$lib/agents/handback.ts');

		const output = buildLongOutput(GREEN_HANDBACK);
		const block = extractHandBackBlock(output);

		assert.ok(block, 'block must be present');
		// The JSON content alone (plus fences) is certainly > 800 chars.
		assert.ok(block.length > 800, `block length ${block.length} should exceed 800 chars`);

		// Verify the block is parseable by parseHandBack.
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const hb = parseHandBack(block);
		assert.ok(hb, 'parseHandBack must succeed on the extracted block');
		assert.equal(hb.branch, GREEN_HANDBACK.branch);
		assert.equal(hb.summary, GREEN_HANDBACK.summary);
		assert.deepEqual(hb.follow_ups, GREEN_HANDBACK.follow_ups);
		assert.equal(hb.check_passed, true);
		assert.equal(hb.build_passed, true);
	});

	test('returns null when no fenced json block found', async () => {
		const { extractHandBackBlock } = await import('$lib/agents/handback.ts');

		const result = extractHandBackBlock('No fenced block here, just plain text.');
		assert.equal(result, null);
	});

	test('returns null for null input', async () => {
		const { extractHandBackBlock } = await import('$lib/agents/handback.ts');
		assert.equal(extractHandBackBlock(null), null);
	});

	test('returns null for empty string', async () => {
		const { extractHandBackBlock } = await import('$lib/agents/handback.ts');
		assert.equal(extractHandBackBlock(''), null);
	});

	test('returns first fenced json block when multiple are present', async () => {
		const { extractHandBackBlock } = await import('$lib/agents/handback.ts');

		const output = '```json\n{"branch":"first"}\n```\n\nsome text\n\n```json\n{"branch":"second"}\n```';
		const block = extractHandBackBlock(output);

		assert.ok(block, 'should return a block');
		assert.ok(block.includes('"first"'), 'should return the FIRST block');
		assert.ok(!block.includes('"second"'), 'should NOT include second block');
	});
});

// ── Suite 2: finishAgentRun + listReviewableRuns round-trip ──────────────────

describe('finishAgentRun round-trip — handback stored untruncated', () => {
	let db: Database.Database;

	/** Minimal schema: the columns finishAgentRun + listReviewableRuns touch,
	 *  including the new `handback` column from migration v21. */
	function createTestDb(): Database.Database {
		const d = new Database(':memory:');
		d.exec(`
			CREATE TABLE agent_runs (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id          TEXT    NOT NULL,
				agent_id        TEXT    NOT NULL DEFAULT 'soul-hub-implementer',
				backend         TEXT    NOT NULL DEFAULT 'claude-pty',
				mode            TEXT    NOT NULL DEFAULT 'production',
				task_spec       TEXT    NOT NULL DEFAULT 'test',
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
		return d;
	}

	before(() => {
		db = createTestDb();
	});

	after(() => {
		db.close();
	});

	test('handback longer than 800 chars is stored fully — not truncated', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');

		const fullOutput = buildLongOutput(GREEN_HANDBACK);
		const { extractHandBackBlock } = await import('$lib/agents/handback.ts');
		const handback = extractHandBackBlock(fullOutput);
		assert.ok(handback && handback.length > 800, 'fixture handback must exceed 800 chars');

		const now = Date.now();
		const subjectPath = 'projects/soul-hub/adr-026-d3-test.md';

		// Simulate what finishAgentRun does: INSERT with truncated excerpt but
		// full handback.
		const EXCERPT_LIMIT = 800;
		const truncatedExcerpt = fullOutput.slice(0, EXCERPT_LIMIT) + '…';

		db.prepare(`
			INSERT INTO agent_runs
				(run_id, started_at, finished_at, duration_ms, status, cost_usd, num_turns,
				 subject_path, result_excerpt, handback)
			VALUES (?, ?, ?, ?, 'goal_achieved', 0.42, 25, ?, ?, ?)
		`).run('hb-rt-001', now - 300_000, now - 60_000, 240_000,
			subjectPath, truncatedExcerpt, handback);

		const runs = listReviewableRuns(db);
		assert.ok(runs.has(subjectPath), 'run should appear in reviewable runs');

		const run = runs.get(subjectPath)!;

		// resultExcerpt must be truncated (800 + ellipsis)
		assert.ok(
			run.resultExcerpt !== null && run.resultExcerpt.endsWith('…'),
			'resultExcerpt should be truncated (ends with ellipsis)',
		);
		assert.ok(
			run.resultExcerpt.length <= EXCERPT_LIMIT + 3, // +3 for '…' (multi-byte)
			`resultExcerpt length ${run.resultExcerpt.length} should be ≤ ${EXCERPT_LIMIT + 3}`,
		);

		// handback must be the full block
		assert.ok(run.handback, 'handback must be stored');
		assert.equal(run.handback, handback, 'handback must be stored exactly as extracted');
		assert.ok(run.handback.length > 800, 'handback must be longer than 800 chars');
	});

	test('parseHandBack on stored handback returns complete HandBack with gatesGreen=true', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const { parseHandBack, isGatesGreen } = await import('$lib/agents/handback.ts');

		const runs = listReviewableRuns(db);
		const subjectPath = 'projects/soul-hub/adr-026-d3-test.md';
		const run = runs.get(subjectPath);
		assert.ok(run, 'run must exist from previous test');
		assert.ok(run.handback, 'handback must be present');

		// This is the core fix: parse the stored handback, not the truncated excerpt.
		const hb = parseHandBack(run.handback);
		assert.ok(hb, 'parseHandBack must succeed on the stored handback');
		assert.equal(hb.branch, GREEN_HANDBACK.branch);
		assert.equal(hb.summary, GREEN_HANDBACK.summary);
		assert.deepEqual(hb.follow_ups, GREEN_HANDBACK.follow_ups);
		assert.equal(isGatesGreen(hb), true, 'gatesGreen must be true for a GREEN run');

		// Prove the bug: parsing the TRUNCATED excerpt would have failed.
		const hbFromExcerpt = parseHandBack(run.resultExcerpt);
		assert.equal(hbFromExcerpt, null, 'parseHandBack on truncated excerpt must return null (the original bug)');
	});
});

// ── Suite 3: Worklist D3 false-red bug regression ─────────────────────────────

describe('worklist D3 — false-red bug fixed', () => {
	let db: Database.Database;

	function createTestDb(): Database.Database {
		const d = new Database(':memory:');
		d.exec(`
			CREATE TABLE agent_runs (
				id              INTEGER PRIMARY KEY AUTOINCREMENT,
				run_id          TEXT    NOT NULL,
				agent_id        TEXT    NOT NULL DEFAULT 'soul-hub-implementer',
				backend         TEXT    NOT NULL DEFAULT 'claude-pty',
				mode            TEXT    NOT NULL DEFAULT 'production',
				task_spec       TEXT    NOT NULL DEFAULT 'test',
				started_at      INTEGER NOT NULL,
				finished_at     INTEGER,
				duration_ms     INTEGER,
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

	before(() => {
		db = createTestDb();
	});

	after(() => {
		db.close();
	});

	test('GREEN run with full handback → gatesGreen=true, non-empty summary (false-red bug fixed)', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const { parseHandBack, isGatesGreen } = await import('$lib/agents/handback.ts');

		const fullOutput = buildLongOutput(GREEN_HANDBACK);
		const { extractHandBackBlock } = await import('$lib/agents/handback.ts');
		const handback = extractHandBackBlock(fullOutput);
		assert.ok(handback, 'fixture must produce a handback block');

		const EXCERPT_LIMIT = 800;
		const truncatedExcerpt = fullOutput.slice(0, EXCERPT_LIMIT) + '…';
		const now = Date.now();
		const subjectPath = 'projects/soul-hub/adr-026-false-red.md';

		db.prepare(`
			INSERT INTO agent_runs
				(run_id, started_at, finished_at, status, cost_usd, num_turns,
				 subject_path, result_excerpt, handback)
			VALUES (?, ?, ?, 'goal_achieved', 1.23, 42, ?, ?, ?)
		`).run('dr3-green-001', now - 300_000, now - 30_000,
			subjectPath, truncatedExcerpt, handback);

		const runs = listReviewableRuns(db);
		const run = runs.get(subjectPath);
		assert.ok(run, 'run must appear');

		// The fix: read handback first, fall back to resultExcerpt.
		const hb = parseHandBack(run.handback ?? run.resultExcerpt);
		assert.ok(hb, 'parseHandBack must succeed');
		assert.equal(hb.summary.length > 0, true, 'summary must be non-empty');
		assert.deepEqual(hb.follow_ups, GREEN_HANDBACK.follow_ups);
		assert.equal(isGatesGreen(hb), true, 'gatesGreen must be TRUE — false-red bug is fixed');
	});

	test('pre-migration run (null handback) falls back to resultExcerpt gracefully', async () => {
		const { listReviewableRuns } = await import('$lib/agents/runs.ts');
		const { parseHandBack } = await import('$lib/agents/handback.ts');

		// A short output that fits within 800 chars — simulates an old row whose
		// full output happened to fit in the excerpt (back-compat path).
		const shortHandBack = {
			branch: 'orchestration/run-111/short',
			commits: [],
			files_changed: [],
			check_passed: true,
			build_passed: true,
			gate_results: {},
			summary: 'Short run that fit in 800 chars.',
			follow_ups: [],
		};
		const shortOutput = '```json\n' + JSON.stringify(shortHandBack) + '\n```';
		assert.ok(shortOutput.length < 800, 'fixture must be short enough to fit in excerpt');

		const now = Date.now();
		const subjectPath = 'projects/soul-hub/adr-026-legacy.md';

		db.prepare(`
			INSERT INTO agent_runs
				(run_id, started_at, finished_at, status, cost_usd, num_turns,
				 subject_path, result_excerpt, handback)
			VALUES (?, ?, ?, 'success', 0.05, 3, ?, ?, NULL)
		`).run('dr3-legacy-001', now - 600_000, now - 500_000,
			subjectPath, shortOutput);

		const runs = listReviewableRuns(db);
		const run = runs.get(subjectPath);
		assert.ok(run, 'run must appear');
		assert.equal(run.handback, null, 'handback must be null for pre-migration row');

		// Fallback: run.handback ?? run.resultExcerpt → resultExcerpt
		const hb = parseHandBack(run.handback ?? run.resultExcerpt);
		assert.ok(hb, 'parseHandBack must succeed via fallback to resultExcerpt');
		assert.equal(hb.branch, shortHandBack.branch);
		assert.equal(hb.summary, shortHandBack.summary);
	});
});

// ── Suite 4: ADR-028 tolerant parser ─────────────────────────────────────────

describe('ADR-028 parseHandback — tolerant parser', () => {
	const BRANCH = 'orchestration/run-1779865089243/adr-028-robust-implementer-handback-parsing';

	function makeFencedOutput(body: string): string {
		return `Some preamble text...\n\n\`\`\`json\n${body}\n\`\`\``;
	}

	// ── Happy path: well-formed JSON goes through strict path unchanged ────────

	test('well-formed JSON hand-back parses correctly (strict path unchanged)', async () => {
		const { parseHandback, handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const payload = {
			branch: BRANCH,
			commits: ['abc123 feat: add tolerant parser'],
			files_changed: ['src/lib/agents/handback.ts'],
			check_passed: true,
			build_passed: true,
			gate_results: { typecheck_gate: 'pass', no_owner_domain: 'pass', cli_tsc: 'pass' },
			summary: 'No quotes issues here.',
			follow_ups: ['Consider adding more tests.'],
		};
		const raw = makeFencedOutput(JSON.stringify(payload, null, 2));
		const hb = parseHandback(raw);

		assert.ok(hb, 'must parse successfully');
		assert.equal(hb.branch, BRANCH);
		assert.equal(hb.check_passed, true);
		assert.equal(hb.build_passed, true);
		assert.deepEqual(hb.gate_results, { typecheck_gate: 'pass', no_owner_domain: 'pass', cli_tsc: 'pass' });
		assert.equal(hb.summary, 'No quotes issues here.');
		assert.deepEqual(hb.follow_ups, ['Consider adding more tests.']);
		assert.equal(handbackGatesGreen(hb), true);
	});

	// ── Sad path: unescaped quotes in summary — the live ADR-027 regression ───

	test('unescaped double-quotes in summary → gates still read as green (ADR-027 regression)', async () => {
		const { parseHandback, handbackGatesGreen } = await import('$lib/agents/handback.ts');

		// Simulate exactly the pattern that broke run #483 (ADR-027):
		// summary field contains raw unescaped double-quotes.
		const malformedJson = `{
  "branch": "${BRANCH}",
  "commits": ["abc123 feat: add ship-merge button"],
  "files_changed": ["src/lib/components/projects/AdrDrawer.svelte"],
  "check_passed": true,
  "build_passed": true,
  "gate_results": {"typecheck_gate": "pass", "no_owner_domain": "pass", "cli_tsc": "pass"},
  "summary": "Implementation shows "⇡ Ship & merge" (primary) button visible when gates green.",
  "follow_ups": []
}`;
		// Confirm JSON.parse actually fails on this (the regression precondition).
		assert.throws(() => JSON.parse(malformedJson), 'malformed JSON must fail strict parse');

		const raw = makeFencedOutput(malformedJson);
		const hb = parseHandback(raw);

		assert.ok(hb, 'must parse successfully despite malformed summary');
		assert.equal(hb.branch, BRANCH, 'branch must be recovered');
		assert.equal(hb.check_passed, true, 'check_passed must be recovered as true');
		assert.equal(hb.build_passed, true, 'build_passed must be recovered as true');
		assert.deepEqual(hb.gate_results, { typecheck_gate: 'pass', no_owner_domain: 'pass', cli_tsc: 'pass' });
		assert.equal(handbackGatesGreen(hb), true, 'gates must be green despite malformed summary');
		// summary is best-effort — may be truncated, must not throw
		assert.equal(typeof hb.summary, 'string', 'summary must be a string (possibly truncated)');
		assert.deepEqual(hb.follow_ups, []);
	});

	// ── Sad path: unescaped quotes in follow_ups ──────────────────────────────

	test('unescaped double-quotes in follow_ups → gates still read as green', async () => {
		const { parseHandback, handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const malformedJson = `{
  "branch": "${BRANCH}",
  "commits": [],
  "files_changed": [],
  "check_passed": true,
  "build_passed": true,
  "gate_results": {"typecheck_gate": "pass"},
  "summary": "Clean summary here.",
  "follow_ups": ["Check the "main" branch is up to date before merging."]
}`;
		assert.throws(() => JSON.parse(malformedJson), 'precondition: must fail strict parse');

		const hb = parseHandback(makeFencedOutput(malformedJson));

		assert.ok(hb, 'must parse successfully');
		assert.equal(hb.check_passed, true);
		assert.equal(hb.build_passed, true);
		assert.equal(handbackGatesGreen(hb), true, 'gates must be green');
	});

	// ── Sad path: check_passed missing → defaults to false ────────────────────

	test('check_passed absent from hand-back → parsed as false, gatesGreen=false', async () => {
		const { parseHandback, handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const payload = JSON.stringify({
			branch: BRANCH,
			commits: [],
			files_changed: [],
			// check_passed deliberately omitted
			build_passed: true,
			gate_results: { typecheck_gate: 'pass' },
			summary: '',
			follow_ups: [],
		});

		const hb = parseHandback(makeFencedOutput(payload));
		assert.ok(hb, 'must parse (branch is present)');
		assert.equal(hb.check_passed, false, 'missing check_passed must default to false');
		assert.equal(handbackGatesGreen(hb), false, 'gates must be red when check_passed is false');
	});

	// ── Sad path: failing gate → gatesGreen=false ────────────────────────────

	test('gate_results with "fail" → handbackGatesGreen returns false', async () => {
		const { parseHandback, handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const payload = JSON.stringify({
			branch: BRANCH,
			commits: [],
			files_changed: [],
			check_passed: true,
			build_passed: true,
			gate_results: { typecheck_gate: 'fail', no_owner_domain: 'pass' },
			summary: '',
			follow_ups: [],
		});

		const hb = parseHandback(makeFencedOutput(payload));
		assert.ok(hb);
		assert.equal(handbackGatesGreen(hb), false, 'any failing gate must make gatesGreen false');
	});

	// ── Sad path: no branch → null ────────────────────────────────────────────

	test('hand-back JSON without branch field → returns null', async () => {
		const { parseHandback } = await import('$lib/agents/handback.ts');

		const noBranch = makeFencedOutput(JSON.stringify({
			commits: [],
			files_changed: [],
			check_passed: true,
			build_passed: true,
			gate_results: {},
			summary: '',
			follow_ups: [],
		}));

		assert.equal(parseHandback(noBranch), null, 'must return null when branch is absent');
	});

	// ── Sad path: empty / null input ──────────────────────────────────────────

	test('null input → returns null', async () => {
		const { parseHandback } = await import('$lib/agents/handback.ts');
		assert.equal(parseHandback(null), null);
	});

	test('empty string → returns null', async () => {
		const { parseHandback } = await import('$lib/agents/handback.ts');
		assert.equal(parseHandback(''), null);
	});

	// ── Backward-compat: parseHandBack alias ──────────────────────────────────

	test('parseHandBack alias produces same result as parseHandback', async () => {
		const { parseHandBack, parseHandback } = await import('$lib/agents/handback.ts');

		const payload = JSON.stringify({
			branch: BRANCH,
			commits: [],
			files_changed: [],
			check_passed: true,
			build_passed: true,
			gate_results: { typecheck_gate: 'pass' },
			summary: 'Alias test.',
			follow_ups: [],
		});
		const raw = makeFencedOutput(payload);

		const a = parseHandBack(raw);
		const b = parseHandback(raw);
		assert.ok(a && b);
		assert.deepEqual(a, b, 'parseHandBack and parseHandback must return identical results');
	});
});

// ── Suite 5: ADR-029 tolerant gate-value matching ─────────────────────────────

describe('ADR-029 handbackGatesGreen — tolerant gate-value matching', () => {
	const BRANCH = 'orchestration/run-1779869866918/adr-029-tolerant-gate-value-matching';

	function makeHandback(gate_results: Record<string, string>, opts?: {
		check_passed?: boolean;
		build_passed?: boolean;
	}) {
		return {
			branch: BRANCH,
			commits: [],
			files_changed: [],
			check_passed: opts?.check_passed ?? true,
			build_passed: opts?.build_passed ?? true,
			gate_results,
			summary: '',
			follow_ups: [],
		};
	}

	// ── Regression: run #486 (ADR-015) actual gate values ──────────────────

	test('run #486 actual annotated gate values → gatesGreen=true (ADR-029 regression)', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');

		// These are the exact values emitted by run #486 (ADR-015) that caused
		// the false-red display despite genuinely passing gates.
		const hb = makeHandback({
			typecheck_gate: 'pass (current=0, baseline=0)',
			no_owner_domain: 'pass (strict-zero clean)',
			cli_tsc: 'pass (pre-push hook)',
		});

		assert.equal(
			handbackGatesGreen(hb),
			true,
			'annotated pass values must be treated as green (the run #486 false-red regression)',
		);
	});

	// ── Happy path: bare "pass" still works (unchanged baseline) ───────────

	test('bare "pass" gate values → gatesGreen=true (unchanged baseline)', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const hb = makeHandback({
			typecheck_gate: 'pass',
			no_owner_domain: 'pass',
			cli_tsc: 'pass',
		});

		assert.equal(handbackGatesGreen(hb), true, 'bare "pass" must remain green');
	});

	// ── Happy path: case variants ─────────────────────────────────────────

	test('"PASS" (uppercase) → gatesGreen=true', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');
		assert.equal(handbackGatesGreen(makeHandback({ typecheck_gate: 'PASS' })), true);
	});

	test('"passed" → gatesGreen=true', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');
		assert.equal(handbackGatesGreen(makeHandback({ typecheck_gate: 'passed' })), true);
	});

	test('"Pass (strict-zero)" (mixed case) → gatesGreen=true', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');
		assert.equal(handbackGatesGreen(makeHandback({ typecheck_gate: 'Pass (strict-zero)' })), true);
	});

	// ── Sad path: annotated failure → gatesGreen=false ───────────────────

	test('"fail (2 errors)" annotated failure → gatesGreen=false', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const hb = makeHandback({
			typecheck_gate: 'pass',
			no_owner_domain: 'fail (2 errors)',
			cli_tsc: 'pass',
		});

		assert.equal(
			handbackGatesGreen(hb),
			false,
			'"fail (…)" must be treated as red even when annotated',
		);
	});

	// ── Sad path: non-pass verdicts ───────────────────────────────────────

	test('"skipped" → gatesGreen=false', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');
		assert.equal(handbackGatesGreen(makeHandback({ typecheck_gate: 'skipped' })), false);
	});

	test('"warn" → gatesGreen=false', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');
		assert.equal(handbackGatesGreen(makeHandback({ typecheck_gate: 'warn' })), false);
	});

	test('"error" → gatesGreen=false', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');
		assert.equal(handbackGatesGreen(makeHandback({ typecheck_gate: 'error' })), false);
	});

	test('"pending" → gatesGreen=false', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');
		assert.equal(handbackGatesGreen(makeHandback({ typecheck_gate: 'pending' })), false);
	});

	// ── Edge case: empty gate_results → true (no gates to fail) ──────────

	test('empty gate_results ({}) → gatesGreen=true (no gates to fail)', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');
		assert.equal(handbackGatesGreen(makeHandback({})), true);
	});

	// ── Boolean guards override gate_results ──────────────────────────────

	test('check_passed=false with all-pass gates → gatesGreen=false', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const hb = makeHandback(
			{ typecheck_gate: 'pass (current=0, baseline=0)', cli_tsc: 'pass' },
			{ check_passed: false },
		);

		assert.equal(
			handbackGatesGreen(hb),
			false,
			'check_passed=false must override annotated-pass gate values',
		);
	});

	test('build_passed=false with all-pass gates → gatesGreen=false', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const hb = makeHandback(
			{ typecheck_gate: 'pass (current=0, baseline=0)', cli_tsc: 'pass' },
			{ build_passed: false },
		);

		assert.equal(
			handbackGatesGreen(hb),
			false,
			'build_passed=false must override annotated-pass gate values',
		);
	});

	// ── Mixed: one annotated pass, one bare pass → still green ───────────

	test('mixed annotated + bare pass values → gatesGreen=true', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const hb = makeHandback({
			typecheck_gate: 'pass (current=0, baseline=0)',
			no_owner_domain: 'pass',
			cli_tsc: 'pass (pre-push hook)',
		});

		assert.equal(handbackGatesGreen(hb), true, 'mixed annotated + bare pass must all be green');
	});
});

// ── Suite 6: ADR-033 content-based gate matching ──────────────────────────────

describe('ADR-033 isGateGreen — content-based gate matching', () => {
	const BRANCH = 'orchestration/run-1779894624334/adr-033-tolerant-gate-value-content-match';

	function makeHandback(gate_results: Record<string, string>, opts?: {
		check_passed?: boolean;
		build_passed?: boolean;
	}) {
		return {
			branch: BRANCH,
			commits: [],
			files_changed: [],
			check_passed: opts?.check_passed ?? true,
			build_passed: opts?.build_passed ?? true,
			gate_results,
			summary: '',
			follow_ups: [],
		};
	}

	// ── Live regression: count-prefixed value (ADR-018 dispatch) ──────────

	test('count-prefixed "14/14 pass (…)" → gatesGreen=true (ADR-033 live regression)', async () => {
		const { isGateGreen, handbackGatesGreen } = await import('$lib/agents/handback.ts');

		// The exact value that false-redded the ADR-018 dispatch on 2026-05-27.
		const val = '14/14 pass (5 ADR-016 + 7 ADR-018 falsifiers)';
		assert.equal(isGateGreen(val), true, 'isGateGreen must recognise count-prefixed pass');

		const hb = makeHandback({ unit_tests: val });
		assert.equal(
			handbackGatesGreen(hb),
			true,
			'handbackGatesGreen must return true for count-prefixed pass (ADR-018 regression)',
		);
	});

	// ── Happy path: more count-prefixed and symbol-prefixed forms ─────────

	test('"3/3 pass" → isGateGreen=true', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('3/3 pass'), true);
	});

	test('"✓ pass" → isGateGreen=true (checkmark prefix)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('✓ pass'), true);
	});

	test('"passing — see log" → isGateGreen=true', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('passing — see log'), true);
	});

	test('"pass — 0 errors == baseline 0" → isGateGreen=true (errors is NOT a fail token)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		// ADR-033 explicitly excludes "error"/"errors" from the fail token list so
		// green typecheck values like "pass — 0 errors == baseline 0" stay green.
		assert.equal(isGateGreen('pass — 0 errors == baseline 0'), true);
	});

	// ── Sad path: negated pass → false ────────────────────────────────────

	test('"did not pass" → isGateGreen=false (negated pass)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('did not pass'), false, '"did not pass" must be red');
	});

	test('"tests did not pass" → isGateGreen=false (negated pass)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('tests did not pass'), false, '"tests did not pass" must be red');
	});

	test('"without pass" → isGateGreen=false (negated pass)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('without pass'), false, '"without pass" must be red');
	});

	// ── Sad path: fail token wins over pass token ─────────────────────────

	test('"1 failed, 13 pass" → isGateGreen=false (fail token wins)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(
			isGateGreen('1 failed, 13 pass'),
			false,
			'fail token must override the pass token',
		);
	});

	test('"passed but 2 failures" → isGateGreen=false (fail token wins)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('passed but 2 failures'), false, 'fail token must win');
	});

	// ── Sad path: fail glyphs → false ────────────────────────────────────

	test('"✗ 2 failing" → isGateGreen=false (fail glyph, no pass token)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('✗ 2 failing'), false, '✗ glyph must be red');
	});

	test('"❌ gate failed" → isGateGreen=false (fail emoji + fail token)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('❌ gate failed'), false, '❌ emoji must be red');
	});

	// ── Sad path: ambiguous (no pass token) → false — fail-closed ────────

	test('"0 == baseline 0" → isGateGreen=false (no pass token — fail-closed)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		// A bare metric with no explicit "pass" signal must stay red.
		assert.equal(isGateGreen('0 == baseline 0'), false, 'no pass token must be red (fail-closed)');
	});

	test('"skipped" → isGateGreen=false (no pass token)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('skipped'), false);
	});

	// ── Integration: count-prefixed gate via handbackGatesGreen ──────────

	test('mixed count-prefixed + annotated + bare gates → gatesGreen=true', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const hb = makeHandback({
			unit_tests:    '14/14 pass (5 ADR-016 + 7 ADR-018 falsifiers)',
			typecheck_gate: 'pass (current=0, baseline=0)',
			no_owner_domain: 'pass',
			cli_tsc: 'pass',
		});

		assert.equal(
			handbackGatesGreen(hb),
			true,
			'count-prefixed + annotated + bare pass values must all be green together',
		);
	});

	test('one count-prefixed fail mixed with passes → gatesGreen=false', async () => {
		const { handbackGatesGreen } = await import('$lib/agents/handback.ts');

		const hb = makeHandback({
			unit_tests:    '13/14 pass, 1 failed',
			typecheck_gate: 'pass',
			cli_tsc: 'pass',
		});

		assert.equal(
			handbackGatesGreen(hb),
			false,
			'any gate with a fail token must keep the whole set red',
		);
	});

	// ── Backward-compat: ADR-029 suite cases are unchanged ───────────────

	test('ADR-029 backward-compat: "pass (current=0, baseline=0)" still green', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('pass (current=0, baseline=0)'), true);
	});

	test('ADR-029 backward-compat: "PASS" (uppercase) still green', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('PASS'), true);
	});

	test('ADR-029 backward-compat: "fail (2 errors)" still red', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('fail (2 errors)'), false);
	});

	test('ADR-029 backward-compat: "error" alone still red (no pass token)', async () => {
		const { isGateGreen } = await import('$lib/agents/handback.ts');
		assert.equal(isGateGreen('error'), false);
	});
});
