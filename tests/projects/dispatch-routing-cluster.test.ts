/**
 * projects-graph ADR-025 D2 — cluster-aware capability routing tests.
 *
 * Covers:
 *  - soul-hub cluster + coding → soul-hub-implementer (happy path)
 *  - soul-hub cluster + coding, but implementer NOT in roster → developer
 *  - non-soul-hub cluster + coding → developer (unchanged)
 *  - no cluster + coding → developer (unchanged — existing behaviour)
 *  - assignee override still wins over cluster signal
 *  - research / writing / design / media unaffected by cluster
 *  - clusterFromTags: happy path, sad path, edge cases
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/dispatch-routing-cluster.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentForWork, clusterFromTags } from '../../src/lib/projects/dispatch-routing.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Set<string> of roster agent ids (already lowercased). */
function roster(...ids: string[]): Set<string> {
	return new Set(ids.map((id) => id.toLowerCase()));
}

/** Full roster that includes soul-hub-implementer. */
const FULL_ROSTER = roster(
	'soul-hub-implementer',
	'developer',
	'researcher',
	'author',
	'designer',
	'media-generator',
);

/** Roster WITHOUT soul-hub-implementer (not installed). */
const ROSTER_NO_IMPLEMENTER = roster('developer', 'researcher', 'author', 'designer', 'media-generator');

// ---------------------------------------------------------------------------
// clusterFromTags
// ---------------------------------------------------------------------------

describe('clusterFromTags', () => {
	test('returns the cluster slug from a cluster: tag', () => {
		assert.equal(clusterFromTags(['soul-hub', 'cluster:soul-hub', 'adr']), 'soul-hub');
	});

	test('works when cluster tag is the only tag', () => {
		assert.equal(clusterFromTags(['cluster:my-cluster']), 'my-cluster');
	});

	test('returns null when no cluster tag present', () => {
		assert.equal(clusterFromTags(['soul-hub', 'workbench', 'dispatch']), null);
	});

	test('returns null for empty tags array', () => {
		assert.equal(clusterFromTags([]), null);
	});

	test('is case-insensitive (CLUSTER:SOUL-HUB)', () => {
		assert.equal(clusterFromTags(['CLUSTER:SOUL-HUB']), 'soul-hub');
	});

	test('returns null when cluster: tag has empty slug', () => {
		assert.equal(clusterFromTags(['cluster:']), null);
	});

	test('handles cluster: tag with leading/trailing whitespace on tag', () => {
		assert.equal(clusterFromTags(['  cluster:soul-hub  ']), 'soul-hub');
	});

	test('takes the first cluster: tag when multiple present', () => {
		assert.equal(clusterFromTags(['cluster:soul-hub', 'cluster:other']), 'soul-hub');
	});
});

// ---------------------------------------------------------------------------
// resolveAgentForWork — D2 cluster routing
// ---------------------------------------------------------------------------

describe('resolveAgentForWork — D2 cluster routing', () => {
	test('coding + soul-hub cluster → soul-hub-implementer when in roster', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, 'soul-hub');
		assert.equal(result, 'soul-hub-implementer');
	});

	test('coding + soul-hub cluster but implementer NOT in roster → developer', () => {
		const result = resolveAgentForWork('coding', null, ROSTER_NO_IMPLEMENTER, 'soul-hub');
		assert.equal(result, 'developer');
	});

	test('coding + non-soul-hub cluster → developer (not soul-hub-implementer)', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, 'my-app');
		assert.equal(result, 'developer');
	});

	test('coding + no cluster (null) → developer (existing behaviour unchanged)', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, null);
		assert.equal(result, 'developer');
	});

	test('coding + no cluster (undefined, 4th arg absent) → developer (backwards-compat)', () => {
		const result = resolveAgentForWork('coding', null, FULL_ROSTER);
		assert.equal(result, 'developer');
	});

	test('coding + soul-hub cluster → soul-hub-implementer (empty-string cluster is falsy, not soul-hub)', () => {
		// empty string is NOT 'soul-hub'
		const result = resolveAgentForWork('coding', null, FULL_ROSTER, '');
		assert.equal(result, 'developer');
	});
});

// ---------------------------------------------------------------------------
// resolveAgentForWork — assignee override always wins (row 1)
// ---------------------------------------------------------------------------

describe('resolveAgentForWork — assignee override', () => {
	test('explicit assignee in roster beats soul-hub cluster routing', () => {
		// Even if cluster says soul-hub and implementer is available, an explicit
		// assignee that IS in the roster is the operator's authoritative choice.
		const result = resolveAgentForWork('coding', 'researcher', FULL_ROSTER, 'soul-hub');
		assert.equal(result, 'researcher');
	});

	test('explicit assignee in roster beats default work_type mapping', () => {
		const result = resolveAgentForWork('design', 'researcher', FULL_ROSTER, null);
		assert.equal(result, 'researcher');
	});

	test('assignee NOT in roster is ignored, falls through to cluster routing', () => {
		// 'custom-agent' is not in roster → should fall through to D2 cluster rule.
		const result = resolveAgentForWork('coding', 'custom-agent', FULL_ROSTER, 'soul-hub');
		assert.equal(result, 'soul-hub-implementer');
	});

	test('assignee NOT in roster is ignored, falls through to default mapping', () => {
		const result = resolveAgentForWork('research', 'ghost-agent', FULL_ROSTER, null);
		assert.equal(result, 'researcher');
	});
});

// ---------------------------------------------------------------------------
// resolveAgentForWork — non-coding work_types unaffected by cluster (row 3)
// ---------------------------------------------------------------------------

describe('resolveAgentForWork — non-coding work_types unchanged', () => {
	test('research → researcher regardless of soul-hub cluster', () => {
		assert.equal(resolveAgentForWork('research', null, FULL_ROSTER, 'soul-hub'), 'researcher');
	});

	test('writing → author regardless of soul-hub cluster', () => {
		assert.equal(resolveAgentForWork('writing', null, FULL_ROSTER, 'soul-hub'), 'author');
	});

	test('design → designer regardless of soul-hub cluster', () => {
		assert.equal(resolveAgentForWork('design', null, FULL_ROSTER, 'soul-hub'), 'designer');
	});

	test('media → media-generator regardless of soul-hub cluster', () => {
		assert.equal(resolveAgentForWork('media', null, FULL_ROSTER, 'soul-hub'), 'media-generator');
	});

	test('decision → null (human-owned, no cluster effect)', () => {
		assert.equal(resolveAgentForWork('decision', null, FULL_ROSTER, 'soul-hub'), null);
	});

	test('manual → null (human-owned, no cluster effect)', () => {
		assert.equal(resolveAgentForWork('manual', null, FULL_ROSTER, 'soul-hub'), null);
	});
});

// ---------------------------------------------------------------------------
// resolveAgentForWork — null/missing roster fallback
// ---------------------------------------------------------------------------

describe('resolveAgentForWork — empty roster edge cases', () => {
	test('returns null when roster is empty', () => {
		assert.equal(resolveAgentForWork('coding', null, new Set(), 'soul-hub'), null);
	});

	test('returns null when work_type is null and no assignee', () => {
		assert.equal(resolveAgentForWork(null, null, FULL_ROSTER, 'soul-hub'), null);
	});

	test('returns null when work_type is empty string', () => {
		assert.equal(resolveAgentForWork('', null, FULL_ROSTER, null), null);
	});
});
