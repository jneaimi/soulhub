/** Unit tests for `classifyVelocity` — the pure spend-trajectory classifier
 *  used by the Smart Telegram (O3 D2) budget-approval message. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyVelocity } from '../../src/lib/agents/budget-velocity.ts';

describe('classifyVelocity — near-ceiling classes win first', () => {
	test('exact-ceiling spend → near-ceiling-spend', () => {
		const r = classifyVelocity({
			spentUsd: 5.0,
			ceilingUsd: 5.0,
			turns: 12,
			ceilingTurns: 50,
		});
		assert.equal(r.klass, 'near-ceiling-spend');
		assert.match(r.text, /Near the \$ ceiling/);
		assert.match(r.text, /100%/);
	});

	test('95% spend → near-ceiling-spend (boundary)', () => {
		const r = classifyVelocity({
			spentUsd: 4.75,
			ceilingUsd: 5.0,
			turns: 12,
			ceilingTurns: 50,
		});
		assert.equal(r.klass, 'near-ceiling-spend');
	});

	test('94% spend → NOT near-ceiling-spend (below threshold)', () => {
		const r = classifyVelocity({
			spentUsd: 4.7,
			ceilingUsd: 5.0,
			turns: 12,
			ceilingTurns: 50,
		});
		assert.notEqual(r.klass, 'near-ceiling-spend');
	});

	test('exact-ceiling turns → near-ceiling-turns', () => {
		const r = classifyVelocity({
			spentUsd: 1.0,
			ceilingUsd: 5.0,
			turns: 50,
			ceilingTurns: 50,
		});
		assert.equal(r.klass, 'near-ceiling-turns');
		assert.match(r.text, /50\/50/);
	});

	test('spend ceiling beats turn ceiling when both hit', () => {
		// Both conditions met — spend is checked first; that's the documented
		// ordering. The Telegram message only shows one note.
		const r = classifyVelocity({
			spentUsd: 5.0,
			ceilingUsd: 5.0,
			turns: 50,
			ceilingTurns: 50,
		});
		assert.equal(r.klass, 'near-ceiling-spend');
	});
});

describe('classifyVelocity — high-cost-per-turn', () => {
	test('last turn > 2× average → high-cost-per-turn', () => {
		// 10 turns at $0.10 avg, last turn was $0.50 (5× the avg)
		const r = classifyVelocity({
			spentUsd: 1.0,
			ceilingUsd: 5.0,
			turns: 10,
			ceilingTurns: 50,
			lastTurnSpend: 0.5,
		});
		assert.equal(r.klass, 'high-cost-per-turn');
		assert.match(r.text, /Last turn burned \$0\.50/);
		assert.match(r.text, /avg \$0\.10/);
	});

	test('last turn at exact 2× avg → NOT high-cost (strict >)', () => {
		const r = classifyVelocity({
			spentUsd: 1.0,
			ceilingUsd: 5.0,
			turns: 10,
			ceilingTurns: 50,
			lastTurnSpend: 0.2,
		});
		assert.notEqual(r.klass, 'high-cost-per-turn');
	});

	test('lastTurnSpend not provided → steady (no jump signal)', () => {
		const r = classifyVelocity({
			spentUsd: 1.0,
			ceilingUsd: 5.0,
			turns: 10,
			ceilingTurns: 50,
		});
		assert.equal(r.klass, 'steady');
	});

	test('only 1 turn so far → ignores lastTurnSpend signal', () => {
		// Avoids dividing by zero / single-turn false positives — we need
		// some history before "this turn was abnormal" is a coherent signal.
		const r = classifyVelocity({
			spentUsd: 0.5,
			ceilingUsd: 5.0,
			turns: 1,
			ceilingTurns: 50,
			lastTurnSpend: 0.5,
		});
		assert.equal(r.klass, 'steady');
	});
});

describe('classifyVelocity — steady fallback', () => {
	test('mid-run, normal cadence → steady', () => {
		const r = classifyVelocity({
			spentUsd: 1.5,
			ceilingUsd: 5.0,
			turns: 15,
			ceilingTurns: 50,
		});
		assert.equal(r.klass, 'steady');
		assert.match(r.text, /Steady/);
		assert.match(r.text, /\$0\.10\/turn/);
	});

	test('barely-started run → steady', () => {
		const r = classifyVelocity({
			spentUsd: 0.05,
			ceilingUsd: 5.0,
			turns: 2,
			ceilingTurns: 50,
		});
		assert.equal(r.klass, 'steady');
	});
});

describe('classifyVelocity — defensive math', () => {
	test('ceilingUsd = 0 does not divide-by-zero', () => {
		const r = classifyVelocity({
			spentUsd: 1.0,
			ceilingUsd: 0,
			turns: 5,
			ceilingTurns: 50,
		});
		// With safeCeilingUsd=1, spendPct = 1.0 → near-ceiling-spend triggers.
		// We don't care which klass; we care the call doesn't crash.
		assert.ok(['near-ceiling-spend', 'steady'].includes(r.klass));
		assert.equal(typeof r.text, 'string');
	});

	test('ceilingTurns = 0 does not divide-by-zero', () => {
		const r = classifyVelocity({
			spentUsd: 0.5,
			ceilingUsd: 5.0,
			turns: 5,
			ceilingTurns: 0,
		});
		assert.equal(typeof r.text, 'string');
	});

	test('turns = 0 does not divide-by-zero in steady cost-per-turn', () => {
		const r = classifyVelocity({
			spentUsd: 0,
			ceilingUsd: 5.0,
			turns: 0,
			ceilingTurns: 50,
		});
		assert.equal(r.klass, 'steady');
		// Math.max(turns, 1) keeps the per-turn divisor safe
		assert.match(r.text, /\$0\.00\/turn/);
	});
});
