/** Unit tests for the body validator behind
 *  `POST /api/agents/runs/[runId]/approve-budget` (O3 D1). The endpoint is a
 *  thin wiring layer; the validation rules live in a pure helper so the
 *  contract is unit-testable without spinning up SvelteKit / the DB / Telegram. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	MAX_BUMP_TURNS,
	MAX_BUMP_USD,
	MAX_REASON_LEN,
	parseApproveBudgetBody,
} from '../../src/lib/agents/approve-budget-body.ts';

describe('parseApproveBudgetBody — happy paths', () => {
	test('resume with +$5', () => {
		const r = parseApproveBudgetBody({ addUsd: 5 });
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.value.stop, false);
			assert.equal(r.value.addUsd, 5);
			assert.equal(r.value.addTurns, 0);
			assert.equal(r.value.reason, undefined);
		}
	});

	test('resume with +10 turns', () => {
		const r = parseApproveBudgetBody({ addTurns: 10 });
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.value.addUsd, 0);
			assert.equal(r.value.addTurns, 10);
		}
	});

	test('resume with both addUsd and addTurns', () => {
		const r = parseApproveBudgetBody({ addUsd: 2, addTurns: 5 });
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.value.addUsd, 2);
			assert.equal(r.value.addTurns, 5);
		}
	});

	test('stop without reason', () => {
		const r = parseApproveBudgetBody({ stop: true });
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.value.stop, true);
			assert.equal(r.value.reason, undefined);
		}
	});

	test('stop with reason', () => {
		const r = parseApproveBudgetBody({ stop: true, reason: 'looped on the same edit' });
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.value.stop, true);
			assert.equal(r.value.reason, 'looped on the same edit');
		}
	});

	test('reason is trimmed', () => {
		const r = parseApproveBudgetBody({ stop: true, reason: '   spaces around   ' });
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.value.reason, 'spaces around');
	});

	test('reason longer than MAX_REASON_LEN gets truncated', () => {
		const long = 'x'.repeat(MAX_REASON_LEN + 100);
		const r = parseApproveBudgetBody({ stop: true, reason: long });
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.value.reason?.length, MAX_REASON_LEN);
	});

	test('empty-string reason → undefined (no audit clutter)', () => {
		const r = parseApproveBudgetBody({ stop: true, reason: '' });
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.value.reason, undefined);
	});

	test('whitespace-only reason → undefined', () => {
		const r = parseApproveBudgetBody({ stop: true, reason: '   \n  ' });
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.value.reason, undefined);
	});

	test('non-string reason ignored, not an error', () => {
		const r = parseApproveBudgetBody({ stop: true, reason: 123 });
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.value.reason, undefined);
	});

	test('stop:true wins even with zero bumps (no "must be > 0" trap)', () => {
		const r = parseApproveBudgetBody({ stop: true, addUsd: 0, addTurns: 0 });
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.value.stop, true);
	});

	test('resume at the exact MAX_BUMP_USD cap', () => {
		const r = parseApproveBudgetBody({ addUsd: MAX_BUMP_USD });
		assert.equal(r.ok, true);
	});

	test('resume at the exact MAX_BUMP_TURNS cap', () => {
		const r = parseApproveBudgetBody({ addTurns: MAX_BUMP_TURNS });
		assert.equal(r.ok, true);
	});
});

describe('parseApproveBudgetBody — sad paths', () => {
	test('null body', () => {
		const r = parseApproveBudgetBody(null);
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /JSON object/);
	});

	test('non-object body', () => {
		const r = parseApproveBudgetBody('hi');
		assert.equal(r.ok, false);
	});

	test('empty body — neither stop nor bump', () => {
		const r = parseApproveBudgetBody({});
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /At least one of addUsd or addTurns must be > 0/);
	});

	test('both bumps zero, no stop', () => {
		const r = parseApproveBudgetBody({ addUsd: 0, addTurns: 0 });
		assert.equal(r.ok, false);
	});

	test('negative addUsd', () => {
		const r = parseApproveBudgetBody({ addUsd: -1 });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /non-negative/);
	});

	test('negative addTurns', () => {
		const r = parseApproveBudgetBody({ addTurns: -5 });
		assert.equal(r.ok, false);
	});

	test('addUsd over cap', () => {
		const r = parseApproveBudgetBody({ addUsd: MAX_BUMP_USD + 1 });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /per-call cap/);
	});

	test('addTurns over cap', () => {
		const r = parseApproveBudgetBody({ addTurns: MAX_BUMP_TURNS + 1 });
		assert.equal(r.ok, false);
	});

	test('NaN addUsd', () => {
		const r = parseApproveBudgetBody({ addUsd: Number.NaN });
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /finite/);
	});

	test('stop:false is treated as not-stop (matches strict equality)', () => {
		// stop:false + no bumps → still an error because stop is not true
		const r = parseApproveBudgetBody({ stop: false });
		assert.equal(r.ok, false);
	});

	test('stop:"true" string is NOT a valid stop signal', () => {
		// We only accept the literal boolean true. This guards against query-
		// string-style bodies leaking into the JSON path.
		const r = parseApproveBudgetBody({ stop: 'true' });
		assert.equal(r.ok, false);
	});
});
