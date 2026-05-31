/**
 * ADR-011 D2 — Name-specific subjectHasProjectRepo carve-out for the general
 *              `implementer` agent.
 *
 * Covers (§4 of the ADR-011 finish dispatch task body):
 *  1. Soul-hub cluster + soul-hub-implementer installed → routes to
 *     soul-hub-implementer (regression — cluster path unchanged).
 *  2. Non-soul-hub cluster + bound project + implementer in roster → routes
 *     to 'implementer' (the keystone for ADR-011 D1's general path).
 *  3. Non-soul-hub cluster + UNBOUND project + implementer in roster → null
 *     (ADR-014 fail-closed preserved when no project repo).
 *  4. Explicit assignee=implementer + bound project → routes to 'implementer'
 *     (operator override + carve-out).
 *  5. Explicit assignee=implementer + unbound project → falls through to
 *     floor → null (no silent unisolated run on operator misconfig).
 *  6. **KEYSTONE** — Explicit assignee=developer + bound project →
 *     falls through to floor → 'implementer' (NOT 'developer'). The
 *     name-specific carve-out must NOT open for `developer`. If a blanket
 *     `(hasRepo || subjectHasProjectRepo)` check had been used, this test
 *     would fail (it would route to 'developer' and edit jasem-profile-app
 *     in the wrong worktree). This is the muscle-memory protection
 *     ADR-011 D2 §3 was written to guarantee.
 *  7. Explicit assignee=developer + unbound project → null (ADR-014
 *     unchanged).
 *  8. Non-coding work_type → unchanged behavior; no implementer leakage.
 *
 * Run via:
 *   node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *     tests/projects/dispatch-routing-implementer-carveout.test.ts
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

/** Full roster — both implementers + developer (legacy, retiring) installed. */
const FULL_ROSTER = roster(
	'soul-hub-implementer',
	'implementer',
	'developer',
	'researcher',
	'author',
	'designer',
	'media-generator',
);

/** Repo map reflecting the real world post-ADR-011:
 *  - soul-hub-implementer has a static repo (specialized agent).
 *  - implementer has NO static repo (load-bearing — repo comes from the project).
 *  - developer has NO repo (ADR-014 incident scenario; retires under ADR-031 P3). */
const REPOS = repoMap([
	['soul-hub-implementer', '~/dev/soul-hub'],
	['implementer', undefined],
	['developer', undefined],
	['researcher', undefined],
	['author', undefined],
	['designer', undefined],
	['media-generator', undefined],
]);

// ---------------------------------------------------------------------------
// Case 1 — Soul-hub cluster regression check
// ---------------------------------------------------------------------------

describe('ADR-011 D2 — Case 1: soul-hub cluster routing unchanged', () => {
	test('soul-hub cluster + soul-hub-implementer installed → routes to soul-hub-implementer', () => {
		// Independent of subjectHasProjectRepo — the cluster path is checked BEFORE
		// the floor + carve-out logic. soul-hub-implementer has its static repo.
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, 'soul-hub', REPOS, false);
		assert.equal(result, 'soul-hub-implementer');
	});

	test('soul-hub cluster routing also wins when subjectHasProjectRepo=true', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, 'soul-hub', REPOS, true);
		assert.equal(result, 'soul-hub-implementer');
	});
});

// ---------------------------------------------------------------------------
// Case 2 — Non-soul-hub cluster + bound project routes to implementer
// ---------------------------------------------------------------------------

describe('ADR-011 D2 — Case 2: bound project routes to general implementer', () => {
	test('non-soul-hub cluster + bound project + implementer in roster → implementer', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, 'my-app', REPOS, true);
		assert.equal(result, 'implementer');
	});

	test('null cluster + bound project + implementer in roster → implementer', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, null, REPOS, true);
		assert.equal(result, 'implementer');
	});
});

// ---------------------------------------------------------------------------
// Case 3 — Unbound project preserves ADR-014 fail-closed
// ---------------------------------------------------------------------------

