/**
 * project-phases ADR-008 S1 (Layer A v2) — assumption-scorer + extractLinkedProjects tests.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/audit/assumption-scorer.test.ts
 *
 * Tests are grouped by signal. Alongside the positive cases, the
 * "false-positive regression" block pins the exact v1 failures the rewrite
 * was meant to kill (the bare word "actually", design references, table
 * rows, claims grounded by a same-turn tool). Those are the load-bearing
 * tests — if they regress, Layer A is measuring word frequency again.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreTranscript } from '../../src/lib/audit/assumption-scorer.ts';
import { extractLinkedProjects } from '../../src/lib/audit/extract-linked-projects.ts';

const FIXTURE_PATH = resolve(
	import.meta.dirname,
	'..',
	'fixtures',
	'adr-008-known-failures.jsonl'
);

function jsonl(rows: object[]): string {
	return rows.map((r) => JSON.stringify(r)).join('\n');
}

function assistant(text: string, tool_uses: string[] = []): object {
	const content: object[] = [];
	if (text) content.push({ type: 'text', text });
	for (const name of tool_uses) content.push({ type: 'tool_use', name, input: {} });
	return { type: 'assistant', message: { content } };
}

function user(text: string): object {
	return { type: 'user', message: { content: [{ type: 'text', text }] } };
}

describe('scoreTranscript — empty / trivial input', () => {
	test('empty string returns zero score', () => {
		const r = scoreTranscript('');
		assert.equal(r.score, 0);
		assert.equal(r.signals.volatile_state_claim, 0);
		assert.equal(r.signals.state_claim_no_verify, 0);
		assert.equal(r.signals.post_hoc_corrections, 0);
		assert.equal(r.turn_count, 0);
	});

	test('clean transcript with verified claims scores zero', () => {
		const content = jsonl([
			user('please check the file'),
			assistant('Checking now.', ['Read']),
			assistant('The file has 42 lines. Confirmed via Read.', ['Read'])
		]);
		const r = scoreTranscript(content);
		assert.equal(r.score, 0, `expected zero score, got ${r.score}`);
	});
});

describe('scoreTranscript — volatile_state_claim signal', () => {
	test('PID / restart-count / uptime / HTTP / ms each flag once per sentence in an unverified turn', () => {
		// Counted per sentence (not per pattern) so one fact-dense sentence
		// can't saturate the score — three sentences ⇒ three volatile claims.
		const content = jsonl([
			assistant('The process is pid 3194.', []),
			assistant('It restarted 27 → 28 times.', []),
			assistant('The endpoint answered HTTP 200 in 15 ms.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(
			r.signals.volatile_state_claim >= 3,
			`expected ≥3 volatile claims, got ${r.signals.volatile_state_claim}`
		);
		assert.ok(r.sample_claims.some((c) => c.kind === 'volatile_state_claim'));
	});

	test('volatile claims dominate the composite (heaviest weight)', () => {
		const content = jsonl([
			assistant('Reloaded: new pid 5086, uptime 4s. Then HTTP 200 in 12ms.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(r.score >= 30, `expected high score from volatile claims, got ${r.score}`);
	});

	test('volatile claim grounded by a same-turn Bash does NOT count', () => {
		const content = jsonl([
			user('restart and confirm'),
			assistant('pid 3194, restart count 27 → 28, online.', ['Bash'])
		]);
		const r = scoreTranscript(content);
		assert.equal(r.signals.volatile_state_claim, 0);
	});
});

describe('scoreTranscript — state_claim_no_verify signal', () => {
	test('test pass-count claimed without verification flags', () => {
		const content = jsonl([
			user('did the tests pass?'),
			assistant('All 51/51 tests passing, zero failures.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(
			r.signals.state_claim_no_verify >= 1,
			`expected ≥1 state claim, got ${r.signals.state_claim_no_verify}`
		);
	});

	test('file/line count with action verb flags', () => {
		const content = jsonl([
			assistant('I created 27 files and wrote ~180 lines across the change.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(r.signals.state_claim_no_verify >= 1);
	});

	test('commit SHA asserted as state flags', () => {
		const content = jsonl([
			user('what shipped today?'),
			assistant('The parser is in commit bebaec0; it contains the new walker.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(r.signals.state_claim_no_verify >= 1);
	});

	test('path asserted with a state verb flags', () => {
		const content = jsonl([
			assistant('The gate lives in src/lib/pipeline/runner.ts and has 86 lines.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(r.signals.state_claim_no_verify >= 1);
	});

	test('claims with same-turn Read do NOT count', () => {
		const content = jsonl([
			user('check git log'),
			assistant('Commit bebaec0 shipped the parser; the file has 42 lines.', ['Read'])
		]);
		const r = scoreTranscript(content);
		assert.equal(r.signals.state_claim_no_verify, 0);
		assert.equal(r.signals.volatile_state_claim, 0);
	});
});

describe('scoreTranscript — post_hoc_corrections signal', () => {
	test('genuine corrections are detected', () => {
		const content = jsonl([
			assistant('The answer is 5. Let me re-check that.', []),
			assistant('I was wrong before; scratch that.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(
			r.signals.post_hoc_corrections >= 3,
			`expected ≥3 corrections, got ${r.signals.post_hoc_corrections}`
		);
	});
});

describe('scoreTranscript — FALSE-POSITIVE regressions (the v1 failures)', () => {
	test('bare "actually" in explanatory prose does NOT flag', () => {
		const content = jsonl([
			assistant(
				'This is actually the cleaner approach, and it actually simplifies the design. ' +
					"Here's what's actually happening under the hood.",
				[]
			)
		]);
		const r = scoreTranscript(content);
		assert.equal(
			r.signals.post_hoc_corrections,
			0,
			`"actually" must not count as a correction (got ${r.signals.post_hoc_corrections})`
		);
		assert.equal(r.score, 0, `prose with "actually" should score 0, got ${r.score}`);
	});

	test('bare "wait" in a plan does NOT flag', () => {
		const content = jsonl([
			assistant('Task B depends on A, so wait for A to merge before dispatching B.', [])
		]);
		const r = scoreTranscript(content);
		assert.equal(r.signals.post_hoc_corrections, 0);
	});

	test('a file path inside a design plan (future tense) does NOT flag', () => {
		const content = jsonl([
			assistant('The auth layer will live in src/lib/auth.ts and we should add tests there.', [])
		]);
		const r = scoreTranscript(content);
		assert.equal(
			r.signals.state_claim_no_verify,
			0,
			`design reference must not count as a state claim (got ${r.signals.state_claim_no_verify})`
		);
	});

	test('paths inside a markdown table do NOT flag', () => {
		const table =
			'Here is the plan:\n' +
			'| Worker | Area | Files |\n' +
			'|---|---|---|\n' +
			'| w1 | Auth | src/lib/auth.ts, src/routes/api/auth/ |\n' +
			'| w2 | DB | src/lib/db/schema.ts |\n';
		const content = jsonl([assistant(table, [])]);
		const r = scoreTranscript(content);
		assert.equal(r.score, 0, `table-only turn should score 0, got ${r.score}`);
	});

	test('paths inside a fenced code block do NOT flag', () => {
		const fenced = 'Structure:\n```\nsrc/lib/pipeline/runner.ts\nsrc/lib/db/schema.ts\n```\n';
		const content = jsonl([assistant(fenced, [])]);
		const r = scoreTranscript(content);
		assert.equal(r.score, 0);
	});

	test('a commit SHA inside a URL does NOT flag (verifiable reference)', () => {
		const content = jsonl([
			assistant('The change is live at https://github.com/jneaimi/x/commit/6a6809e now.', [])
		]);
		const r = scoreTranscript(content);
		assert.equal(
			r.signals.state_claim_no_verify,
			0,
			`SHA in a URL must not count (got ${r.signals.state_claim_no_verify})`
		);
	});

	test('a planning-heavy session no longer scores high on "actually"', () => {
		// Mirrors the v1 id1318 failure: a design doc that scored 92 purely
		// because it said "actually" 164 times. v2 must score it ~0.
		const prose =
			'The feedback loop only works if you actually run it. ' +
			'Reserve Gemini for where imagery actually earns its keep. ' +
			"Here's what screenshot capability actually means. " +
			'Will Jasem actually use this for real work?';
		const content = jsonl([assistant(prose.repeat(20), [])]);
		const r = scoreTranscript(content);
		assert.ok(r.score < 20, `planning prose should score low, got ${r.score}`);
	});
});

describe('scoreTranscript — composite score caps', () => {
	test('score saturates at 100, never exceeds', () => {
		const noise =
			'pid 3194, restart 27 → 28, HTTP 200 in 15ms, uptime 9s. I was wrong; scratch that. ';
		const content = jsonl([assistant(noise.repeat(50), [])]);
		const r = scoreTranscript(content);
		assert.ok(r.score <= 100);
		assert.ok(r.score >= 80, `expected near-max score, got ${r.score}`);
	});
});

describe('scoreTranscript — session_id extraction', () => {
	test('reads sessionId from any JSONL row', () => {
		const content = jsonl([
			{ type: 'system', sessionId: 'abc-123', message: { content: '' } },
			assistant('hello', [])
		]);
		const r = scoreTranscript(content);
		assert.equal(r.session_id, 'abc-123');
	});

	test('null when no sessionId present', () => {
		const r = scoreTranscript(jsonl([assistant('hi', [])]));
		assert.equal(r.session_id, null);
	});
});

describe('extractLinkedProjects', () => {
	test('finds vault project paths', () => {
		const content = JSON.stringify({
			text: 'see ~/vault/projects/naseej/index.md and /Users/jneaimi/vault/projects/project-phases/adr-001.md'
		});
		const slugs = extractLinkedProjects(content);
		assert.deepEqual(slugs, ['naseej', 'project-phases']);
	});

	test('finds API URLs', () => {
		const content = '"GET /api/vault/projects/soul-hub-whatsapp/falsifiers"';
		assert.deepEqual(extractLinkedProjects(content), ['soul-hub-whatsapp']);
	});

	test('finds projectShipSlice tool args', () => {
		const content = '{"name":"projectShipSlice","input":{"project_slug":"naseej","slice":"S1"}}';
		assert.deepEqual(extractLinkedProjects(content), ['naseej']);
	});

	test('dedupes across sources', () => {
		const content =
			'~/vault/projects/naseej/ and /api/vault/projects/naseej/ and "project_slug":"naseej"';
		assert.deepEqual(extractLinkedProjects(content), ['naseej']);
	});

	test('filters non-project tokens', () => {
		const content = '~/vault/projects/index/ and ~/vault/projects/inbox/x.md';
		assert.deepEqual(extractLinkedProjects(content), []);
	});

	test('empty input returns empty array', () => {
		assert.deepEqual(extractLinkedProjects(''), []);
	});
});

describe('F1 spot-check — frozen fixture from 2026-05-17 soul-hub session', () => {
	test('fixture file exists', () => {
		assert.ok(existsSync(FIXTURE_PATH), `fixture missing: ${FIXTURE_PATH}`);
	});

	test('fixture transcript parses cleanly (no crash on real data)', () => {
		const content = readFileSync(FIXTURE_PATH, 'utf8');
		const r = scoreTranscript(content);
		assert.ok(r.turn_count > 100, `expected substantial turn count, got ${r.turn_count}`);
		assert.ok(r.session_id !== null, 'expected session_id from real transcript');
	});

	test('extractLinkedProjects finds real project slugs in fixture', () => {
		const content = readFileSync(FIXTURE_PATH, 'utf8');
		const slugs = extractLinkedProjects(content);
		assert.ok(slugs.length > 0, `expected ≥1 linked project, got ${slugs.length}`);
	});
});
