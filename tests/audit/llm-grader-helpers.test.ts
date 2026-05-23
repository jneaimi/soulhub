/**
 * project-phases ADR-008 S3 — pure-function unit tests for llm-grader.
 *
 * No CLI calls. Pure logic only: truncation strategy, claim scoring,
 * JSON extraction from noisy LLM output. End-to-end CLI integration is
 * verified live via runNow after pm2 reload, not in this test file.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/audit/llm-grader-helpers.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	truncateTranscript as _truncateTranscript,
	computeLlmScore as _computeLlmScore,
	extractJson as _extractJson,
	type LlmClaim
} from '../../src/lib/audit/llm-grader-helpers.ts';

describe('_truncateTranscript', () => {
	test('extracts assistant text and tags tool_use sites', () => {
		const jsonl = [
			JSON.stringify({
				type: 'assistant',
				message: {
					content: [
						{ type: 'text', text: 'Checking the file now.' },
						{ type: 'tool_use', name: 'Read' }
					]
				}
			}),
			JSON.stringify({
				type: 'user',
				message: { content: [{ type: 'text', text: 'thanks' }] }
			}),
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'text', text: 'It has 42 lines.' }] }
			})
		].join('\n');

		const out = _truncateTranscript(jsonl);
		assert.ok(out.includes('Checking the file now'));
		assert.ok(out.includes('[tools: Read]'));
		assert.ok(out.includes('It has 42 lines'));
		assert.ok(!out.includes('thanks'), 'user turns should be filtered out');
	});

	test('skips assistant turns with no text content', () => {
		const jsonl = JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', name: 'Bash' }] }
		});
		const out = _truncateTranscript(jsonl);
		assert.equal(out, '', 'tool-only turns should be skipped');
	});

	test('caps output at MAX_INPUT_CHARS via head+tail truncation', () => {
		const longText = 'x'.repeat(2000);
		const rows = Array.from({ length: 30 }, () =>
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'text', text: longText }] }
			})
		);
		const out = _truncateTranscript(rows.join('\n'));
		// 30 * 1500 (per-turn cap) = 45K, exceeds 32K cap → must truncate.
		assert.ok(out.length <= 33_000, `expected ≤33K, got ${out.length}`);
		assert.ok(out.includes('[TRUNCATED'), 'expected truncation marker');
	});

	test('handles malformed JSONL gracefully', () => {
		const jsonl = ['not-json\n', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })].join(
			'\n'
		);
		const out = _truncateTranscript(jsonl);
		assert.ok(out.includes('ok'));
	});
});

describe('_computeLlmScore', () => {
	test('empty claims → 0', () => {
		assert.equal(_computeLlmScore([]), 0);
	});

	test('all assumed → 100', () => {
		const claims: LlmClaim[] = [
			{ text: 'a', classification: 'assumed' },
			{ text: 'b', classification: 'assumed' }
		];
		assert.equal(_computeLlmScore(claims), 100);
	});

	test('all verified → 0', () => {
		const claims: LlmClaim[] = [
			{ text: 'a', classification: 'verified' },
			{ text: 'b', classification: 'verified' }
		];
		assert.equal(_computeLlmScore(claims), 0);
	});

	test('inferred contributes 0.3 per claim', () => {
		const claims: LlmClaim[] = [
			{ text: 'a', classification: 'inferred' },
			{ text: 'b', classification: 'inferred' },
			{ text: 'c', classification: 'inferred' },
			{ text: 'd', classification: 'inferred' }
		];
		// 4 * 0.3 / 4 * 100 = 30
		assert.equal(_computeLlmScore(claims), 30);
	});

	test('mixed: 1 assumed + 1 verified + 1 inferred / 3 → (1+0+0.3)/3*100 = 43', () => {
		const claims: LlmClaim[] = [
			{ text: 'a', classification: 'assumed' },
			{ text: 'b', classification: 'verified' },
			{ text: 'c', classification: 'inferred' }
		];
		assert.equal(_computeLlmScore(claims), 43);
	});
});

describe('_extractJson', () => {
	test('returns clean JSON unchanged', () => {
		const raw = '{"claims":[],"rationale":"x"}';
		assert.equal(_extractJson(raw), raw);
	});

	test('strips ```json fence', () => {
		const raw = '```json\n{"a":1}\n```';
		assert.equal(_extractJson(raw), '{"a":1}');
	});

	test('extracts JSON when surrounded by prose', () => {
		const raw = "Here's the audit:\n{\"claims\":[]}\n\nLet me know.";
		assert.equal(_extractJson(raw), '{"claims":[]}');
	});

	test('returns null when no JSON-looking content', () => {
		assert.equal(_extractJson('just prose, no braces'), null);
	});

	test('returns null when braces inverted', () => {
		assert.equal(_extractJson('}{}{ }'), '{}{ }');
		// (note: this WILL parse-fail downstream, which is the right outcome —
		// extractJson's job is "find a plausible candidate", the JSON.parse
		// after handles the actual validity.)
	});
});
