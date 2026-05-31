/**
 * ADR-014 — Fail-closed dispatch guard: no unisolated coding to a repo-less agent.
 *
 * Tests for D1: the routing layer refuses to resolve coding work to a repo-less
 * agent when a `repoMap` is provided.  Omitting `repoMap` preserves the
 * pre-ADR-014 behaviour (backward-compat path — all existing tests are unaffected).
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/dispatch-routing-repo-guard.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentForWork } from '../../src/lib/projects/dispatch-routing.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roster(...ids: string[]): Set<string> {
	return new Set(ids.map((id) => id.toLowerCase()));
}

function repoMap(entries: [string, string | undefined][]): Map<string, string | undefined> {
	return new Map(entries);
}

const FULL_ROSTER = roster(
	'soul-hub-implementer',
	'implementer',
	'developer',
	'researcher',
	'author',
	'designer',
	'media-generator',
);
const ROSTER_NO_IMPLEMENTER = roster(
	'implementer',
	'developer',
	'researcher',
	'author',
	'designer',
	'media-generator',
);

/** developer has a repo — the "configured correctly" scenario.
 *  ADR-011 — implementer is repo-less by design, so it carries `undefined`. */
const REPOS_DEV_HAS_REPO = repoMap([
	['developer', '~/dev/my-app'],
	['soul-hub-implementer', '~/dev/soul-hub'],
	['implementer', undefined],
	['researcher', undefined],
	['author', undefined],
	['designer', undefined],
	['media-generator', undefined],
]);

/** developer has NO repo — the ADR-014 incident scenario. */
const REPOS_DEV_NO_REPO = repoMap([
	['developer', undefined],
	['soul-hub-implementer', '~/dev/soul-hub'],
	['implementer', undefined],
	['researcher', undefined],
	['author', undefined],
]);

/** Neither developer nor soul-hub-implementer has a repo (fully misconfigured). */
const REPOS_ALL_EMPTY = repoMap([
	['developer', undefined],
	['soul-hub-implementer', undefined],
	['implementer', undefined],
	['researcher', undefined],
	['author', undefined],
]);

// ---------------------------------------------------------------------------
// D1 — floor agent: the incident scenario
// ---------------------------------------------------------------------------

describe('ADR-014 D1 — floor agent repo guard', () => {
	test('coding + floor implementer (no repo) + REPOS_DEV_HAS_REPO + no subjectHasProjectRepo → null (D1 guard fires on implementer)', () => {
		// ADR-011 — floor is now `implementer` (no static repo). Without
		// subjectHasProjectRepo the carve-out doesn't open → fail-closed.
		const result = resolveAgentForWork(
			'coding',
			null,
			ROSTER_NO_IMPLEMENTER,
			null,
			REPOS_DEV_HAS_REPO,
		);
		assert.equal(result, null);
	});

	test('coding + floor implementer (no repo) + subjectHasProjectRepo=true → returns implementer (ADR-011 D2 carve-out)', () => {
		// ADR-011 D2 — repo-less implementer + bound project = legitimate dispatch.
		const result = resolveAgentForWork(
			'coding',
			null,
			ROSTER_NO_IMPLEMENTER,
			null,
			REPOS_DEV_HAS_REPO,
			true,
		);
		assert.equal(result, 'implementer');
	});

	test('coding + floor implementer + REPOS_DEV_NO_REPO + no subjectHasProjectRepo → null (D1 guard fires)', () => {
		// implementer is repo-less and the carve-out doesn't open → null.
		const result = resolveAgentForWork(
			'coding',
			null,
			ROSTER_NO_IMPLEMENTER,
			null,
			REPOS_DEV_NO_REPO,
		);
		assert.equal(result, null);
	});

	test('coding + soul-hub cluster + soul-hub-implementer has repo → returns soul-hub-implementer', () => {
		const result = resolveAgentForWork(
			'coding',
			null,
			FULL_ROSTER,
			'soul-hub',
			REPOS_DEV_HAS_REPO,
		);
		assert.equal(result, 'soul-hub-implementer');
	});

	test('coding + soul-hub cluster + soul-hub-implementer has NO repo → falls to floor implementer (no repo) → null without subjectHasProjectRepo', () => {
		// soul-hub-implementer is misconfigured (no repo); falls through to floor implementer.
		// implementer is also repo-less by design → without subjectHasProjectRepo, null.
		const reposImplementerNoRepo = repoMap([
			['developer', '~/dev/my-app'],
			['soul-hub-implementer', undefined],
			['implementer', undefined],
		]);
		const result = resolveAgentForWork(
			'coding',
			null,
			FULL_ROSTER,
			'soul-hub',
			reposImplementerNoRepo,
		);
		assert.equal(result, null);
	});

	test('coding + soul-hub cluster + both implementer and developer have NO repo → null', () => {
		const result = resolveAgentForWork(
			'coding',
			null,
			FULL_ROSTER,
			'soul-hub',
			REPOS_ALL_EMPTY,
		);
		assert.equal(result, null);
	});

	test('coding + no cluster + both agents have NO repo → null', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, null, REPOS_ALL_EMPTY);
		assert.equal(result, null);
	});
});

// ---------------------------------------------------------------------------
// D1 — assignee override: skip repo-less assignee for coding work
// ---------------------------------------------------------------------------

