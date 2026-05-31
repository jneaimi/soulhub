/** Unit tests for `extractRecentTurns` — the pure last-N main-thread turn
 *  projector used by the Smart Telegram (O3 D2) transcript excerpt. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractRecentTurns } from '../../src/lib/sessions/recent-turns.ts';
import type { ClaudeEvent } from '../../src/lib/sessions/types.ts';

function userEvt(text: string, ts?: string): ClaudeEvent {
	return {
		type: 'user',
		message: { role: 'user', content: text },
		...(ts ? { timestamp: ts } : {}),
	};
}

function assistantEvt(text: string, ts?: string): ClaudeEvent {
	return {
		type: 'assistant',
		message: {
			role: 'assistant',
			content: [{ type: 'text', text }],
		},
		...(ts ? { timestamp: ts } : {}),
	};
}

function assistantToolEvt(toolName: string): ClaudeEvent {
	return {
		type: 'assistant',
		message: {
			role: 'assistant',
			content: [{ type: 'tool_use', name: toolName, id: 'tu_1', input: {} }],
		},
	};
}

describe('extractRecentTurns — happy paths', () => {
	test('empty events → empty array', () => {
		assert.deepEqual(extractRecentTurns([]), []);
	});

	test('single user turn returned', () => {
		const r = extractRecentTurns([userEvt('hello')]);
		assert.equal(r.length, 1);
		assert.equal(r[0].role, 'user');
		assert.equal(r[0].text, 'hello');
	});

	test('default limit is 3', () => {
		const events = [
			userEvt('1'),
			assistantEvt('2'),
			userEvt('3'),
			assistantEvt('4'),
			userEvt('5'),
		];
		const r = extractRecentTurns(events);
		assert.equal(r.length, 3);
		assert.deepEqual(
			r.map((t) => t.text),
			['3', '4', '5'],
		);
	});

	test('custom limit honored', () => {
		const events = [userEvt('1'), assistantEvt('2'), userEvt('3')];
		const r = extractRecentTurns(events, { limit: 2 });
		assert.equal(r.length, 2);
		assert.deepEqual(
			r.map((t) => t.text),
			['2', '3'],
		);
	});

	test('order preserved (oldest-first within the window)', () => {
		const events = [userEvt('a'), assistantEvt('b'), userEvt('c'), assistantEvt('d')];
		const r = extractRecentTurns(events, { limit: 4 });
		assert.deepEqual(
			r.map((t) => t.text),
			['a', 'b', 'c', 'd'],
		);
	});

	test('timestamps forwarded when present', () => {
		const r = extractRecentTurns([userEvt('hi', '2026-05-29T10:00:00Z')]);
		assert.equal(r[0].timestamp, '2026-05-29T10:00:00Z');
	});

	test('missing timestamp → field omitted (not null/undefined explicitly set)', () => {
		const r = extractRecentTurns([userEvt('hi')]);
		assert.equal(Object.prototype.hasOwnProperty.call(r[0], 'timestamp'), false);
	});
});

describe('extractRecentTurns — sidechain + filtering', () => {
	test('sidechain events skipped (sub-agent noise filtered out)', () => {
		const events: ClaudeEvent[] = [
			userEvt('main 1'),
			{ ...assistantEvt('sidechain noise'), isSidechain: true },
			assistantEvt('main 2'),
		];
		const r = extractRecentTurns(events);
		assert.deepEqual(
			r.map((t) => t.text),
			['main 1', 'main 2'],
		);
	});

	test('non-user/assistant events skipped (system, hook, etc.)', () => {
		const events: ClaudeEvent[] = [
			userEvt('hi'),
			{ type: 'system', message: { role: 'user', content: 'noise' } },
			{ type: 'file-history-snapshot', message: { role: 'user', content: 'snap' } },
			assistantEvt('ok'),
		];
		const r = extractRecentTurns(events);
		assert.deepEqual(
			r.map((t) => t.text),
			['hi', 'ok'],
		);
	});

	test('empty-text events skipped (nothing to show)', () => {
		const events: ClaudeEvent[] = [
			userEvt('real msg'),
			assistantEvt(''),
			assistantEvt('   '),
			assistantEvt('actual reply'),
		];
		const r = extractRecentTurns(events);
		assert.deepEqual(
			r.map((t) => t.text),
			['real msg', 'actual reply'],
		);
	});
});

describe('extractRecentTurns — content projection', () => {
	test('tool_use blocks summarised as [tool: name]', () => {
		const r = extractRecentTurns([assistantToolEvt('Read')]);
		assert.equal(r[0].text, '[tool: Read]');
	});

	test('mixed text + tool_use blocks joined with newline', () => {
		const events: ClaudeEvent[] = [
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Reading file' },
						{ type: 'tool_use', name: 'Read', id: 'tu_1', input: {} },
					],
				},
			},
		];
		const r = extractRecentTurns(events);
		assert.equal(r[0].text, 'Reading file\n[tool: Read]');
	});

	test('tool_result blocks intentionally skipped (too noisy for excerpt)', () => {
		const events: ClaudeEvent[] = [
			{
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'tu_1', content: 'huge JSON blob' },
					],
				},
			},
			assistantEvt('summary'),
		];
		const r = extractRecentTurns(events);
		// The user event has only tool_result content → empty after projection → skipped.
		assert.deepEqual(
			r.map((t) => t.text),
			['summary'],
		);
	});

	test('per-turn cap truncates with ellipsis', () => {
		const long = 'x'.repeat(1000);
		const r = extractRecentTurns([assistantEvt(long)], { perTurnMaxChars: 50 });
		assert.equal(r[0].text.length, 50);
		assert.ok(r[0].text.endsWith('…'));
	});

	test('text under cap not modified', () => {
		const r = extractRecentTurns([assistantEvt('short')], { perTurnMaxChars: 100 });
		assert.equal(r[0].text, 'short');
	});
});

describe('extractRecentTurns — edge cases', () => {
	test('limit: 0 → empty array', () => {
		assert.deepEqual(extractRecentTurns([userEvt('hi')], { limit: 0 }), []);
	});

	test('negative limit → empty array (defensive)', () => {
		assert.deepEqual(extractRecentTurns([userEvt('hi')], { limit: -1 }), []);
	});

	test('string content (legacy event shape) handled', () => {
		const r = extractRecentTurns([userEvt('hello')]);
		assert.equal(r[0].text, 'hello');
	});

	test('array content with no text/tool_use blocks → skipped', () => {
		const events: ClaudeEvent[] = [
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [{ type: 'thinking', text: 'internal' }],
				},
			},
			assistantEvt('visible'),
		];
		// `thinking` blocks aren't projected (intentional — they're not text the
		// operator should see in a one-line excerpt).
		const r = extractRecentTurns(events);
		assert.deepEqual(
			r.map((t) => t.text),
			['visible'],
		);
	});
});
