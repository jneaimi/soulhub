/**
 * ADR-042 D1 — unit tests for validatePhasedAdrFields.
 *
 * Falsifier criterion: the vault-write API rejects an ADR with
 * `shipped_phases: ['D5']` when `phases: ['D1','D2']` — demonstrated
 * by the test "shipped_phases element not in phases → error".
 *
 * Run via:
 *   node --test --experimental-strip-types tests/vault/phased-adr-fields.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
// Import from the pure module (no `.js`-extension transitive deps that confuse
// the Node.js --experimental-strip-types resolver).
import { validatePhasedAdrFields } from '../../src/lib/vault/phases.ts';

// Minimal VaultMeta for a decision note.
function decision(extra: Record<string, unknown> = {}) {
	return { type: 'decision', created: '2026-05-29', tags: ['decision'], ...extra };
}

// ── Non-decision notes are always skipped ────────────────────────────────────

describe('non-decision notes', () => {
	test('ignores phases/shipped_phases on type: learning', () => {
		assert.strictEqual(
			validatePhasedAdrFields({ type: 'learning', phases: 'not-an-array' }),
			null,
		);
	});

	test('ignores phases/shipped_phases when type is absent', () => {
		assert.strictEqual(
			validatePhasedAdrFields({ phases: ['D1'], shipped_phases: ['D99'] }),
			null,
		);
	});
});

// ── phases absent → single-shot ADR, pass through ────────────────────────────

describe('phases absent', () => {
	test('passes when neither phases nor shipped_phases is set', () => {
		assert.strictEqual(validatePhasedAdrFields(decision()), null);
	});

	test('errors when shipped_phases is set without phases', () => {
		const err = validatePhasedAdrFields(decision({ shipped_phases: ['D1'] }));
		assert.ok(err, 'expected an error');
		assert.match(err!, /shipped_phases requires phases/);
	});

	test('errors when shipped_phases is empty array and phases is absent', () => {
		// Empty shipped_phases is still declared — requires superset.
		const err = validatePhasedAdrFields(decision({ shipped_phases: [] }));
		assert.ok(err, 'expected an error');
		assert.match(err!, /shipped_phases requires phases/);
	});
});

// ── phases present — format validation ───────────────────────────────────────

describe('phases field format', () => {
	test('passes for a well-formed phases array', () => {
		assert.strictEqual(
			validatePhasedAdrFields(decision({ phases: ['D1', 'D2', 'D3', 'D4'] })),
			null,
		);
	});

	test('errors when phases is not an array', () => {
		const err = validatePhasedAdrFields(decision({ phases: 'D1,D2' }));
		assert.ok(err);
		assert.match(err!, /must be an array/);
	});

	test('errors when phases is an empty array', () => {
		const err = validatePhasedAdrFields(decision({ phases: [] }));
		assert.ok(err);
		assert.match(err!, /non-empty when declared/);
	});

	test('errors when a phases element is empty string', () => {
		const err = validatePhasedAdrFields(decision({ phases: ['D1', ''] }));
		assert.ok(err);
		assert.match(err!, /non-empty strings/);
	});

	test('errors when a phases element is not a string', () => {
		const err = validatePhasedAdrFields(decision({ phases: ['D1', 42] }));
		assert.ok(err);
		assert.match(err!, /non-empty strings/);
	});

	test('errors when phases has duplicates', () => {
		const err = validatePhasedAdrFields(decision({ phases: ['D1', 'D2', 'D1'] }));
		assert.ok(err);
		assert.match(err!, /duplicates/);
	});
});

// ── shipped_phases — subset invariant ────────────────────────────────────────

describe('shipped_phases subset invariant', () => {
	test('passes when shipped_phases is absent', () => {
		assert.strictEqual(
			validatePhasedAdrFields(decision({ phases: ['D1', 'D2'] })),
			null,
		);
	});

	test('passes when shipped_phases is empty array', () => {
		assert.strictEqual(
			validatePhasedAdrFields(decision({ phases: ['D1', 'D2'], shipped_phases: [] })),
			null,
		);
	});

	test('passes when shipped_phases is a proper subset of phases', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({ phases: ['D1', 'D2', 'D3', 'D4'], shipped_phases: ['D1', 'D2'] }),
			),
			null,
		);
	});

	test('passes when shipped_phases equals phases (all shipped)', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({ phases: ['D1', 'D2'], shipped_phases: ['D1', 'D2'] }),
			),
			null,
		);
	});

	// ── ADR-042 falsifier test (D1) ─────────────────────────────────────────
	test('shipped_phases element not in phases → error (ADR-042 falsifier)', () => {
		// This is the concrete scenario from the ADR falsifier:
		// phases: ['D1', 'D2'], shipped_phases: ['D5'] → must reject.
		const err = validatePhasedAdrFields(
			decision({ phases: ['D1', 'D2'], shipped_phases: ['D5'] }),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /D5.*not declared in phases/);
		assert.match(err!, /D1, D2/);
		assert.match(err!, /ADR-042 D1/);
	});

	test('errors when shipped_phases is not an array', () => {
		const err = validatePhasedAdrFields(
			decision({ phases: ['D1', 'D2'], shipped_phases: 'D1' }),
		);
		assert.ok(err);
		assert.match(err!, /must be an array/);
	});

	test('errors when shipped_phases contains a non-string', () => {
		const err = validatePhasedAdrFields(
			decision({ phases: ['D1', 'D2'], shipped_phases: [1] }),
		);
		assert.ok(err);
		assert.match(err!, /elements must be strings/);
	});

	test('errors when a second shipped element is outside phases', () => {
		const err = validatePhasedAdrFields(
			decision({ phases: ['D1', 'D2', 'D3'], shipped_phases: ['D1', 'D99'] }),
		);
		assert.ok(err);
		assert.match(err!, /D99.*not declared in phases/);
	});
});

// ── Active phase derivation (pure function, informational) ───────────────────
// The active phase is the first element of phases not in shipped_phases.
// Validated indirectly by the UI; these tests assert the validator doesn't
// reject valid phased ADRs at different completion stages.

describe('active phase states (validator passes all)', () => {
	test('all phases shipped → no active phase, still valid', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['D1', 'D2', 'D3'],
					shipped_phases: ['D1', 'D2', 'D3'],
				}),
			),
			null,
		);
	});

	test('no phases shipped → active phase is D1, valid', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({ phases: ['D1', 'D2', 'D3', 'D4'], shipped_phases: [] }),
			),
			null,
		);
	});

	test('ADR-042 itself: phases [D1,D2,D3,D4] shipped_phases [] → valid', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({ phases: ['D1', 'D2', 'D3', 'D4'], shipped_phases: [] }),
			),
			null,
		);
	});
});

// ── ADR-043 P1 — phase_routing: validation ───────────────────────────────────

describe('phase_routing — requires phases superset', () => {
	test('phase_routing without phases → error (ADR-043 P1)', () => {
		const err = validatePhasedAdrFields(
			decision({ phase_routing: { P1: { owner: 'human' } } }),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /phase_routing requires phases/);
		assert.match(err!, /ADR-043 P1/);
	});

	test('phase_routing absent without phases → passes (backward-compat)', () => {
		assert.strictEqual(validatePhasedAdrFields(decision()), null);
	});

	test('phase_routing null without phases → passes (same as absent)', () => {
		assert.strictEqual(
			validatePhasedAdrFields(decision({ phase_routing: null })),
			null,
		);
	});
});

describe('phase_routing — key must be in phases superset', () => {
	test('phase_routing key not in phases → error', () => {
		const err = validatePhasedAdrFields(
			decision({
				phases: ['P1', 'P2'],
				phase_routing: { P3: { owner: 'human' } },
			}),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /phase_routing key "P3" not declared in phases/);
		assert.match(err!, /P1, P2/);
		assert.match(err!, /ADR-043 P1/);
	});

	test('all phase_routing keys in phases → passes', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['P1', 'P2', 'P3'],
					phase_routing: {
						P1: { owner: 'human', work_type: 'config' },
						P2: { owner: 'ai', assignee: 'soul-hub-implementer' },
					},
				}),
			),
			null,
		);
	});

	test('phase_routing partial coverage (only one key) is valid', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['P1', 'P2', 'P3'],
					phase_routing: { P2: { work_type: 'coding' } },
				}),
			),
			null,
		);
	});
});

describe('phase_routing — value shape validation', () => {
	test('value is null → error', () => {
		const err = validatePhasedAdrFields(
			decision({
				phases: ['P1'],
				phase_routing: { P1: null },
			}),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /phase_routing value for "P1" must be an object/);
		assert.match(err!, /ADR-043 P1/);
	});

	test('value is a string → error', () => {
		const err = validatePhasedAdrFields(
			decision({
				phases: ['P1'],
				phase_routing: { P1: 'human' },
			}),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /phase_routing value for "P1" must be an object/);
	});

	test('value is an array → error', () => {
		const err = validatePhasedAdrFields(
			decision({
				phases: ['P1'],
				phase_routing: { P1: ['owner', 'human'] },
			}),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /phase_routing value for "P1" must be an object/);
	});

	test('value is empty object (no allowed keys) → error', () => {
		const err = validatePhasedAdrFields(
			decision({
				phases: ['P1'],
				phase_routing: { P1: {} },
			}),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /phase_routing value for "P1" must have at least one of/);
		assert.match(err!, /owner/);
		assert.match(err!, /work_type/);
		assert.match(err!, /assignee/);
		assert.match(err!, /surface/);
	});

	test('value has only unknown keys → error', () => {
		const err = validatePhasedAdrFields(
			decision({
				phases: ['P1'],
				phase_routing: { P1: { foo: 'bar', baz: 42 } },
			}),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /must have at least one of/);
	});

	test('value has unknown keys alongside known key → passes (soft-warning design)', () => {
		// Unknown keys are silently accepted so future routing fields don't break validation.
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['P1'],
					phase_routing: { P1: { owner: 'ai', unknown_future_field: true } },
				}),
			),
			null,
		);
	});

	test('owner must be "ai" or "human" → error on other value', () => {
		const err = validatePhasedAdrFields(
			decision({
				phases: ['P1'],
				phase_routing: { P1: { owner: 'robot' } },
			}),
		);
		assert.ok(err, 'expected a validation error');
		assert.match(err!, /owner must be "ai" or "human"/);
		assert.match(err!, /ADR-043 P1/);
	});

	test('owner: "ai" → passes', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['P1'],
					phase_routing: { P1: { owner: 'ai' } },
				}),
			),
			null,
		);
	});

	test('owner: "human" → passes', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['P1'],
					phase_routing: { P1: { owner: 'human' } },
				}),
			),
			null,
		);
	});
});

describe('phase_routing — backward-compat: existing ADRs without phase_routing unchanged', () => {
	test('ADR-042 canonical shape (no phase_routing) → unchanged behavior', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['D1', 'D2', 'D3', 'D4'],
					shipped_phases: ['D1', 'D2'],
				}),
			),
			null,
		);
	});

	test('shipped_phases element not in phases still errors (ADR-042 invariant untouched)', () => {
		const err = validatePhasedAdrFields(
			decision({ phases: ['D1', 'D2'], shipped_phases: ['D5'] }),
		);
		assert.ok(err, 'expected an error');
		assert.match(err!, /D5.*not declared in phases/);
	});

	test('phase_routing + shipped_phases coexist when both valid', () => {
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['P1', 'P2', 'P3'],
					shipped_phases: ['P1'],
					phase_routing: {
						P1: { owner: 'human', work_type: 'config' },
						P2: { owner: 'ai', work_type: 'coding', assignee: 'soul-hub-implementer', surface: 'soul-hub' },
						P3: { owner: 'ai', work_type: 'coding', assignee: 'general-purpose', surface: 'evaluate-session-app' },
					},
				}),
			),
			null,
		);
	});

	test('phase_routing: {} (empty map) → passes (all phases use top-level routing)', () => {
		// An empty phase_routing is valid — it means no phase-specific overrides.
		assert.strictEqual(
			validatePhasedAdrFields(
				decision({
					phases: ['P1', 'P2'],
					phase_routing: {},
				}),
			),
			null,
		);
	});
});
