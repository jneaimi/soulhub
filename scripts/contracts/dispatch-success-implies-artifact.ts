#!/usr/bin/env -S npx tsx
/**
 * Falsifier for the `dispatch-success-implies-artifact` governance contract
 * (soul-hub-agents ADR-012 P1).
 *
 * Invariant: a PRODUCTION coding dispatch (worktree agent — `agent.repo` set)
 * may only be recorded as a success (`success`/`goal_achieved`) when it left a
 * reviewable artifact — a parseable hand-back OR a committed worktree branch.
 * If it left neither, `gateStatusForDeliverable` MUST downgrade it to
 * `completed-no-artifact` so it surfaces in Waiting-on-you instead of silently
 * falling back to ready_for_ai (the ADR-003 failure).
 *
 * This is a deterministic property check on the gate function itself — no live
 * DB scan, so no false positives (a deliverable-B branch-without-hand-back is a
 * legitimate pass the gate allows, which a DB scan couldn't distinguish). If the
 * gate is ever removed or weakened, the assertions below go red.
 *
 * Exit 0 = sound. Exit 1 = the gate no longer enforces the invariant.
 *
 *   npx tsx scripts/contracts/dispatch-success-implies-artifact.ts
 */
import { gateStatusForDeliverable } from '../../src/lib/agents/dispatch/deliverable-gate.ts';

const SUBJECT = 'projects/soul-hub-agents/adr-003-agent-vault-first-retrieval.md';
const base = {
	mode: 'production' as const,
	repo: '/x/dev/soul-hub',
	subjectPath: SUBJECT,
	startedAt: 1779827987493,
	handback: undefined as string | undefined,
};

const failures: string[] = [];
function expect(label: string, got: string, want: string) {
	if (got !== want) failures.push(`${label}: expected '${want}', got '${got}'`);
}

// 1. THE LOAD-BEARING CASE — success-like, no hand-back, no committed branch.
expect(
	'goal_achieved + no artifact → downgraded',
	gateStatusForDeliverable({ ...base, rawStatus: 'goal_achieved', branchHasCommitsFn: () => false }),
	'completed-no-artifact',
);
expect(
	'success + no artifact → downgraded',
	gateStatusForDeliverable({ ...base, rawStatus: 'success', branchHasCommitsFn: () => false }),
	'completed-no-artifact',
);

// 2. Deliverable A (hand-back) → success preserved.
expect(
	'success + hand-back → preserved',
	gateStatusForDeliverable({
		...base,
		rawStatus: 'success',
		handback: '```json\n{"branch":"x","summary":"s","check_passed":true,"build_passed":true}\n```',
		branchHasCommitsFn: () => false,
	}),
	'success',
);

// 3. Deliverable B (committed branch) → success preserved.
expect(
	'success + committed branch → preserved',
	gateStatusForDeliverable({ ...base, rawStatus: 'goal_achieved', branchHasCommitsFn: () => true }),
	'goal_achieved',
);

// 4. Out-of-scope dispatches must NEVER be downgraded (no false positives).
expect(
	'test mode → never gated',
	gateStatusForDeliverable({ ...base, rawStatus: 'success', mode: 'test', branchHasCommitsFn: () => false }),
	'success',
);
expect(
	'non-worktree agent (no repo) → never gated',
	gateStatusForDeliverable({ ...base, rawStatus: 'success', repo: undefined, branchHasCommitsFn: () => false }),
	'success',
);
expect(
	'non-success status → untouched',
	gateStatusForDeliverable({ ...base, rawStatus: 'error', branchHasCommitsFn: () => false }),
	'error',
);

if (failures.length === 0) {
	console.log('dispatch-success-implies-artifact: PASS — the deliverable gate enforces the invariant');
	process.exit(0);
}

console.error('dispatch-success-implies-artifact: FALSIFIED — the deliverable gate no longer holds:');
for (const f of failures) console.error(`  • ${f}`);
console.error('Fix: restore gateStatusForDeliverable (src/lib/agents/dispatch/deliverable-gate.ts) so a');
console.error('production coding success with no hand-back AND no committed branch → completed-no-artifact.');
process.exit(1);
