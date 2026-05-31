/** ADR-020 P2 — `buildRedispatchPrompt` unit tests.
 *
 *  Verifies the structure of the auto-generated continuation prompt that
 *  primes a fresh dispatch with the prior run's status, branch, commit, and
 *  diff stat. Git is injected as a stub so the test doesn't need a real
 *  worktree. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildRedispatchPrompt,
	type GitRunner,
} from '../../src/lib/agents/dispatch/redispatch-prompt.ts';
import type { AgentRunRow } from '../../src/lib/agents/runs.ts';

/** Minimal AgentRunRow stub for tests; only the fields the builder reads. */
function priorRun(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
	return {
		id: 1,
		runId: 'abc12345',
		agentId: 'soul-hub-implementer',
		backend: 'claude-pty',
		model: 'sonnet-4.6',
		provider: 'anthropic',
		mode: 'production',
		taskSpec: 'previous task',
		sourceMessage: null,
		jid: null,
		startedAt: 1780000000000,
		finishedAt: 1780000300000, // 5 min later
		durationMs: 300000,
		status: 'error',
		costUsd: 9.51,
		numTurns: 60,
		resultExcerpt: null,
		errorMessage: null,
		claudeSessionId: 'sess-1',
		subjectPath: 'projects/x/adr-011-foo.md',
		handback: null,
		repo: '~/dev/soul-hub',
		phase: 'initial',
		...overrides,
	} as AgentRunRow;
}

const happyGit: GitRunner = async (args) => {
	if (args[0] === 'log') return 'b9077ec123456abcdef Initial scope + types\n';
	if (args[0] === 'diff') {
		return ` src/lib/agents/dispatch/foo.ts | 42 ++++++++++++++++
 src/lib/agents/dispatch/bar.ts | 18 ++++++++
 2 files changed, 60 insertions(+)
`;
	}
	return '';
};

const failingGit: GitRunner = async () => {
	throw new Error('not a git repo');
};

describe('buildRedispatchPrompt', () => {
	test('includes prior status, cost, turns, phase', async () => {
		const out = await buildRedispatchPrompt(
			{
				prior: priorRun({ status: 'error', costUsd: 9.51, numTurns: 60, phase: 'initial' }),
				worktreePath: '/repo/.worktrees/adr-011-foo',
				branch: 'claude-soul/adr-011-foo',
			},
			happyGit,
		);
		assert.match(out, /status `error`/);
		assert.match(out, /cost \$9\.51/);
		assert.match(out, /turns 60/);
		assert.match(out, /Phase\*\*: `initial`/);
	});

	test('embeds branch and worktree path', async () => {
		const out = await buildRedispatchPrompt(
			{
				prior: priorRun(),
				worktreePath: '/repo/.worktrees/adr-011-foo',
				branch: 'claude-soul/adr-011-foo',
			},
			happyGit,
		);
		assert.match(out, /Branch\*\*: `claude-soul\/adr-011-foo`/);
		assert.match(out, /Worktree\*\*: `\/repo\/\.worktrees\/adr-011-foo`/);
	});

	test('parses git log into truncated SHA + subject', async () => {
		const out = await buildRedispatchPrompt(
			{ prior: priorRun(), worktreePath: '/x', branch: 'b' },
			happyGit,
		);
		// 12-char truncated SHA + the subject line.
		assert.match(out, /Last commit\*\*: `b9077ec12345`/);
		assert.match(out, /Initial scope \+ types/);
	});

	test('embeds diff --stat verbatim inside a fenced block', async () => {
		const out = await buildRedispatchPrompt(
			{ prior: priorRun(), worktreePath: '/x', branch: 'b' },
			happyGit,
		);
		assert.match(out, /src\/lib\/agents\/dispatch\/foo\.ts \| 42/);
		assert.match(out, /2 files changed, 60 insertions/);
		// Inside a code fence
		assert.match(out, /```[\s\S]*src\/lib\/agents\/dispatch\/foo\.ts[\s\S]*```/);
	});

	test('operatorContext appears under "What\'s left to do"', async () => {
		const out = await buildRedispatchPrompt(
			{
				prior: priorRun(),
				worktreePath: '/x',
				branch: 'b',
				operatorContext: 'ship the gate-runner + update docs',
			},
			happyGit,
		);
		assert.match(out, /What's left to do[\s\S]*ship the gate-runner \+ update docs/);
		// No placeholder when context is provided.
		assert.doesNotMatch(out, /operator left this blank/);
	});

	test('missing operatorContext → placeholder text', async () => {
		const out = await buildRedispatchPrompt(
			{ prior: priorRun(), worktreePath: '/x', branch: 'b' },
			happyGit,
		);
		assert.match(out, /operator left this blank/);
	});

	test('git failure degrades gracefully (still useful prompt)', async () => {
		const out = await buildRedispatchPrompt(
			{ prior: priorRun(), worktreePath: '/x', branch: 'b' },
			failingGit,
		);
		// Both git lookups fall back to defaults.
		assert.match(out, /Last commit\*\*: `—`/);
		assert.match(out, /diff unavailable/);
		// Run metadata still appears.
		assert.match(out, /status `error`/);
	});

	test('null phase falls back to "initial"', async () => {
		const out = await buildRedispatchPrompt(
			{ prior: priorRun({ phase: null }), worktreePath: '/x', branch: 'b' },
			happyGit,
		);
		assert.match(out, /Phase\*\*: `initial`/);
	});

	test('null finishedAt renders as dash, not "NaN"', async () => {
		const out = await buildRedispatchPrompt(
			{ prior: priorRun({ finishedAt: null }), worktreePath: '/x', branch: 'b' },
			happyGit,
		);
		assert.match(out, /finished —/);
		assert.doesNotMatch(out, /NaN/);
	});

	test('runId appears in the H2 header for traceability', async () => {
		const out = await buildRedispatchPrompt(
			{ prior: priorRun({ runId: 'abc12345' }), worktreePath: '/x', branch: 'b' },
			happyGit,
		);
		assert.match(out, /## Continuation context \(auto-generated from prior run `abc12345`\)/);
	});

	test('reminds the agent to READ the diff before working', async () => {
		const out = await buildRedispatchPrompt(
			{ prior: priorRun(), worktreePath: '/x', branch: 'b' },
			happyGit,
		);
		// The phrasing is load-bearing — it's what prevents the agent from
		// redoing already-committed work. Lock the contract.
		assert.match(out, /READ the diff above first/);
		assert.match(out, /Do NOT redo work that's already committed/);
	});
});