describe('ADR-014 D1 — assignee repo guard', () => {
	test('coding + assignee HAS repo → returns assignee (guard passes)', () => {
		const result = resolveAgentForWork(
			'coding',
			'developer',
			FULL_ROSTER,
			null,
			REPOS_DEV_HAS_REPO,
		);
		assert.equal(result, 'developer');
	});

	test('coding + assignee has NO repo → skips, falls through to cluster routing', () => {
		// developer (explicit assignee) has no repo → skip.
		// soul-hub cluster → soul-hub-implementer which has repo → return it.
		const result = resolveAgentForWork(
			'coding',
			'developer',
			FULL_ROSTER,
			'soul-hub',
			REPOS_DEV_NO_REPO,
		);
		assert.equal(result, 'soul-hub-implementer');
	});

	test('coding + assignee has NO repo + no cluster + floor has NO repo → null', () => {
		// developer (explicit + floor) has no repo → null everywhere.
		const result = resolveAgentForWork(
			'coding',
			'developer',
			ROSTER_NO_IMPLEMENTER,
			null,
			REPOS_DEV_NO_REPO,
		);
		assert.equal(result, null);
	});

	test('coding + assignee soul-hub-implementer HAS repo → returns it', () => {
		const result = resolveAgentForWork(
			'coding',
			'soul-hub-implementer',
			FULL_ROSTER,
			'soul-hub',
			REPOS_DEV_HAS_REPO,
		);
		assert.equal(result, 'soul-hub-implementer');
	});
});

// ---------------------------------------------------------------------------
// D1 — non-coding work types are NEVER affected by repoMap
// ---------------------------------------------------------------------------

describe('ADR-014 D1 — non-coding work_types not affected by repoMap', () => {
	test('research → researcher even when researcher has no repo', () => {
		assert.equal(
			resolveAgentForWork('research', null, FULL_ROSTER, null, REPOS_ALL_EMPTY),
			'researcher',
		);
	});

	test('writing → author even when author has no repo', () => {
		assert.equal(
			resolveAgentForWork('writing', null, FULL_ROSTER, null, REPOS_ALL_EMPTY),
			'author',
		);
	});

	test('design → designer even when designer has no repo', () => {
		assert.equal(
			resolveAgentForWork('design', null, FULL_ROSTER, null, REPOS_ALL_EMPTY),
			'designer',
		);
	});

	test('media → media-generator even when it has no repo', () => {
		assert.equal(
			resolveAgentForWork('media', null, FULL_ROSTER, null, REPOS_ALL_EMPTY),
			'media-generator',
		);
	});

	test('non-coding assignee (researcher) with no repo → still returned for non-coding work', () => {
		// assignee=researcher, work_type=design → coding guard inactive → researcher returned
		assert.equal(
			resolveAgentForWork('design', 'researcher', FULL_ROSTER, null, REPOS_ALL_EMPTY),
			'researcher',
		);
	});
});

// ---------------------------------------------------------------------------
// D1 — backward compatibility (no repoMap provided)
// ---------------------------------------------------------------------------

describe('ADR-014 D1 — backward compatibility: repoMap absent → pre-ADR-014 behaviour', () => {
	test('coding + no cluster + no repoMap → implementer (post-ADR-011 floor, backward-compat path)', () => {
		// ADR-011 — WORK_TYPE_AGENT.coding = 'implementer'. Without a repoMap,
		// hasRepo returns true (no enforcement) → floor resolves to implementer.
		assert.equal(resolveAgentForWork('coding', null, ROSTER_NO_IMPLEMENTER, null), 'implementer');
	});

	test('coding + soul-hub cluster + no repoMap → soul-hub-implementer (existing behaviour)', () => {
		assert.equal(resolveAgentForWork('coding', null, FULL_ROSTER, 'soul-hub'), 'soul-hub-implementer');
	});

	test('coding + explicit assignee + no repoMap → assignee returned (existing behaviour)', () => {
		assert.equal(resolveAgentForWork('coding', 'developer', FULL_ROSTER, null), 'developer');
	});

	test('no repoMap + empty roster → null (existing behaviour)', () => {
		assert.equal(resolveAgentForWork('coding', null, new Set(), null), null);
	});
});

// ---------------------------------------------------------------------------
// D1 — edge cases
// ---------------------------------------------------------------------------

describe('ADR-014 D1 — edge cases', () => {
	test('repoMap has empty-string repo → treated as no repo (guard fires)', () => {
		const map = repoMap([['developer', '']]);
		assert.equal(resolveAgentForWork('coding', null, ROSTER_NO_IMPLEMENTER, null, map), null);
	});

	test('repoMap has whitespace-only repo → treated as no repo (guard fires)', () => {
		const map = repoMap([['developer', '   ']]);
		assert.equal(resolveAgentForWork('coding', null, ROSTER_NO_IMPLEMENTER, null, map), null);
	});

	test('repoMap does not contain the floor agent → hasRepo returns false → null', () => {
		// developer is in roster but not in the repoMap at all → key absent → undefined → guard fires
		const map = repoMap([['researcher', undefined]]);
		assert.equal(resolveAgentForWork('coding', null, ROSTER_NO_IMPLEMENTER, null, map), null);
	});

	test('coding + empty repoMap → all candidates missing → null', () => {
		const emptyMap = new Map<string, string | undefined>();
		assert.equal(resolveAgentForWork('coding', null, FULL_ROSTER, 'soul-hub', emptyMap), null);
	});
});