describe('ADR-011 D2 — Case 3: ADR-014 invariant preserved when no project repo', () => {
	test('non-soul-hub cluster + UNBOUND project + implementer in roster → null', () => {
		// The carve-out only opens when subjectHasProjectRepo is true. Without it,
		// the repo-less floor agent fails the hasRepo check → null.
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, 'my-app', REPOS, false);
		assert.equal(result, null);
	});

	test('null cluster + UNBOUND project + implementer in roster → null', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, null, REPOS, false);
		assert.equal(result, null);
	});

	test('subjectHasProjectRepo defaults to false when omitted → null', () => {
		// Backward-compat: callers that don't pass the 6th arg get the safe behavior.
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, null, REPOS);
		assert.equal(result, null);
	});
});

// ---------------------------------------------------------------------------
// Case 4 — Explicit assignee=implementer + bound project
// ---------------------------------------------------------------------------

describe('ADR-011 D2 — Case 4: explicit assignee=implementer + bound project', () => {
	test('assignee=implementer + bound project → implementer (operator override + carve-out)', () => {
		const result = resolveAgentForWork('coding', 'implementer', FULL_ROSTER, null, REPOS, true);
		assert.equal(result, 'implementer');
	});

	test('assignee=implementer + bound project + soul-hub cluster → still implementer (explicit wins)', () => {
		// The explicit-assignee path (row 1) wins over cluster routing (row 2).
		const result = resolveAgentForWork(
			'coding',
			'implementer',
			FULL_ROSTER,
			'soul-hub',
			REPOS,
			true,
		);
		assert.equal(result, 'implementer');
	});
});

// ---------------------------------------------------------------------------
// Case 5 — Explicit assignee=implementer + unbound project
// ---------------------------------------------------------------------------

describe('ADR-011 D2 — Case 5: explicit assignee=implementer + unbound project', () => {
	test('assignee=implementer + UNBOUND project → falls through to floor → null', () => {
		// The repo-less assignee is skipped at row 1 because the carve-out
		// requires subjectHasProjectRepo=true. Falls through to the floor,
		// which is ALSO implementer (repo-less) — same carve-out fails again → null.
		const result = resolveAgentForWork('coding', 'implementer', FULL_ROSTER, null, REPOS, false);
		assert.equal(result, null);
	});

	test('assignee=implementer + UNBOUND + soul-hub cluster → soul-hub-implementer (cluster wins after assignee skip)', () => {
		// Row 1 skips repo-less implementer (no carve-out). Row 2 (cluster) picks
		// soul-hub-implementer which has a static repo → success.
		const result = resolveAgentForWork(
			'coding',
			'implementer',
			FULL_ROSTER,
			'soul-hub',
			REPOS,
			false,
		);
		assert.equal(result, 'soul-hub-implementer');
	});
});

// ---------------------------------------------------------------------------
// Case 6 — KEYSTONE: assignee=developer + bound project must NOT route to developer
// ---------------------------------------------------------------------------

describe('ADR-011 D2 — Case 6 (KEYSTONE): muscle-memory protection — name-specific carve-out', () => {
	test('assignee=developer + bound project → falls through to floor → implementer (NOT developer)', () => {
		// THE LOAD-BEARING TEST. The name-specific carve-out `(a === 'implementer' && hasProjectRepo)`
		// must NOT open for `developer`. If a blanket `(hasRepo || subjectHasProjectRepo)` check
		// had been used, this test would fail — `developer` would be returned and the agent's
		// hardcoded `cd ~/dev/jasem-profile-app` prompt would attempt to edit the wrong repo
		// inside the bound project's worktree. The name check (`a === 'implementer'`) closes
		// that hole. See ADR-011 D2 §3 for the rationale.
		const result = resolveAgentForWork('coding', 'developer', FULL_ROSTER, null, REPOS, true);
		assert.equal(result, 'implementer');
		assert.notEqual(result, 'developer');
	});

	test('assignee=developer + bound project + non-soul-hub cluster → implementer (NOT developer)', () => {
		const result = resolveAgentForWork('coding', 'developer', FULL_ROSTER, 'my-app', REPOS, true);
		assert.equal(result, 'implementer');
		assert.notEqual(result, 'developer');
	});

	test('assignee=developer + bound project + soul-hub cluster → soul-hub-implementer (cluster path wins)', () => {
		// Row 1 skips repo-less developer (no carve-out for developer). Row 2 cluster
		// picks soul-hub-implementer. Floor never reached.
		const result = resolveAgentForWork(
			'coding',
			'developer',
			FULL_ROSTER,
			'soul-hub',
			REPOS,
			true,
		);
		assert.equal(result, 'soul-hub-implementer');
		assert.notEqual(result, 'developer');
	});

	test('symmetric check: any OTHER repo-less coding agent with bound project also rejected', () => {
		// Hypothetical: an operator adds a custom 'autodev' agent with no repo,
		// then sets assignee=autodev on a bound project. The carve-out must NOT
		// open for autodev — only for the named 'implementer'.
		const rosterWithAutodev = roster(
			'soul-hub-implementer',
			'implementer',
			'developer',
			'autodev',
			'researcher',
			'author',
			'designer',
			'media-generator',
		);
		const reposWithAutodev = repoMap([
			['soul-hub-implementer', '~/dev/soul-hub'],
			['implementer', undefined],
			['developer', undefined],
			['autodev', undefined],
		]);
		const result = resolveAgentForWork(
			'coding',
			'autodev',
			rosterWithAutodev,
			null,
			reposWithAutodev,
			true,
		);
		// autodev should be skipped (repo-less + not implementer) → fall through
		// to floor → implementer (which DOES get the carve-out) → 'implementer'.
		assert.equal(result, 'implementer');
		assert.notEqual(result, 'autodev');
	});
});

