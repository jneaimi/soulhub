/** ADR-012 P1 — deliverable-gating tests.
 *
 *  Suite 1: gateStatusForDeliverable — downgrade a success-like production
 *  coding dispatch to `completed-no-artifact` only when it left NO reviewable
 *  artifact (no hand-back + no committed branch). Everything else passes
 *  through unchanged. The git check is injected so no real repo is needed.
 *
 *  Suite 2: computeLaneAndProgress — a `noArtifact` payload lands in
 *  `waiting_on_you`, ranks below reviewHandoff, and below in_flight.
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/deliverable-gate.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const SUBJECT = 'projects/soul-hub-agents/adr-003-agent-vault-first-retrieval.md';
const REPO = '/Users/x/dev/soul-hub';

// ── Suite 1: gateStatusForDeliverable ─────────────────────────────────────────

describe('gateStatusForDeliverable', () => {
	const base = {
		mode: 'production' as const,
		repo: REPO,
		subjectPath: SUBJECT,
		startedAt: 1779827987493,
		handback: undefined as string | undefined,
		branchHasCommitsFn: () => false, // no committed branch by default
	};

	test('non-success status passes through unchanged', async () => {
		const { gateStatusForDeliverable } = await import('$lib/agents/dispatch/deliverable-gate.ts');
		assert.equal(gateStatusForDeliverable({ ...base, rawStatus: 'error' }), 'error');
		assert.equal(gateStatusForDeliverable({ ...base, rawStatus: 'timeout' }), 'timeout');
	});

	test('test/oneshot mode is never gated (no artifact expected)', async () => {
		const { gateStatusForDeliverable } = await import('$lib/agents/dispatch/deliverable-gate.ts');
		assert.equal(gateStatusForDeliverable({ ...base, rawStatus: 'success', mode: 'test' }), 'success');
		assert.equal(
			gateStatusForDeliverable({ ...base, rawStatus: 'goal_achieved', mode: 'oneshot' }),
			'goal_achieved',
		);
	});

	test('non-worktree agent (no repo) is never gated — e.g. analyst', async () => {
		const { gateStatusForDeliverable } = await import('$lib/agents/dispatch/deliverable-gate.ts');
		assert.equal(
			gateStatusForDeliverable({ ...base, rawStatus: 'success', repo: undefined }),
			'success',
		);
	});

	test('no subject (chat dispatch) is never gated', async () => {
		const { gateStatusForDeliverable } = await import('$lib/agents/dispatch/deliverable-gate.ts');
		assert.equal(
			gateStatusForDeliverable({ ...base, rawStatus: 'goal_achieved', subjectPath: undefined }),
			'goal_achieved',
		);
	});

	test('deliverable A: a hand-back present → success preserved', async () => {
		const { gateStatusForDeliverable } = await import('$lib/agents/dispatch/deliverable-gate.ts');
		assert.equal(
			gateStatusForDeliverable({
				...base,
				rawStatus: 'goal_achieved',
				handback: '```json\n{"branch":"x"}\n```',
			}),
			'goal_achieved',
		);
	});

	test('deliverable B: a committed branch → success preserved', async () => {
		const { gateStatusForDeliverable } = await import('$lib/agents/dispatch/deliverable-gate.ts');
		assert.equal(
			gateStatusForDeliverable({
				...base,
				rawStatus: 'success',
				branchHasCommitsFn: () => true,
			}),
			'success',
		);
	});

	test('THE ADR-003 CASE: success, no hand-back, no branch → completed-no-artifact', async () => {
		const { gateStatusForDeliverable } = await import('$lib/agents/dispatch/deliverable-gate.ts');
		assert.equal(
			gateStatusForDeliverable({ ...base, rawStatus: 'goal_achieved' }),
			'completed-no-artifact',
		);
		assert.equal(
			gateStatusForDeliverable({ ...base, rawStatus: 'success' }),
			'completed-no-artifact',
		);
	});

	test('branch reconstruction passes the right ref to the git check', async () => {
		const { gateStatusForDeliverable } = await import('$lib/agents/dispatch/deliverable-gate.ts');
		const { safeId } = await import('$lib/agents/dispatch/worktree-provision.ts');
		let seenBranch = '';
		const out = gateStatusForDeliverable({
			...base,
			rawStatus: 'success',
			branchHasCommitsFn: (b) => {
				seenBranch = b;
				return false;
			},
		});
		assert.equal(out, 'completed-no-artifact');
		assert.equal(seenBranch, `orchestration/run-${base.startedAt}/${safeId(SUBJECT)}`);
	});
});

// ── Suite 2: computeLaneAndProgress noArtifact precedence ─────────────────────

describe('computeLaneAndProgress — noArtifact', () => {
	const noArtifact = { summary: 'did stuff outside the worktree', costUsd: 3.17, numTurns: 1 };
	const empty = new Map<string, { costUsd: number; numTurns: number; startedAt: number }>();

	test('noArtifact → waiting_on_you with payload', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');
		const r = computeLaneAndProgress(SUBJECT, 'ai', [], empty, undefined, undefined, noArtifact);
		assert.equal(r.lane, 'waiting_on_you');
		assert.deepEqual(r.noArtifact, noArtifact);
	});

	test('reviewHandoff beats noArtifact (a real branch wins)', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');
		const review = { branch: 'orchestration/run-1/x', summary: 's', followUps: [], gatesGreen: true, costUsd: 1 };
		const r = computeLaneAndProgress(SUBJECT, 'ai', [], empty, undefined, review, noArtifact);
		assert.equal(r.lane, 'waiting_on_you');
		assert.ok(r.reviewHandoff, 'reviewHandoff present');
		assert.equal(r.noArtifact, undefined, 'noArtifact not surfaced when reviewHandoff wins');
	});

	test('in_flight beats noArtifact', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');
		const running = new Map([[SUBJECT, { costUsd: 0.5, numTurns: 3, startedAt: 123 }]]);
		const r = computeLaneAndProgress(SUBJECT, 'ai', [], running, undefined, undefined, noArtifact);
		assert.equal(r.lane, 'in_flight');
		assert.equal(r.noArtifact, undefined);
	});
});
