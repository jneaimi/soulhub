/**
 * ADR-002 — resolveScope unit tests.
 *
 * Falsifier (from ADR-002):
 *   1. `resolveScope` on a `/projects/[slug]` route returns:
 *        - `kind: 'project'`
 *        - chip labelled with the slug
 *        - non-empty `contextPayload` containing ≥1 of the project's open decisions
 *        - `cwd` = the project's bound repo (or soul-hub when unbound)
 *   2. `resolveScope` on an unregistered route returns:
 *        - `kind: 'global'`
 *        - non-empty `contextPayload` + valid cwd
 *        - never null / never throws
 *
 * All tests use injected fake `ScopeReader` — no live vault needed.
 *
 * Run with:
 *   node --import ./tests/chat/register.mjs --test --experimental-strip-types \
 *     tests/chat/resolve-scope.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ScopeReader, NoteScopeShape, NoteListItem } from '$lib/chat/scope/types.ts';

// ── Fake ScopeReader helpers ──────────────────────────────────────────────────

/**
 * Build a ScopeReader that:
 *   - returns `indexMeta` + `indexContent` for `projects/<slug>/index.md`
 *   - returns `decisions` when `listProjectNotes(slug, { type:'decision' })` is called
 */
function makeReader(opts: {
	slug: string;
	indexMeta?: Record<string, unknown>;
	indexContent?: string;
	decisions?: Array<{ title: string; status?: string }>;
}): ScopeReader {
	const { slug, indexMeta = {}, indexContent = '', decisions = [] } = opts;

	const decisionItems: NoteListItem[] = decisions.map((d, i) => ({
		path: `projects/${slug}/adr-00${i + 1}-${d.title.toLowerCase().replace(/\s+/g, '-')}.md`,
		title: d.title,
		meta: { type: 'decision', status: d.status ?? 'proposed' },
	}));

	return {
		getNote(path: string): NoteScopeShape | undefined {
			if (path === `projects/${slug}/index.md`) {
				return {
					meta: { type: 'project', ...indexMeta },
					content: indexContent,
					title: slug,
				};
			}
			return undefined;
		},
		listProjectNotes(
			projectSlug: string,
			_opts?: { type?: string },
		): NoteListItem[] {
			if (projectSlug === slug) return decisionItems;
			return [];
		},
	};
}

/** A reader that always returns undefined / empty arrays (nothing indexed). */
const emptyReader: ScopeReader = {
	getNote: () => undefined,
	listProjectNotes: () => [],
};

// ── Suite 1: Project contributor ──────────────────────────────────────────────

describe('resolveScope — project contributor', () => {
	test('returns kind:project for /projects/[slug] route', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'soul-hub' });
		const result = resolveScope('/projects/[slug]', { slug: 'soul-hub' }, reader);
		assert.equal(result.kind, 'project');
	});

	test('chip label contains the slug', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'soul-hub' });
		const result = resolveScope('/projects/[slug]', { slug: 'soul-hub' }, reader);
		assert.ok(result.chip.label.includes('soul-hub'), `label "${result.chip.label}" should contain slug`);
	});

	test('chip has a non-empty icon', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'soul-hub' });
		const result = resolveScope('/projects/[slug]', { slug: 'soul-hub' }, reader);
		assert.ok(result.chip.icon.length > 0);
	});

	test('contextPayload is non-empty', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'my-project' });
		const result = resolveScope('/projects/[slug]', { slug: 'my-project' }, reader);
		assert.ok(result.contextPayload.trim().length > 0);
	});

	test('contextPayload contains ≥1 open decision when decisions exist (ADR-002 falsifier)', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({
			slug: 'soul-hub-chat',
			decisions: [
				{ title: 'ADR-001 Conversational layer foundation', status: 'accepted' },
				{ title: 'ADR-003 Orchestrator web engine', status: 'proposed' },
				{ title: 'ADR-004 Chat drawer UI', status: 'proposed' },
			],
		});
		const result = resolveScope('/projects/[slug]', { slug: 'soul-hub-chat' }, reader);
		// At least one decision title must appear in the payload
		const hasDecision =
			result.contextPayload.includes('ADR-001') ||
			result.contextPayload.includes('ADR-003') ||
			result.contextPayload.includes('ADR-004');
		assert.ok(hasDecision, `contextPayload should list open decisions:\n${result.contextPayload}`);
	});

	test('shipped decisions are excluded from contextPayload', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({
			slug: 'soul-hub-chat',
			decisions: [
				{ title: 'Old shipped decision', status: 'shipped' },
				{ title: 'Active proposed decision', status: 'proposed' },
			],
		});
		const result = resolveScope('/projects/[slug]', { slug: 'soul-hub-chat' }, reader);
		assert.ok(
			!result.contextPayload.includes('Old shipped decision'),
			'shipped decisions must not appear in payload',
		);
		assert.ok(
			result.contextPayload.includes('Active proposed decision'),
			'open decisions must appear in payload',
		);
	});

	test('cwd equals bound repo when project index has a repo field (ADR-002 falsifier)', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({
			slug: 'my-webapp',
			indexMeta: { repo: '~/dev/my-webapp' },
		});
		const result = resolveScope('/projects/[slug]', { slug: 'my-webapp' }, reader);
		assert.equal(result.cwd, '~/dev/my-webapp');
		assert.equal(result.repo, '~/dev/my-webapp');
	});

	test('cwd defaults to SOUL_HUB_REPO when project has no repo field (ADR-002 falsifier)', async () => {
		const { resolveScope, SOUL_HUB_REPO } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'unbound-project' });
		const result = resolveScope('/projects/[slug]', { slug: 'unbound-project' }, reader);
		assert.equal(result.cwd, SOUL_HUB_REPO);
		assert.equal(result.repo, null);
	});

	test('repo is null when project index has no repo field', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'no-repo-project' });
		const result = resolveScope('/projects/[slug]', { slug: 'no-repo-project' }, reader);
		assert.equal(result.repo, null);
	});

	test('primer is non-empty and references the slug', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'soul-hub' });
		const result = resolveScope('/projects/[slug]', { slug: 'soul-hub' }, reader);
		assert.ok(result.primer.trim().length > 0);
		assert.ok(result.primer.includes('soul-hub'), `primer should mention slug: ${result.primer}`);
	});

	test('also triggers for /projects/[slug]/queue route', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'my-project' });
		const result = resolveScope('/projects/[slug]/queue', { slug: 'my-project' }, reader);
		assert.equal(result.kind, 'project');
		assert.ok(result.chip.label.includes('my-project'));
	});

	test('project contextPayload includes index content when present', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({
			slug: 'test-project',
			indexContent: 'A description of what this project does.',
		});
		const result = resolveScope('/projects/[slug]', { slug: 'test-project' }, reader);
		assert.ok(result.contextPayload.includes('A description of what this project does.'));
	});

	test('handles project with no indexed notes gracefully (no throw)', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/projects/[slug]', { slug: 'ghost-project' }, emptyReader);
		assert.equal(result.kind, 'project');
		assert.ok(result.contextPayload.trim().length > 0);
	});
});

