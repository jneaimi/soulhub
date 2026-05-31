import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectsAtCeiling, DEFAULT_WARNING_HORIZON_TURNS } from './velocity-projection.ts';

test('default horizon is 3 turns', () => {
	assert.equal(DEFAULT_WARNING_HORIZON_TURNS, 3);
});

test('willHitCost fires when projected spend within horizon crosses the USD ceiling', () => {
	// $8 spent over 4 turns = $2/turn; at default horizon=3, projection is
	// 8 + 2*3 = 14, well past ceiling 10.
	const out = projectsAtCeiling({ costUsd: 8, turns: 4 }, 10, 100);
	assert.equal(out.willHitCost, true);
	assert.equal(out.willHitTurns, false);
});

test('willHitTurns fires when projected turns within horizon reach the turn ceiling', () => {
	// turn 9 done; at horizon=3, projection is 9 + 3 = 12, past ceilingTurns=10.
	const out = projectsAtCeiling({ costUsd: 1, turns: 9 }, 100, 10);
	assert.equal(out.willHitCost, false);
	assert.equal(out.willHitTurns, true);
});

test('horizon=1 (legacy behavior) only fires when next turn alone crosses', () => {
	// Replicates pre-2026-05-30 single-turn projection.
	// $7 spent over 5 turns = $1.40/turn; next turn = $8.40, under ceiling 10.
	const next = projectsAtCeiling({ costUsd: 7, turns: 5 }, 10, 100, 1);
	assert.equal(next.willHitCost, false);
	// Same snap at default horizon=3: 7 + 1.4*3 = 11.2 ≥ 10, fires earlier.
	const wide = projectsAtCeiling({ costUsd: 7, turns: 5 }, 10, 100, 3);
	assert.equal(wide.willHitCost, true);
});

test('wider horizon fires earlier than narrow horizon (response-window guarantee)', () => {
	// Cost rate is $0.20/turn; ceiling at $10. Spend at which fire-condition
	// hits: ceiling - horizon*rate.
	const snap = { costUsd: 9.5, turns: 47.5 }; // 47.5 chosen so rate = 0.2
	// horizon=1: 9.5 + 0.2*1 = 9.7 < 10 → false
	assert.equal(projectsAtCeiling(snap, 10, 100, 1).willHitCost, false);
	// horizon=3: 9.5 + 0.2*3 = 10.1 ≥ 10 → true
	assert.equal(projectsAtCeiling(snap, 10, 100, 3).willHitCost, true);
});

test('neither axis fires when both have headroom', () => {
	const out = projectsAtCeiling({ costUsd: 3, turns: 5 }, 100, 100);
	assert.equal(out.willHitCost, false);
	assert.equal(out.willHitTurns, false);
});

test('both fire when projection within horizon crosses both axes', () => {
	// $9 over 9 turns = $1/turn; horizon=3 → 9+3=12 ≥ both ceilings (10/10).
	const out = projectsAtCeiling({ costUsd: 9, turns: 9 }, 10, 10);
	assert.equal(out.willHitCost, true);
	assert.equal(out.willHitTurns, true);
});

test('null cost suppresses willHitCost; turn projection still runs', () => {
	// Untrusted pricing — must not project a dollar warning, but turns axis
	// is independent and still flags.
	const out = projectsAtCeiling({ costUsd: null, turns: 9 }, 10, 10);
	assert.equal(out.willHitCost, false);
	assert.equal(out.willHitTurns, true);
});

test('zero turns suppresses willHitCost (no per-turn rate yet)', () => {
	const out = projectsAtCeiling({ costUsd: 1, turns: 0 }, 5, 10);
	assert.equal(out.willHitCost, false);
	assert.equal(out.willHitTurns, false);
});

test('already-past-ceiling cost suppresses willHitCost — hard ceiling owns that path', () => {
	// snap.costUsd >= ceilingUsd is handled by the hard-ceiling kill upstream,
	// not the soft velocity warning. The predicate guards against re-firing
	// after the hard kill is already imminent.
	const out = projectsAtCeiling({ costUsd: 12, turns: 4 }, 10, 100);
	assert.equal(out.willHitCost, false);
});

test('partial-grant re-arm scenario: cost raised but turns still close', () => {
	// Pre-grant: ceilingUsd=10, ceilingTurns=10, snap.costUsd=8, turns=9.
	// Both axes fire → warning emitted, velocityWarned=true.
	// Operator raises USD only (grant.ceilingUsd=20). After adoption:
	const post = projectsAtCeiling({ costUsd: 8, turns: 9 }, 20, 10);
	// USD projection now clear (8 + 8/9 < 20), but turns axis still fires.
	// Commit C contract: re-arm only when !willHitCost && !willHitTurns,
	// so this snap MUST NOT re-arm (would dupe the warning on next tick).
	assert.equal(post.willHitCost, false);
	assert.equal(post.willHitTurns, true);
});

test('full grant clears both axes — safe to re-arm', () => {
	// Operator raised BOTH ceilings. Re-arm allowed.
	const post = projectsAtCeiling({ costUsd: 8, turns: 9 }, 20, 20);
	assert.equal(post.willHitCost, false);
	assert.equal(post.willHitTurns, false);
});
