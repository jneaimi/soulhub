/** ADR-030 — resolveProjectRepo unit tests.
 *
 *  Suite 1: resolveProjectRepo — pure helper. Verifies that the project's
 *  `repo` frontmatter is returned when present, `undefined` is returned when
 *  absent, and that the function short-circuits gracefully for non-project
 *  paths, missing index notes, and blank values.
 *
 *  Suite 2: effectiveRepo fallback contract — documents the dispatch-time
 *  fallback logic:  `resolveProjectRepo(…) ?? agent.repo`  so the dispatcher
 *  is backward-compatible: projects with no `repo` resolve to `agent.repo`,
 *  which is identical to pre-ADR-030 ADR-010 behaviour.
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/resolve-project-repo.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Suite 1: resolveProjectRepo ───────────────────────────────────────────────

describe('resolveProjectRepo', () => {
	// ── helpers ───────────────────────────────────────────────────────────────

	/** Build a minimal getNote stub that returns a note with the given meta. */
	function makeGetNote(indexPath: string, meta: Record<string, unknown>) {
		return (path: string) => (path === indexPath ? { meta } : undefined);
	}

	/** A getNote that always returns undefined (no vault indexed). */
	function noNote(_path: string) {
		return undefined;
	}

	// ── tests ─────────────────────────────────────────────────────────────────

	test('returns repo when project index note has a repo field', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const getNote = makeGetNote('projects/my-webapp/index.md', { repo: '~/dev/my-webapp' });
		const result = resolveProjectRepo('projects/my-webapp/some-adr.md', getNote);
		assert.equal(result, '~/dev/my-webapp');
	});

	test('trims leading/trailing whitespace from the repo value', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const getNote = makeGetNote('projects/foo/index.md', { repo: '  ~/dev/foo  ' });
		const result = resolveProjectRepo('projects/foo/bar.md', getNote);
		assert.equal(result, '~/dev/foo');
	});

	test('returns undefined when project index note has no repo field', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const getNote = makeGetNote('projects/soul-hub/index.md', { type: 'project' });
		const result = resolveProjectRepo('projects/soul-hub/adr-001.md', getNote);
		assert.equal(result, undefined);
	});

	test('returns undefined when repo field is an empty string', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const getNote = makeGetNote('projects/soul-hub/index.md', { repo: '' });
		assert.equal(resolveProjectRepo('projects/soul-hub/adr-001.md', getNote), undefined);
	});

	test('returns undefined when repo field is whitespace only', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const getNote = makeGetNote('projects/soul-hub/index.md', { repo: '   ' });
		assert.equal(resolveProjectRepo('projects/soul-hub/adr-001.md', getNote), undefined);
	});

	test('returns undefined when repo field is not a string (e.g. number)', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const getNote = makeGetNote('projects/foo/index.md', { repo: 42 });
		assert.equal(resolveProjectRepo('projects/foo/adr-001.md', getNote), undefined);
	});

	test('returns undefined when project index note is not indexed', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		assert.equal(resolveProjectRepo('projects/ghost/adr-001.md', noNote), undefined);
	});

	test('returns undefined for non-project paths (knowledge zone)', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		assert.equal(
			resolveProjectRepo('knowledge/patterns/2026-05-27-foo.md', noNote),
			undefined,
		);
	});

	test('returns undefined for bare project path without trailing slash part', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		// A bare `projects/<slug>` without any sub-path won't match the pattern.
		assert.equal(resolveProjectRepo('projects/soul-hub', noNote), undefined);
	});

	test('returns undefined for undefined subjectPath', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		assert.equal(resolveProjectRepo(undefined, noNote), undefined);
	});

	test('looks up the correct project slug from a nested artifact path', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		// Artifact is two levels deep under the project — slug extraction must
		// match only `projects/<slug>/` at the path start.
		let lookedUp = '';
		const getNote = (p: string) => {
			lookedUp = p;
			return undefined;
		};
		resolveProjectRepo('projects/deep-app/decisions/adr-001.md', getNote);
		assert.equal(lookedUp, 'projects/deep-app/index.md');
	});
});

// ── Suite 2: effectiveRepo fallback contract ──────────────────────────────────

describe('effectiveRepo fallback (ADR-030 backward-compat contract)', () => {
	test('project with repo → effectiveRepo is the project repo, not agent.repo', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const projectRepo = '~/dev/my-webapp';
		const agentRepo = '~/dev/soul-hub';
		const getNote = (p: string) =>
			p === 'projects/my-webapp/index.md' ? { meta: { repo: projectRepo } } : undefined;
		const resolved = resolveProjectRepo('projects/my-webapp/adr-001.md', getNote);
		const effectiveRepo = resolved ?? agentRepo;
		assert.equal(effectiveRepo, projectRepo, 'project repo wins when present');
	});

	test('project without repo → effectiveRepo falls back to agent.repo (ADR-010 unchanged)', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const agentRepo = '~/dev/soul-hub';
		const getNote = (p: string) =>
			p === 'projects/soul-hub/index.md' ? { meta: { type: 'project' } } : undefined;
		const resolved = resolveProjectRepo('projects/soul-hub/adr-001.md', getNote);
		const effectiveRepo = resolved ?? agentRepo;
		assert.equal(effectiveRepo, agentRepo, 'agent repo is the fallback when project has none');
	});

	test('no subjectPath → effectiveRepo falls back to agent.repo', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const agentRepo = '~/dev/soul-hub';
		const resolved = resolveProjectRepo(undefined, () => undefined);
		const effectiveRepo = resolved ?? agentRepo;
		assert.equal(effectiveRepo, agentRepo);
	});

	test('non-project subjectPath → effectiveRepo falls back to agent.repo', async () => {
		const { resolveProjectRepo } = await import(
			'$lib/agents/dispatch/resolve-project-repo.ts'
		);
		const agentRepo = '~/dev/soul-hub';
		const resolved = resolveProjectRepo('inbox/quick-note.md', () => undefined);
		const effectiveRepo = resolved ?? agentRepo;
		assert.equal(effectiveRepo, agentRepo);
	});
});
