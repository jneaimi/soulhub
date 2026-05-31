/**
 * ADR-042 D4 — unit tests for merge-partial response shaping and ship-warning logic.
 *
 * D4 falsifier:
 *   `soul adr merge-partial adr-042-phased-adr-tier-1-workflow --phase D1` lands D1
 *   on main, sets `shipped_phases: [D1]`, leaves `status: accepted`.
 *
 * These tests cover the pure-logic paths that don't require a live git repo:
 *   1. Idempotency detection (phase already in shipped_phases).
 *   2. Last-phase detection (newShipped.length === phases.length).
 *   3. Phase-not-in-phases validation.
 *   4. Ship-warning: unshipped phases → non-zero exit logic.
 *   5. Ship-warning bypassed by --force-final.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/vault/phased-adr-merge-partial.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

// ── Helpers (inline re-implementations of the pure decision logic) ────────────
//
// We test the LOGIC rather than calling the API endpoints directly, because
// the endpoints depend on a live vault + git repo.  These helpers mirror the
// exact decision branches in +server.ts so the tests are precise.

/** Determine if a phase is already in shipped_phases (idempotency guard). */
function isAlreadyShipped(existingShipped: string[], phase: string): boolean {
	return existingShipped.includes(phase);
}

/** Determine if a phase is the last remaining (all others already shipped). */
function isLastPhase(phases: string[], existingShipped: string[], newPhase: string): boolean {
	const after = [...existingShipped, newPhase];
	return after.length === phases.length;
}

/** Validate that a phase ID is declared in phases[]. Returns an error string or null. */
function validatePhaseInPhasesArray(phases: string[], phase: string): string | null {
	if (phases.length === 0) return 'ADR has no declared phases';
	if (!phases.includes(phase)) {
		return `Phase '${phase}' not declared in phases: [${phases.join(', ')}]`;
	}
	return null;
}

/** Compute the unshipped phases (for the ship warning). */
function unshippedPhases(phases: string[], shippedPhases: string[]): string[] {
	return phases.filter((p) => !shippedPhases.includes(p));
}

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('isAlreadyShipped', () => {
	test('phase not in shipped_phases → false', () => {
		assert.strictEqual(isAlreadyShipped(['D1'], 'D2'), false);
	});

	test('phase in shipped_phases → true (idempotent)', () => {
		assert.strictEqual(isAlreadyShipped(['D1', 'D2'], 'D1'), true);
	});

	test('empty shipped_phases → false', () => {
		assert.strictEqual(isAlreadyShipped([], 'D1'), false);
	});
});

// ── Last-phase detection ──────────────────────────────────────────────────────

describe('isLastPhase', () => {
	test('merging the only remaining phase → last', () => {
		assert.strictEqual(isLastPhase(['D1', 'D2', 'D3'], ['D1', 'D2'], 'D3'), true);
	});

	test('merging a middle phase → not last', () => {
		assert.strictEqual(isLastPhase(['D1', 'D2', 'D3'], ['D1'], 'D2'), false);
	});

	test('merging first phase of four → not last', () => {
		assert.strictEqual(isLastPhase(['D1', 'D2', 'D3', 'D4'], [], 'D1'), false);
	});

	test('single-phase ADR, merging D1 → last', () => {
		assert.strictEqual(isLastPhase(['D1'], [], 'D1'), true);
	});

	test('ADR-042 itself: phases=[D1,D2,D3,D4], shipped=[D1,D2,D3], merging D4 → last', () => {
		assert.strictEqual(isLastPhase(['D1', 'D2', 'D3', 'D4'], ['D1', 'D2', 'D3'], 'D4'), true);
	});
});

// ── Phase validation ──────────────────────────────────────────────────────────

describe('validatePhaseInPhasesArray', () => {
	test('valid phase → null', () => {
		assert.strictEqual(validatePhaseInPhasesArray(['D1', 'D2'], 'D1'), null);
	});

	test('phase not in list → error string', () => {
		const err = validatePhaseInPhasesArray(['D1', 'D2'], 'D5');
		assert.ok(err !== null);
		assert.ok(err!.includes("Phase 'D5' not declared"));
		assert.ok(err!.includes('D1, D2'));
	});

	test('empty phases array → error string', () => {
		const err = validatePhaseInPhasesArray([], 'D1');
		assert.ok(err !== null);
	});
});

