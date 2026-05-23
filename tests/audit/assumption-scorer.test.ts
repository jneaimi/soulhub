/**
 * project-phases ADR-008 S1 — assumption-scorer + extractLinkedProjects tests.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/audit/assumption-scorer.test.ts
 *
 * Layer A unit tests use synthetic mini-transcripts so each signal is
 * exercised in isolation. The F1 spot-check runs the scorer against the
 * frozen fixture at `tests/fixtures/adr-008-known-failures.jsonl` and
 * asserts a high-score result (per ADR-008 F1).
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
		assert.equal(r.signals.hedge, 0);
		assert.equal(r.signals.claim_no_verify, 0);
		assert.equal(r.signals.post_hoc_corrections, 0);
		assert.equal(r.turn_count, 0);
	});

	test('clean transcript with verified claims scores low', () => {
		const content = jsonl([
			user('please check the file'),
			assistant('Checking now.', ['Read']),
			assistant('The file has 42 lines. Confirmed via Read.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(r.score < 20, `expected low score, got ${r.score}`);
	});
});

describe('scoreTranscript — hedge signal', () => {
	test('hedge phrases near tool_use are counted', () => {
		const content = jsonl([
			assistant('I think this is right. Let me probably check.', ['Bash']),
			assistant('It should be the case that the file exists.', ['Read'])
		]);
		const r = scoreTranscript(content);
		assert.ok(r.signals.hedge >= 3, `expected ≥3 hedges, got ${r.signals.hedge}`);
		assert.ok(r.sample_claims.some((c) => c.kind === 'hedge'));
	});

	test('hedge phrases without tool_use in the turn do NOT count', () => {
		const content = jsonl([assistant('I think this is right. Probably.', [])]);
		const r = scoreTranscript(content);
		assert.equal(r.signals.hedge, 0);
	});
});

describe('scoreTranscript — post-hoc correction signal', () => {
	test('"wait" / "actually" / "I was wrong" all detected', () => {
		const content = jsonl([
			assistant('The answer is 5. Wait, let me re-check that.', []),
			assistant('Actually it is 7, I was wrong before.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(
			r.signals.post_hoc_corrections >= 3,
			`expected ≥3 corrections, got ${r.signals.post_hoc_corrections}`
		);
	});

	test('post-hoc phrases contribute heavily to composite score', () => {
		const content = jsonl([
			assistant('Wait, I was wrong. Let me re-check. Actually, scratch that.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(r.score >= 40, `expected score ≥40 from corrections alone, got ${r.score}`);
	});
});

describe('scoreTranscript — claim_no_verify signal', () => {
	test('commit SHA in assistant text without prior Read flags', () => {
		const content = jsonl([
			user('what shipped today?'),
			assistant('Commit bebaec0 shipped the parser. Also 2ee9270 and 0c14ae6.', [])
		]);
		const r = scoreTranscript(content);
		assert.ok(
			r.signals.claim_no_verify >= 1,
			`expected ≥1 unverified claim, got ${r.signals.claim_no_verify}`
		);
	});

	test('claims with same-turn Read do NOT count as unverified', () => {
		const content = jsonl([
			user('check git log'),
			assistant('Commit bebaec0 shipped the parser.', ['Bash'])
		]);
		const r = scoreTranscript(content);
		assert.equal(r.signals.claim_no_verify, 0);
	});
});

describe('scoreTranscript — composite score caps', () => {
	test('score saturates at 100, never exceeds', () => {
		const noise = 'Wait, actually, I was wrong. Let me re-check. ';
		const content = jsonl([assistant(noise.repeat(50), [])]);
		const r = scoreTranscript(content);
		assert.ok(r.score <= 100);
		assert.ok(r.score >= 60, `expected high score, got ${r.score}`);
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

	test('scorer flags fixture as high-score (≥40) per ADR-008 F1', () => {
		const content = readFileSync(FIXTURE_PATH, 'utf8');
		const r = scoreTranscript(content);
		// F1 says "flags ≥4 high-score claims". A score ≥40 + multiple
		// sample_claims means the scorer surfaced enough signal that the
		// operator-facing panel would render this audit as worth reviewing.
		assert.ok(r.score >= 40, `expected fixture score ≥40, got ${r.score}`);
		assert.ok(
			r.sample_claims.length >= 4,
			`expected ≥4 sample claims, got ${r.sample_claims.length}`
		);
	});

	test('fixture surfaces multiple post-hoc corrections (the F1 smoking-gun signal)', () => {
		const content = readFileSync(FIXTURE_PATH, 'utf8');
		const r = scoreTranscript(content);
		// Post-hoc corrections are the strongest assumption-failure indicator
		// per ADR-008 D2: "AI admitting drift after the fact".
		assert.ok(
			r.signals.post_hoc_corrections >= 2,
			`expected ≥2 post-hoc corrections, got ${r.signals.post_hoc_corrections}`
		);
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
		// The fixture is a soul-hub session from 2026-05-17 — should mention
		// at least one cluster project (soul-hub-whatsapp / naseej / project-phases).
		assert.ok(slugs.length > 0, `expected ≥1 linked project, got ${slugs.length}`);
	});
});
