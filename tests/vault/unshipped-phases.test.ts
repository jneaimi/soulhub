/**
 * #62 (2026-05-30) — unit tests for `unshippedPhases()`.
 *
 * Sister to `phased-adr-fields.test.ts` (validator) and `activePhase`
 * (derived state). This helper feeds the structured warning shape both
 * the CLI smart-ship guard and the UI ship-merge endpoint return.
 *
 * Run with:
 *   node --test --experimental-strip-types tests/vault/unshipped-phases.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unshippedPhases } from '../../src/lib/vault/phases.ts';

test('phases absent → all arrays empty (single-shot ADR, guard no-op)', () => {
	const r = unshippedPhases({ type: 'decision', created: '2026-05-29', tags: [] } as never);
	assert.deepEqual(r, { phases: [], shippedPhases: [], unshippedPhases: [] });
});

test('phases absent + shipped_phases ignored', () => {
	const r = unshippedPhases({
		type: 'decision',
		created: '2026-05-29',
		tags: [],
		shipped_phases: ['D1'],
	} as never);
	assert.deepEqual(r, { phases: [], shippedPhases: [], unshippedPhases: [] });
});

test('phases declared, no shipped_phases → all phases unshipped', () => {
	const r = unshippedPhases({
		type: 'decision',
		created: '2026-05-29',
		tags: [],
		phases: ['D1', 'D2', 'D3'],
	} as never);
	assert.deepEqual(r, {
		phases: ['D1', 'D2', 'D3'],
		shippedPhases: [],
		unshippedPhases: ['D1', 'D2', 'D3'],
	});
});

test('partial ship → only unshipped reported', () => {
	const r = unshippedPhases({
		type: 'decision',
		created: '2026-05-29',
		tags: [],
		phases: ['D1', 'D2', 'D3', 'D4'],
		shipped_phases: ['D1', 'D2'],
	} as never);
	assert.deepEqual(r.unshippedPhases, ['D3', 'D4']);
	assert.deepEqual(r.shippedPhases, ['D1', 'D2']);
});

test('all phases shipped → unshippedPhases is empty (safe to flip status)', () => {
	const r = unshippedPhases({
		type: 'decision',
		created: '2026-05-29',
		tags: [],
		phases: ['D1', 'D2'],
		shipped_phases: ['D1', 'D2'],
	} as never);
	assert.deepEqual(r.unshippedPhases, []);
	assert.equal(r.unshippedPhases.length, 0);
});

test('non-string elements in phases are dropped silently', () => {
	const r = unshippedPhases({
		type: 'decision',
		created: '2026-05-29',
		tags: [],
		phases: ['D1', 42, '', '  ', 'D2'],
	} as never);
	// Empty/whitespace strings + non-strings filtered out.
	assert.deepEqual(r.phases, ['D1', 'D2']);
	assert.deepEqual(r.unshippedPhases, ['D1', 'D2']);
});

test('order preserved from declared phases', () => {
	// Operator-visible ordering must match phases[] declaration,
	// not insertion into shipped_phases.
	const r = unshippedPhases({
		type: 'decision',
		created: '2026-05-29',
		tags: [],
		phases: ['Setup', 'Migrate', 'Verify', 'Cleanup'],
		shipped_phases: ['Verify', 'Setup'],
	} as never);
	assert.deepEqual(r.unshippedPhases, ['Migrate', 'Cleanup']);
});
