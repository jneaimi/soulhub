/**
 * project-phases ADR-005 S4 — pure tests for the propose-* tool-level
 * rate limiter (5/hour per actor, layered above ADR-046's 50/hr chokepoint).
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/propose-rate-limit.test.ts
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
	checkProposeRate,
	peekProposeRate,
	getProposeRateState,
	__resetProposeRateLimitForTests,
} from '../../src/lib/projects/propose-rate-limit.ts';

const T0 = Date.parse('2026-05-17T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

describe('checkProposeRate', () => {
	beforeEach(() => {
		__resetProposeRateLimitForTests();
	});

	test('first 5 proposals from an actor are allowed', () => {
		for (let i = 1; i <= 5; i++) {
			const r = checkProposeRate('proposeAdr', T0 + i * 1000);
			assert.equal(r.allowed, true, `attempt ${i} should be allowed`);
			assert.equal(r.remaining, 5 - i, `remaining after attempt ${i}`);
			assert.equal(r.ceiling, 5);
		}
	});

	test('6th proposal from same actor inside the hour is refused', () => {
		for (let i = 1; i <= 5; i++) checkProposeRate('proposeAdr', T0 + i * 1000);
		const r = checkProposeRate('proposeAdr', T0 + 6000);
		assert.equal(r.allowed, false);
		assert.equal(r.remaining, 0);
		assert.equal(r.ceiling, 5);
	});

	test('refusal includes a resetAt within the next hour', () => {
		for (let i = 1; i <= 5; i++) checkProposeRate('proposeAdr', T0 + i * 1000);
		const r = checkProposeRate('proposeAdr', T0 + 6000);
		const resetMs = Date.parse(r.resetAt);
		// Window started at T0+1000, so resets ~T0 + 1000 + HOUR_MS.
		assert.ok(resetMs > T0 + 6000);
		assert.ok(resetMs <= T0 + HOUR_MS + 2000);
	});

	test('rate limit is per-actor — different actors get independent budgets', () => {
		for (let i = 1; i <= 5; i++) checkProposeRate('proposeAdr', T0 + i * 1000);
		const r1 = checkProposeRate('proposeAdr', T0 + 6000);
		assert.equal(r1.allowed, false, 'proposeAdr should be at ceiling');
		const r2 = checkProposeRate('proposeSlice', T0 + 6000);
		assert.equal(r2.allowed, true, 'proposeSlice has its own budget');
		const r3 = checkProposeRate('suggestAdrEdit', T0 + 6000);
		assert.equal(r3.allowed, true, 'suggestAdrEdit has its own budget');
	});

	test('window expires after 1 hour — fresh budget on next call', () => {
		for (let i = 1; i <= 5; i++) checkProposeRate('proposeAdr', T0 + i * 1000);
		// One nanosecond before the window expires: still refused.
		const justBefore = checkProposeRate('proposeAdr', T0 + 1000 + HOUR_MS - 1);
		assert.equal(justBefore.allowed, false);
		// One ms past the window: fresh budget.
		const justAfter = checkProposeRate('proposeAdr', T0 + 1000 + HOUR_MS + 1);
		assert.equal(justAfter.allowed, true);
		assert.equal(justAfter.remaining, 4); // 5 - 1 just-incremented
	});

	test('refused attempts do NOT bump the counter (no penalty for asking)', () => {
		for (let i = 1; i <= 5; i++) checkProposeRate('proposeAdr', T0 + i * 1000);
		// 5 refusals in a row — none should push the counter further.
		for (let i = 0; i < 5; i++) {
			const r = checkProposeRate('proposeAdr', T0 + 6000 + i);
			assert.equal(r.allowed, false);
		}
		// After window expires, fresh budget is still a FULL 5.
		const fresh = checkProposeRate('proposeAdr', T0 + 1000 + HOUR_MS + 1);
		assert.equal(fresh.allowed, true);
		assert.equal(fresh.remaining, 4);
	});
});

describe('peekProposeRate', () => {
	beforeEach(() => {
		__resetProposeRateLimitForTests();
	});

	test('does NOT bump the counter', () => {
		for (let i = 0; i < 10; i++) peekProposeRate('proposeAdr', T0);
		// Even after 10 peeks, the first real check should still be #1 of 5.
		const r = checkProposeRate('proposeAdr', T0 + 1000);
		assert.equal(r.allowed, true);
		assert.equal(r.remaining, 4);
	});

	test('reflects current bucket state without mutation', () => {
		for (let i = 1; i <= 3; i++) checkProposeRate('proposeAdr', T0 + i * 1000);
		const peek = peekProposeRate('proposeAdr', T0 + 4000);
		assert.equal(peek.allowed, true);
		assert.equal(peek.remaining, 2);
	});

	test('reports allowed=false when at ceiling', () => {
		for (let i = 1; i <= 5; i++) checkProposeRate('proposeAdr', T0 + i * 1000);
		const peek = peekProposeRate('proposeAdr', T0 + 6000);
		assert.equal(peek.allowed, false);
		assert.equal(peek.remaining, 0);
	});
});

describe('getProposeRateState', () => {
	beforeEach(() => {
		__resetProposeRateLimitForTests();
	});

	test('returns empty when no buckets exist', () => {
		assert.deepEqual(getProposeRateState(T0), []);
	});

	test('returns one entry per active actor, sorted by count DESC', () => {
		checkProposeRate('proposeAdr', T0 + 1000);
		checkProposeRate('proposeAdr', T0 + 2000);
		checkProposeRate('proposeSlice', T0 + 3000);
		checkProposeRate('proposeSlice', T0 + 4000);
		checkProposeRate('proposeSlice', T0 + 5000);
		checkProposeRate('suggestAdrEdit', T0 + 6000);

		const state = getProposeRateState(T0 + 7000);
		assert.equal(state.length, 3);
		// proposeSlice should be first (count=3), then proposeAdr (count=2),
		// then suggestAdrEdit (count=1).
		assert.equal(state[0].actor, 'proposeSlice');
		assert.equal(state[0].count, 3);
		assert.equal(state[1].actor, 'proposeAdr');
		assert.equal(state[1].count, 2);
		assert.equal(state[2].actor, 'suggestAdrEdit');
		assert.equal(state[2].count, 1);
	});

	test('omits actors whose windows have expired', () => {
		checkProposeRate('proposeAdr', T0 + 1000);
		const state = getProposeRateState(T0 + 1000 + HOUR_MS + 1);
		assert.deepEqual(state, []);
	});
});
