/** ADR-022 branch-convention helper — `branchForRun` + `worktreeForRun`.
 *
 *  Bug fix regression test (2026-05-29). The two helpers consolidate the
 *  "what branch / worktree does this run live on" contract that was leaked
 *  into 8 call sites and broken by ADR-022 (which changed
 *  `orchestration/run-X/Y` → `claude-soul/Y` and `.worktrees/run-X-Y` →
 *  `.worktrees/Y`).
 *
 *  Helper imports `parseHandback` (pure) and `safeId` (pure) — both have no
 *  side-effect imports, so we can import the production fn directly (no
 *  mirror-pattern needed). */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	branchForRun,
	worktreeForRun,
	RUN_BRANCH_GLOBS,
} from '../../src/lib/agents/dispatch/run-branch.ts';
import type { AgentRunRow } from '../../src/lib/agents/runs.ts';

/** Minimal AgentRunRow stub. Fields not touched by the helpers are filler. */
function mkRun(overrides: Partial<AgentRunRow> = {}): AgentRunRow {
	return {
		id: 1,
		runId: 'r-abc',
		agentId: 'soul-hub-implementer',
		backend: 'claude-pty',
		model: null,
		provider: null,
		mode: 'production',
		taskSpec: 't',
		sourceMessage: null,
		jid: null,
		startedAt: 1780000000000,
		finishedAt: null,
		durationMs: null,
		status: 'running',
		costUsd: 0,
		numTurns: 0,
		resultExcerpt: null,
		errorMessage: null,
		claudeSessionId: null,
		subjectPath: null,
		handback: null,
		repo: null,
		phase: null,
		...overrides,
	} as AgentRunRow;
}

// A realistic handback JSON — modelled on run 522's actual stored hand-back
// from the bug-witness investigation. The shape matches what parseHandback
// returns: a fenced ```json block with at least { branch: "..." }.
function handbackJson(branch: string): string {
	return `\`\`\`json
{
  "branch": "${branch}",
  "commits": ["cd1807d feat(projects): foo"],
  "files_changed": ["src/x.ts"],
  "summary": "did the thing"
}
\`\`\``;
}

describe('branchForRun — ADR-022 contract', () => {
	test('Tier 1: handback.branch present → returned verbatim (authoritative)', () => {
		const run = mkRun({
			subjectPath: 'projects/x/adr-001.md',
			// Subject would reconstruct to `claude-soul/adr-001`, but handback wins.
			handback: handbackJson('claude-soul/some-other-branch'),
		});
		assert.strictEqual(branchForRun(run), 'claude-soul/some-other-branch');
	});

	test('Tier 1: handback.branch wins even when subjectPath would reconstruct differently', () => {
		// Run #522 case from the bug: subjectPath points at adr-025, handback
		// says claude-soul/adr-025-..., reconstruction would yield the same
		// thing — but the *contract* is that handback is authoritative.
		const run = mkRun({
			subjectPath: 'projects/projects-graph/adr-025-foo.md',
			handback: handbackJson('claude-soul/adr-025-foo'),
		});
		assert.strictEqual(branchForRun(run), 'claude-soul/adr-025-foo');
	});

	test('Tier 2: handback null + subjectPath set → ADR-022 reconstruction', () => {
		const run = mkRun({
			subjectPath: 'projects/projects-graph/adr-025-per-project-repo-binding-capability-routing.md',
			handback: null,
		});
		assert.strictEqual(
			branchForRun(run),
			'claude-soul/adr-025-per-project-repo-binding-capability-routing',
		);
	});

	test('Tier 2: handback present but branch field empty → fall to reconstruction', () => {
		// Robustness — bad handback shouldn't poison the result.
		const run = mkRun({
			subjectPath: 'projects/x/adr-001.md',
			handback: '```json\n{"branch": "", "summary": "wat"}\n```',
		});
		assert.strictEqual(branchForRun(run), 'claude-soul/adr-001');
	});

	test('Tier 2: malformed handback JSON → fall to reconstruction (parser tolerant)', () => {
		const run = mkRun({
			subjectPath: 'projects/x/adr-001.md',
			handback: 'not even close to JSON, just garbage',
		});
		assert.strictEqual(branchForRun(run), 'claude-soul/adr-001');
	});

	test('Tier 3: no handback + no subjectPath + startedAt set → legacy reconstruction', () => {
		// Pre-ADR-022 runs without subjectPath (rare — most coding dispatches
		// always had subjectPath) still get a deterministic branch name.
		// `safeId('')` returns 'task' (the safeId fallback), so the slug
		// portion is `'task'` rather than empty.
		const run = mkRun({
			subjectPath: null,
			handback: null,
			startedAt: 1779000000000,
		});
		assert.strictEqual(branchForRun(run), 'orchestration/run-1779000000000/task');
	});
});

describe('worktreeForRun — ADR-022 contract', () => {
	test('subjectPath set → per-ADR worktree dir (ADR-022 convention)', () => {
		const run = mkRun({
			subjectPath: 'projects/projects-graph/adr-025-foo.md',
		});
		assert.strictEqual(
			worktreeForRun(run, '/Users/jneaimi/dev/soul-hub'),
			'/Users/jneaimi/dev/soul-hub/.worktrees/adr-025-foo',
		);
	});

	test('no subjectPath → legacy per-run dir', () => {
		// safeId('') = 'task' (same fallback as branchForRun Tier 3).
		const run = mkRun({
			subjectPath: null,
			startedAt: 1779000000000,
		});
		assert.strictEqual(
			worktreeForRun(run, '/Users/jneaimi/dev/soul-hub'),
			'/Users/jneaimi/dev/soul-hub/.worktrees/run-1779000000000-task',
		);
	});

	test('repoPath is joined safely (no double-slash, no traversal)', () => {
		const run = mkRun({ subjectPath: 'projects/x/adr-001.md' });
		const path = worktreeForRun(run, '/Users/jneaimi/dev/soul-hub/');
		// `join` collapses the trailing slash.
		assert.strictEqual(path, '/Users/jneaimi/dev/soul-hub/.worktrees/adr-001');
	});
});

describe('RUN_BRANCH_GLOBS', () => {
	test('covers both conventions in priority order (ADR-022 first)', () => {
		assert.deepStrictEqual(
			[...RUN_BRANCH_GLOBS],
			['claude-soul/*', 'orchestration/*'],
		);
	});
});