// ---------------------------------------------------------------------------
// Case 7 — Explicit assignee=developer + unbound project → null (ADR-014 unchanged)
// ---------------------------------------------------------------------------

describe('ADR-011 D2 — Case 7: assignee=developer + unbound project preserves ADR-014', () => {
	test('assignee=developer + UNBOUND project → null (no carve-out, ADR-014 holds)', () => {
		// Row 1 skips repo-less developer (no carve-out, subjectHasProjectRepo=false).
		// Row 2 cluster is null. Row 3 floor (implementer) also fails the carve-out
		// (subjectHasProjectRepo=false) → null.
		const result = resolveAgentForWork('coding', 'developer', FULL_ROSTER, null, REPOS, false);
		assert.equal(result, null);
	});

	test('assignee=developer + UNBOUND + non-soul-hub cluster → null', () => {
		const result = resolveAgentForWork('coding', 'developer', FULL_ROSTER, 'my-app', REPOS, false);
		assert.equal(result, null);
	});
});

// ---------------------------------------------------------------------------
// Case 8 — Non-coding work_types unaffected by the carve-out
// ---------------------------------------------------------------------------

describe('ADR-011 D2 — Case 8: non-coding work_types unaffected (no implementer leakage)', () => {
	test('research → researcher regardless of subjectHasProjectRepo', () => {
		assert.equal(
			resolveAgentForWork('research', null, FULL_ROSTER, null, REPOS, true),
			'researcher',
		);
		assert.equal(
			resolveAgentForWork('research', null, FULL_ROSTER, null, REPOS, false),
			'researcher',
		);
	});

	test('writing → author regardless of subjectHasProjectRepo', () => {
		assert.equal(resolveAgentForWork('writing', null, FULL_ROSTER, null, REPOS, true), 'author');
		assert.equal(resolveAgentForWork('writing', null, FULL_ROSTER, null, REPOS, false), 'author');
	});

	test('design → designer regardless of subjectHasProjectRepo', () => {
		assert.equal(
			resolveAgentForWork('design', null, FULL_ROSTER, null, REPOS, true),
			'designer',
		);
		assert.equal(
			resolveAgentForWork('design', null, FULL_ROSTER, null, REPOS, false),
			'designer',
		);
	});

	test('media → media-generator regardless of subjectHasProjectRepo', () => {
		assert.equal(
			resolveAgentForWork('media', null, FULL_ROSTER, null, REPOS, true),
			'media-generator',
		);
	});

	test('decision/manual → null (human-owned, no implementer leakage)', () => {
		assert.equal(resolveAgentForWork('decision', null, FULL_ROSTER, null, REPOS, true), null);
		assert.equal(resolveAgentForWork('manual', null, FULL_ROSTER, null, REPOS, true), null);
	});
});