// ── Suite 2: Global fallback ──────────────────────────────────────────────────

describe('resolveScope — global fallback (ADR-002 falsifier)', () => {
	test('returns kind:global for an unregistered route', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/vault', {}, emptyReader);
		assert.equal(result.kind, 'global');
	});

	test('global contextPayload is non-empty', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/vault', {}, emptyReader);
		assert.ok(result.contextPayload.trim().length > 0);
	});

	test('global cwd equals SOUL_HUB_REPO', async () => {
		const { resolveScope, SOUL_HUB_REPO } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/vault', {}, emptyReader);
		assert.equal(result.cwd, SOUL_HUB_REPO);
	});

	test('global repo is null', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/vault', {}, emptyReader);
		assert.equal(result.repo, null);
	});

	test('returns kind:global for root route', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/', {}, emptyReader);
		assert.equal(result.kind, 'global');
	});

	test('returns kind:global for inbox route', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/inbox', {}, emptyReader);
		assert.equal(result.kind, 'global');
	});

	test('returns kind:global for /projects (list, not a slug page)', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/projects', {}, emptyReader);
		assert.equal(result.kind, 'global');
	});

	test('global primer is non-empty', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/settings', {}, emptyReader);
		assert.ok(result.primer.trim().length > 0);
	});

	test('fallback for /projects/[slug] with missing slug param → global', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		// params.slug is absent — contributor guard rejects it
		const result = resolveScope('/projects/[slug]', {}, emptyReader);
		assert.equal(result.kind, 'global');
	});

	test('fallback for /projects/[slug] with empty slug param → global', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/projects/[slug]', { slug: '' }, emptyReader);
		assert.equal(result.kind, 'global');
	});
});

// ── Suite 3: Invariants ───────────────────────────────────────────────────────

describe('resolveScope — invariants (never null, never throw)', () => {
	test('never returns null for a known project route', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'x' });
		const result = resolveScope('/projects/[slug]', { slug: 'x' }, reader);
		assert.ok(result !== null && result !== undefined);
	});

	test('never returns null for an unknown route', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/totally-unknown-route', {}, emptyReader);
		assert.ok(result !== null && result !== undefined);
	});

	test('contextPayload is never empty string for project scope', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'empty-project' });
		const result = resolveScope('/projects/[slug]', { slug: 'empty-project' }, reader);
		assert.notEqual(result.contextPayload.trim(), '');
	});

	test('contextPayload is never empty string for global scope', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/crm', {}, emptyReader);
		assert.notEqual(result.contextPayload.trim(), '');
	});

	test('cwd is always a non-empty string for project scope', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const reader = makeReader({ slug: 'p' });
		const result = resolveScope('/projects/[slug]', { slug: 'p' }, reader);
		assert.ok(typeof result.cwd === 'string' && result.cwd.length > 0);
	});

	test('cwd is always a non-empty string for global scope', async () => {
		const { resolveScope } = await import('$lib/chat/scope/resolve.ts');
		const result = resolveScope('/sessions', {}, emptyReader);
		assert.ok(typeof result.cwd === 'string' && result.cwd.length > 0);
	});
});
