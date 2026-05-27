/**
 * projects-graph ADR-026 P2b — "Waiting on you" answer box for paused runs.
 *
 * Suites:
 *
 *   1. `computeLaneAndProgress` with awaitingOperator input:
 *      - awaitingOperator present → lane='waiting_on_you', payload carried through.
 *      - running (in_flight) wins over awaitingOperator (mutual exclusion enforced
 *        at the pure-helper level too).
 *
 *   2. `branchForRow` helper — branch reconstruction from (startedAt, subjectPath)
 *      must match `orchestration/run-${startedAt}/${safeId(subjectPath)}`.
 *
 *   3. Question extraction — strips `OPERATOR_QUESTION: ` prefix from errorMessage.
 *
 * Run via:
 *   node --import ./tests/vault-hygiene/register.mjs \
 *        --test --experimental-strip-types \
 *        tests/vault-hygiene/worklist-awaiting-operator.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Suite 1: computeLaneAndProgress with awaitingOperator ─────────────────────

describe('computeLaneAndProgress — awaitingOperator', () => {
	test('awaiting operator → lane=waiting_on_you, payload carried', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const payload = {
			question: 'Which environment should I target?',
			sessionId: 'sess-abc123',
			branch: 'orchestration/run-1716000000000/adr-001-foo',
			agentId: 'soul-hub-implementer',
		};

		const result = computeLaneAndProgress(
			'projects/foo/adr-001.md',
			'ai',
			[], // no blocker — would normally be ready_for_ai
			new Map(), // not running
			payload,
		);

		assert.equal(result.lane, 'waiting_on_you', 'awaiting operator → waiting_on_you');
		assert.ok(result.awaitingOperator, 'payload must be present');
		assert.equal(result.awaitingOperator.question, payload.question);
		assert.equal(result.awaitingOperator.sessionId, payload.sessionId);
		assert.equal(result.awaitingOperator.branch, payload.branch);
		assert.equal(result.awaitingOperator.agentId, payload.agentId);
		assert.equal(result.progress, undefined, 'no progress when not running');
	});

	test('awaiting operator + unmet blockers → still waiting_on_you with payload', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const payload = {
			question: 'What is the output path?',
			sessionId: 'sess-def456',
			branch: 'orchestration/run-1716000001000/adr-002-bar',
			agentId: 'developer',
		};

		const result = computeLaneAndProgress(
			'projects/bar/adr-002.md',
			'ai',
			['adr-001-blocker'], // has unmet blocker
			new Map(),
			payload,
		);

		assert.equal(result.lane, 'waiting_on_you');
		assert.ok(result.awaitingOperator, 'payload still carried even with blockers');
		assert.equal(result.awaitingOperator.question, payload.question);
	});

	test('in_flight (running) wins over awaitingOperator — mutual exclusion', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const now = Date.now();
		const runningRuns = new Map([
			['projects/baz/adr-003.md', { costUsd: 0.05, numTurns: 3, startedAt: now - 60_000 }],
		]);

		const payload = {
			question: 'Should I deploy to prod?',
			sessionId: 'sess-ghi789',
			branch: 'orchestration/run-1716000002000/adr-003-baz',
			agentId: 'deployer',
		};

		const result = computeLaneAndProgress(
			'projects/baz/adr-003.md',
			'ai',
			[],
			runningRuns,
			payload, // awaitingOperator set but running wins
		);

		assert.equal(result.lane, 'in_flight', 'in_flight beats awaitingOperator');
		assert.ok(result.progress, 'progress present');
		assert.equal(result.progress.numTurns, 3);
		assert.equal(result.awaitingOperator, undefined, 'awaitingOperator absent when in_flight');
	});

	test('no awaitingOperator + unblocked AI-owned → ready_for_ai (unchanged)', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress(
			'projects/qux/adr-004.md',
			'ai',
			[],
			new Map(),
			undefined, // no awaiting
		);

		assert.equal(result.lane, 'ready_for_ai');
		assert.equal(result.awaitingOperator, undefined);
	});

	test('no awaitingOperator + blocked AI-owned → waiting_on_you without payload', async () => {
		const { computeLaneAndProgress } = await import('$lib/projects/worklist-lane.ts');

		const result = computeLaneAndProgress(
			'projects/qux/adr-005.md',
			'ai',
			['adr-004-dep'],
			new Map(),
			undefined,
		);

		assert.equal(result.lane, 'waiting_on_you');
		assert.equal(result.awaitingOperator, undefined, 'no payload when blocked by normal dep');
	});
});

// ── Suite 2: branchForRow reconstruction ──────────────────────────────────────

describe('branchForRow — branch name reconstruction', () => {
	/** Reconstruct the branch for a paused run row, mirroring the formula in
	 *  provisionAgentWorktree: `orchestration/run-${startedAt}/${safeId(subjectPath)}`.
	 *
	 *  Extracted as a standalone helper so the formula is tested independently
	 *  of the worklist endpoint. */
	async function branchForRow(row: { startedAt: number; subjectPath: string }): Promise<string> {
		const { safeId } = await import('$lib/agents/dispatch/worktree-provision.ts');
		return `orchestration/run-${row.startedAt}/${safeId(row.subjectPath)}`;
	}

	test('simple ADR path', async () => {
		const branch = await branchForRow({
			startedAt: 1716000000000,
			subjectPath: 'projects/soul-hub/adr-001-foo.md',
		});
		assert.equal(branch, 'orchestration/run-1716000000000/adr-001-foo');
	});

	test('path with no extension', async () => {
		const branch = await branchForRow({
			startedAt: 1716000001000,
			subjectPath: 'projects/some-project/my-task',
		});
		assert.equal(branch, 'orchestration/run-1716000001000/my-task');
	});

	test('path with special characters sanitized', async () => {
		const branch = await branchForRow({
			startedAt: 1716000002000,
			subjectPath: 'projects/foo/some file with spaces.md',
		});
		// safeId strips non-word non-dash → 'some-file-with-spaces'
		assert.ok(!branch.includes(' '), 'no spaces in branch name');
		assert.ok(branch.startsWith('orchestration/run-1716000002000/'));
	});

	test('deep nested path uses basename only', async () => {
		const branch = await branchForRow({
			startedAt: 1716000003000,
			subjectPath: 'a/b/c/d/adr-042-some-decision.md',
		});
		assert.equal(branch, 'orchestration/run-1716000003000/adr-042-some-decision');
	});

	test('matches current worktree branch pattern (regression)', async () => {
		// Verify against this run's own branch name used in the worktree directive.
		const branch = await branchForRow({
			startedAt: 1779811964636,
			subjectPath: 'projects/soul-hub/adr-026-async-dispatch-collaboration-surface.md',
		});
		assert.equal(
			branch,
			'orchestration/run-1779811964636/adr-026-async-dispatch-collaboration-surface',
		);
	});
});

// ── Suite 3: question extraction ──────────────────────────────────────────────

describe('question extraction from errorMessage', () => {
	/** Mirror the extraction logic in the worklist endpoint. */
	function extractQuestion(errorMessage: string | null): string {
		return (errorMessage ?? '').replace(/^OPERATOR_QUESTION:\s*/, '');
	}

	test('strips OPERATOR_QUESTION: prefix', () => {
		const q = extractQuestion('OPERATOR_QUESTION: Which environment should I target?');
		assert.equal(q, 'Which environment should I target?');
	});

	test('strips prefix with multiple spaces after colon', () => {
		const q = extractQuestion('OPERATOR_QUESTION:   What is the output path?');
		assert.equal(q, 'What is the output path?');
	});

	test('no prefix — returns as-is (edge case: legacy errorMessage)', () => {
		const q = extractQuestion('Something went wrong in the build step.');
		assert.equal(q, 'Something went wrong in the build step.');
	});

	test('null errorMessage → empty string', () => {
		const q = extractQuestion(null);
		assert.equal(q, '');
	});

	test('prefix only → empty question', () => {
		const q = extractQuestion('OPERATOR_QUESTION: ');
		assert.equal(q, '');
	});
});
