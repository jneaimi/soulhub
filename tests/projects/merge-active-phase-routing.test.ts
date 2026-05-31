/**
 * ADR-043 P2 — unit tests for mergeActivePhaseRouting.
 *
 * Covers:
 *  - No phase_routing → topLevel returned unchanged (backward-compat)
 *  - Active phase absent (null) → topLevel returned unchanged
 *  - Active phase has no entry in phase_routing → topLevel returned unchanged
 *  - Active phase has partial override → only declared keys overridden
 *  - Active phase has full override → all keys replaced
 *  - Non-active phases do NOT bleed into the merged result
 *  - Falsifier: P1 owner=human → dispatch button should not appear (owner check)
 *  - Falsifier: P2 soul-hub-implementer override after P1 (ADR-008 scenario)
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/merge-active-phase-routing.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeActivePhaseRouting } from '../../src/lib/projects/dispatch-routing.ts';
import type { PhaseRouting } from '../../src/lib/projects/dispatch-routing.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TopLevel = { work_type?: string; assignee?: string; surface?: string; owner?: string };
type RoutingMap = Record<string, PhaseRouting>;

function topLevel(overrides: Partial<TopLevel> = {}): TopLevel {
	return {
		work_type: 'coding',
		assignee: 'soul-hub-implementer',
		surface: 'soul-hub',
		owner: 'ai',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// No phase_routing → pass-through
// ---------------------------------------------------------------------------

describe('mergeActivePhaseRouting — no phase_routing (backward-compat)', () => {
	test('undefined phaseRouting → returns topLevel unchanged', () => {
		const tl = topLevel();
		const result = mergeActivePhaseRouting(tl, undefined, 'P1');
		assert.deepEqual(result, tl);
		assert.equal(result, tl); // same reference (no copy when no override)
	});

	test('null phaseRouting → returns topLevel unchanged', () => {
		const tl = topLevel();
		const result = mergeActivePhaseRouting(tl, null, 'P1');
		assert.deepEqual(result, tl);
	});

	test('empty phaseRouting map → returns topLevel unchanged', () => {
		const tl = topLevel();
		const result = mergeActivePhaseRouting(tl, {}, 'P1');
		// Empty map → no entry for P1 → returns topLevel reference
		assert.deepEqual(result, tl);
	});
});

// ---------------------------------------------------------------------------
// No active phase → pass-through
// ---------------------------------------------------------------------------

describe('mergeActivePhaseRouting — no active phase', () => {
	test('activePhase null → returns topLevel unchanged', () => {
		const tl = topLevel();
		const routing: RoutingMap = { P1: { owner: 'human' } };
		const result = mergeActivePhaseRouting(tl, routing, null);
		assert.deepEqual(result, tl);
	});
});

// ---------------------------------------------------------------------------
// Active phase present but no entry in map → pass-through
// ---------------------------------------------------------------------------

describe('mergeActivePhaseRouting — active phase not in map', () => {
	test('active=P2, map only has P1 → returns topLevel unchanged', () => {
		const tl = topLevel();
		const routing: RoutingMap = { P1: { owner: 'human', work_type: 'config' } };
		const result = mergeActivePhaseRouting(tl, routing, 'P2');
		assert.deepEqual(result, tl);
	});
});

// ---------------------------------------------------------------------------
// Partial override — only declared keys are replaced
// ---------------------------------------------------------------------------

describe('mergeActivePhaseRouting — partial override', () => {
	test('owner only override → work_type/assignee/surface inherit topLevel', () => {
		const tl = topLevel();
		const routing: RoutingMap = { P1: { owner: 'human' } };
		const result = mergeActivePhaseRouting(tl, routing, 'P1');
		assert.equal(result.owner, 'human');       // overridden
		assert.equal(result.work_type, 'coding');  // inherited
		assert.equal(result.assignee, 'soul-hub-implementer'); // inherited
		assert.equal(result.surface, 'soul-hub');  // inherited
	});

	test('work_type only override → owner/assignee/surface inherit topLevel', () => {
		const tl = topLevel();
		const routing: RoutingMap = { P1: { work_type: 'config' } };
		const result = mergeActivePhaseRouting(tl, routing, 'P1');
		assert.equal(result.work_type, 'config');  // overridden
		assert.equal(result.owner, 'ai');          // inherited
		assert.equal(result.assignee, 'soul-hub-implementer'); // inherited
	});

	test('assignee only override → other keys from topLevel', () => {
		const tl = topLevel();
		const routing: RoutingMap = { P3: { assignee: 'general-purpose', surface: 'evaluate-session-app' } };
		const result = mergeActivePhaseRouting(tl, routing, 'P3');
		assert.equal(result.assignee, 'general-purpose');
		assert.equal(result.surface, 'evaluate-session-app');
		assert.equal(result.work_type, 'coding');  // inherited
	});
});

// ---------------------------------------------------------------------------
// Full override — all keys replaced
// ---------------------------------------------------------------------------

describe('mergeActivePhaseRouting — full override', () => {
	test('all four keys overridden for active phase', () => {
		const tl = topLevel();
		const routing: RoutingMap = {
			P1: { owner: 'human', work_type: 'config', assignee: 'jasem', surface: 'elevenlabs-dashboard' },
		};
		const result = mergeActivePhaseRouting(tl, routing, 'P1');
		assert.equal(result.owner, 'human');
		assert.equal(result.work_type, 'config');
		assert.equal(result.assignee, 'jasem');
		assert.equal(result.surface, 'elevenlabs-dashboard');
	});

	test('override produces a new object (does not mutate topLevel)', () => {
		const tl = topLevel();
		const routing: RoutingMap = { P1: { owner: 'human' } };
		const result = mergeActivePhaseRouting(tl, routing, 'P1');
		// topLevel must be unchanged
		assert.equal(tl.owner, 'ai');
		// result is a different object
		assert.notEqual(result, tl);
	});
});

// ---------------------------------------------------------------------------
// Non-active phases don't bleed in
// ---------------------------------------------------------------------------

describe('mergeActivePhaseRouting — non-active phases are ignored', () => {
	test('P2 routing does not affect the P1 result when P1 is active', () => {
		const tl = topLevel();
		const routing: RoutingMap = {
			P1: { owner: 'human', work_type: 'config' },
			P2: { work_type: 'coding', assignee: 'soul-hub-implementer' },
		};
		const result = mergeActivePhaseRouting(tl, routing, 'P1');
		// P1 override applies
		assert.equal(result.owner, 'human');
		assert.equal(result.work_type, 'config');
		// P2 assignee does NOT appear
		assert.equal(result.assignee, 'soul-hub-implementer'); // from topLevel, not P2
	});

	test('P1 routing does not affect the P2 result when P2 is active', () => {
		const tl = topLevel({ work_type: 'coding', assignee: 'implementer' });
		const routing: RoutingMap = {
			P1: { owner: 'human', work_type: 'config' },
			P2: { work_type: 'coding', assignee: 'soul-hub-implementer', surface: 'soul-hub' },
		};
		const result = mergeActivePhaseRouting(tl, routing, 'P2');
		// P2 override applies
		assert.equal(result.work_type, 'coding');
		assert.equal(result.assignee, 'soul-hub-implementer');
		assert.equal(result.surface, 'soul-hub');
		// P1's owner: 'human' does NOT bleed in
		assert.equal(result.owner, 'ai'); // from topLevel
	});
});

// ---------------------------------------------------------------------------
// ADR-043 falsifier: ADR-008 misroute scenario (P1 human / P2 coding)
// ---------------------------------------------------------------------------

describe('ADR-043 falsifier — ADR-008 misroute scenario', () => {
	// ADR-008 shape: top-level picks P2's routing (the most common phase),
	// phase_routing overrides P1 (human/config) and P3 (different surface).
	const adr008TopLevel: TopLevel = {
		work_type: 'coding',
		assignee: 'soul-hub-implementer',
		surface: 'soul-hub',
		owner: 'ai',
	};
	const adr008Routing: RoutingMap = {
		P1: { owner: 'human', work_type: 'config', surface: 'elevenlabs-dashboard' },
		P2: { owner: 'ai',    work_type: 'coding', assignee: 'soul-hub-implementer', surface: 'soul-hub' },
		P3: { owner: 'ai',    work_type: 'coding', assignee: 'general-purpose', surface: 'evaluate-session-app' },
	};

	test('active=P1 → owner:human, work_type:config (no AI dispatch should show)', () => {
		const result = mergeActivePhaseRouting(adr008TopLevel, adr008Routing, 'P1');
		assert.equal(result.owner, 'human');
		assert.equal(result.work_type, 'config');
		assert.equal(result.surface, 'elevenlabs-dashboard');
		// The UI should check `result.owner === 'human'` to hide Dispatch button.
	});

	test('active=P2 → owner:ai, assignee:soul-hub-implementer, surface:soul-hub', () => {
		const result = mergeActivePhaseRouting(adr008TopLevel, adr008Routing, 'P2');
		assert.equal(result.owner, 'ai');
		assert.equal(result.assignee, 'soul-hub-implementer');
		assert.equal(result.surface, 'soul-hub');
		assert.equal(result.work_type, 'coding');
	});

	test('active=P3 → assignee:general-purpose, surface:evaluate-session-app (out-of-worktree)', () => {
		const result = mergeActivePhaseRouting(adr008TopLevel, adr008Routing, 'P3');
		assert.equal(result.assignee, 'general-purpose');
		assert.equal(result.surface, 'evaluate-session-app');
		// The UI should surface a "out-of-worktree" warning for this surface.
	});
});

// ---------------------------------------------------------------------------
// Edge cases — undefined/null topLevel fields
// ---------------------------------------------------------------------------

describe('mergeActivePhaseRouting — sparse topLevel', () => {
	test('topLevel with no fields + partial override produces only override fields', () => {
		const tl: TopLevel = {};
		const routing: RoutingMap = { P1: { owner: 'human', work_type: 'config' } };
		const result = mergeActivePhaseRouting(tl, routing, 'P1');
		assert.equal(result.owner, 'human');
		assert.equal(result.work_type, 'config');
		assert.equal(result.assignee, undefined);
		assert.equal(result.surface, undefined);
	});
});