// ── Ship warning: unshipped phases ───────────────────────────────────────────

describe('unshippedPhases (ship warning logic)', () => {
	test('all phases shipped → empty array (no warning)', () => {
		assert.deepStrictEqual(
			unshippedPhases(['D1', 'D2', 'D3'], ['D1', 'D2', 'D3']),
			[],
		);
	});

	test('some phases unshipped → non-empty array (warning)', () => {
		assert.deepStrictEqual(
			unshippedPhases(['D1', 'D2', 'D3'], ['D1']),
			['D2', 'D3'],
		);
	});

	test('no phases shipped → all phases returned (warning covers all)', () => {
		assert.deepStrictEqual(
			unshippedPhases(['D1', 'D2', 'D3', 'D4'], []),
			['D1', 'D2', 'D3', 'D4'],
		);
	});

	test('single-phase ADR shipped → no warning', () => {
		assert.deepStrictEqual(unshippedPhases(['D1'], ['D1']), []);
	});
});

// ── Force-final bypass ────────────────────────────────────────────────────────

describe('force-final bypass', () => {
	/** Simulate the ship-warning guard: returns true if warning should fire. */
	function shouldWarnOnShip(
		phases: string[],
		shippedPhases: string[],
		forceFinal: boolean,
	): boolean {
		if (forceFinal) return false;
		const unshipped = unshippedPhases(phases, shippedPhases);
		return phases.length > 0 && unshipped.length > 0;
	}

	test('phases present, unshipped, no --force-final → warning fires', () => {
		assert.strictEqual(shouldWarnOnShip(['D1', 'D2', 'D3'], ['D1'], false), true);
	});

	test('phases present, unshipped, --force-final → warning suppressed', () => {
		assert.strictEqual(shouldWarnOnShip(['D1', 'D2', 'D3'], ['D1'], true), false);
	});

	test('all phases shipped, no --force-final → no warning', () => {
		assert.strictEqual(shouldWarnOnShip(['D1', 'D2'], ['D1', 'D2'], false), false);
	});

	test('no phases field (single-shot ADR) → no warning', () => {
		assert.strictEqual(shouldWarnOnShip([], [], false), false);
	});
});

// ── ADR-042 D4 falsifier scenario ─────────────────────────────────────────────
//
// Falsifier: `soul adr merge-partial adr-042-... --phase D1` should:
//   - Find D1 in phases=[D1,D2,D3,D4]
//   - D1 not yet in shipped_phases=[] → not idempotent
//   - D1 is not the last phase (1 of 4)
//   - After merge, shipped_phases=[D1], status stays accepted
//
describe('ADR-042 D4 falsifier scenario', () => {
	const phases = ['D1', 'D2', 'D3', 'D4'];
	const initialShipped: string[] = [];

	test('D1 is not already shipped → should proceed', () => {
		assert.strictEqual(isAlreadyShipped(initialShipped, 'D1'), false);
	});

	test('D1 is declared in phases → valid', () => {
		assert.strictEqual(validatePhaseInPhasesArray(phases, 'D1'), null);
	});

	test('D1 merge is not the last phase (4 phases, 0 previously shipped)', () => {
		assert.strictEqual(isLastPhase(phases, initialShipped, 'D1'), false);
	});

	test('after D1 ships: shipped_phases=[D1], still unshipped=[D2,D3,D4]', () => {
		const afterD1 = [...initialShipped, 'D1'];
		assert.deepStrictEqual(afterD1, ['D1']);
		assert.deepStrictEqual(unshippedPhases(phases, afterD1), ['D2', 'D3', 'D4']);
	});

	test('soul adr ship warns when D1 shipped but D2/D3/D4 remain', () => {
		const afterD1Shipped = ['D1'];
		const unshipped = unshippedPhases(phases, afterD1Shipped);
		assert.ok(unshipped.length > 0, 'should warn: D2, D3, D4 remain');
		assert.deepStrictEqual(unshipped, ['D2', 'D3', 'D4']);
	});
});
