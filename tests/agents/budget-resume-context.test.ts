/** Bug fix regression test — 2026-05-29.
 *
 *  `resumeWithRaisedBudget` (the Telegram-approval resume path) used to pass
 *  NEITHER `subjectPath` NOR `repo` to `dispatchAgent`. Three cascading
 *  consequences were witnessed in production on run `0f885fb0`:
 *
 *   1. The resumed start row had `subject_path = NULL`.
 *   2. `listRunningSubjectPaths()` therefore missed it → ADR-022 D3's
 *      concurrent-dispatch guard let a SECOND dispatch (`df910cef`) through
 *      against the SAME ADR. Two PTYs writing to one shared worktree —
 *      classic race.
 *   3. With no `subjectPath`, the dispatcher couldn't resolve the project
 *      repo → no worktree provisioned → resumed PTY ran in `cwd=vault`,
 *      blind to the prior dispatch's commits on `claude-soul/<adrKey>`.
 *
 *  The fix preserves the subjectPath + repo across pause → escalate → store →
 *  resume.
 *
 *  Test strategy: budget-escalation.ts imports Telegram side-effects whose
 *  TS syntax (parameter properties) node's strip-types mode can't handle.
 *  So we mirror the pure `buildApprovalRow` mapping locally (same pattern
 *  as derive-phase.test.ts and cumulative-spend.test.ts). Keep in sync with
 *  the production fn — the field list MUST match. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Local mirrors of the production types (keep field lists synced) ─────────

interface EscalateInput {
	runId: string;
	agentId: string;
	sessionUuid: string;
	task: string;
	ceilingUsd: number;
	ceilingTurns: number;
	reason: 'max_usd' | 'max_turns';
	spentUsd: number;
	turns: number;
	subjectPath?: string;
	repo?: string;
}

interface BudgetApprovalRow {
	runId: string;
	agentId: string;
	sessionUuid: string;
	task: string;
	ceilingUsd: number;
	ceilingTurns: number;
	reason: 'max_usd' | 'max_turns';
	spentUsd: number;
	turns: number;
	chatJid: string;
	messageId: number;
	createdAt: number;
	subjectPath?: string;
	repo?: string;
}

/** Mirror of `buildApprovalRow` from src/lib/agents/budget-escalation.ts.
 *  Keep field-for-field in sync with the production fn — that's the contract
 *  this test guards. */
function buildApprovalRow(
	input: EscalateInput,
	chatJid: string,
	messageId: number,
	now: number = Date.now(),
): BudgetApprovalRow {
	return {
		runId: input.runId,
		agentId: input.agentId,
		sessionUuid: input.sessionUuid,
		task: input.task,
		ceilingUsd: input.ceilingUsd,
		ceilingTurns: input.ceilingTurns,
		reason: input.reason,
		spentUsd: input.spentUsd,
		turns: input.turns,
		chatJid,
		messageId,
		createdAt: now,
		subjectPath: input.subjectPath,
		repo: input.repo,
	};
}

function mkInput(overrides: Partial<EscalateInput> = {}): EscalateInput {
	return {
		runId: 'r-abc',
		agentId: 'soul-hub-implementer',
		sessionUuid: '0f885fb0-b312-4a29-ac8b-43ae89192a15',
		task: 'do the thing',
		ceilingUsd: 8,
		ceilingTurns: 80,
		reason: 'max_usd',
		spentUsd: 8.07,
		turns: 41,
		...overrides,
	};
}

describe('buildApprovalRow — bug fix 2026-05-29 contract', () => {
	test('subjectPath flows from EscalateInput → BudgetApprovalRow', () => {
		const input = mkInput({
			subjectPath: 'projects/projects-graph/adr-025-per-project-repo-binding-capability-routing.md',
		});
		const row = buildApprovalRow(input, 'tg:1234', 567);
		assert.strictEqual(row.subjectPath, input.subjectPath);
	});

	test('repo flows from EscalateInput → BudgetApprovalRow', () => {
		const input = mkInput({ repo: '~/dev/soul-hub' });
		const row = buildApprovalRow(input, 'tg:1234', 567);
		assert.strictEqual(row.repo, '~/dev/soul-hub');
	});

	test('both fields preserved when both set', () => {
		const input = mkInput({
			subjectPath: 'projects/x/adr-001.md',
			repo: '~/dev/somerepo',
		});
		const row = buildApprovalRow(input, 'tg:1234', 567);
		assert.strictEqual(row.subjectPath, 'projects/x/adr-001.md');
		assert.strictEqual(row.repo, '~/dev/somerepo');
	});

	test('undefined when not set on input — backward-compat for non-artifact runs', () => {
		const input = mkInput();
		const row = buildApprovalRow(input, 'tg:1234', 567);
		assert.strictEqual(row.subjectPath, undefined);
		assert.strictEqual(row.repo, undefined);
	});

	test('non-field-fix data is also preserved (sanity check)', () => {
		const input = mkInput({
			subjectPath: 'projects/x/adr-001.md',
			repo: '~/dev/x',
		});
		const row = buildApprovalRow(input, 'tg:9999', 42, 1780000000000);
		assert.strictEqual(row.runId, 'r-abc');
		assert.strictEqual(row.agentId, 'soul-hub-implementer');
		assert.strictEqual(row.sessionUuid, input.sessionUuid);
		assert.strictEqual(row.task, 'do the thing');
		assert.strictEqual(row.ceilingUsd, 8);
		assert.strictEqual(row.ceilingTurns, 80);
		assert.strictEqual(row.reason, 'max_usd');
		assert.strictEqual(row.spentUsd, 8.07);
		assert.strictEqual(row.turns, 41);
		assert.strictEqual(row.chatJid, 'tg:9999');
		assert.strictEqual(row.messageId, 42);
		assert.strictEqual(row.createdAt, 1780000000000);
	});
});
