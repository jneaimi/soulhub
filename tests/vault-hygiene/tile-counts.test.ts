/** ADR-006 P2 — Falsifier test: tiles == list == post-suppression actionable set.
 *
 *  The ADR's core invariant is machine-checkable:
 *    For each of the 6 dispositionable buckets, the tile count EQUALS the
 *    array length EQUALS the count the list renders.
 *    governanceViolations and inboxDecisions are NOT counted as amber-actionable.
 *
 *  ADR-009 adds `adrImplementationDrift` as the 6th dispositionable bucket.
 *
 *  This test exercises the pure helper that both surfaces consume so the
 *  invariant is unit-verified without spinning up a browser or HTTP server.
 *
 *  Run:
 *    node --import ./tests/vault-hygiene/register.mjs \
 *         --test --experimental-strip-types \
 *         tests/vault-hygiene/tile-counts.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
	computeActionableCounts,
	sumActionable,
	DISPOSITIONABLE_KEYS,
	type ActionableCounts,
} from '../../src/lib/vault-hygiene/tile-counts.ts';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const makeReport = (
	overrides: Partial<{
		unresolved: unknown[];
		orphans: unknown[];
		staleInbox: unknown[];
		statusContradictions: unknown[];
		misplacedNotes: unknown[];
		adrImplementationDrift: unknown[];
	}> = {},
) => ({
	unresolved: [
		{ source: 'knowledge/a.md', raw: '[[missing-b]]' },
		{ source: 'projects/foo/index.md', raw: '[[gone]]' },
	],
	orphans: [{ path: 'knowledge/orphan.md', title: 'Orphan Note' }],
	staleInbox: [{ path: 'inbox/old-capture.md', title: 'Old capture', ageDays: 42 }],
	statusContradictions: [
		{ path: 'projects/triden-website/project.md', status: 'shipped', openTaskCount: 1 },
	],
	misplacedNotes: [
		{
			path: 'knowledge/cooking/recipes/vault-scout-task.md',
			title: 'Vault Scout Task',
			currentZone: 'knowledge',
			suggestedZone: 'projects',
			confidence: 'high' as const,
			reason: 'type:task with project reference',
			suggestedFix: 'Move to projects/',
		},
	],
	// ADR-009 — implementation drift: code merged but ADR status stale.
	adrImplementationDrift: [],
	...overrides,
});

// ─── computeActionableCounts ─────────────────────────────────────────────────

describe('computeActionableCounts', () => {
	test('returns counts equal to array lengths for all 6 dispositionable buckets', () => {
		const driftItems = [
			{
				path: 'projects/soul-hub-hygiene/adr-009-adr-status-reflects-merge.md',
				project: 'soul-hub-hygiene',
				slug: 'adr-009-adr-status-reflects-merge',
				currentStatus: 'proposed',
				mergeEvidence: 'abc1234 Merge branch \'orchestration/run-123/adr-009-adr-status-reflects-merge\'',
			},
		];
		const report = makeReport({ adrImplementationDrift: driftItems });
		const counts = computeActionableCounts(report);

		assert.equal(counts.unresolved, report.unresolved.length, 'unresolved');
		assert.equal(counts.orphans, report.orphans.length, 'orphans');
		assert.equal(counts.staleInbox, report.staleInbox.length, 'staleInbox');
		assert.equal(counts.statusContradictions, report.statusContradictions.length, 'statusContradictions');
		assert.equal(counts.misplacedNotes, report.misplacedNotes.length, 'misplacedNotes');
		assert.equal(counts.adrImplementationDrift, report.adrImplementationDrift.length, 'adrImplementationDrift');
	});

	test('returns zeros when all arrays are empty', () => {
		const report = makeReport({
			unresolved: [],
			orphans: [],
			staleInbox: [],
			statusContradictions: [],
			misplacedNotes: [],
			adrImplementationDrift: [],
		});
		const counts = computeActionableCounts(report);

		assert.deepEqual(counts, {
			unresolved: 0,
			orphans: 0,
			staleInbox: 0,
			statusContradictions: 0,
			misplacedNotes: 0,
			adrImplementationDrift: 0,
		});
	});

	test('handles large arrays (simulates ISSUE_LIST_CAP-sliced response)', () => {
		// Simulate a report where the API capped arrays at 20 items.
		// The tile must show 20 (what the list renders), NOT 25 (what totals.* would show).
		const fakeItems = Array.from({ length: 20 }, (_, i) => ({
			source: `f${i}.md`,
			raw: `[[link${i}]]`,
		}));
		const counts = computeActionableCounts(makeReport({ unresolved: fakeItems }));
		assert.equal(counts.unresolved, 20);
	});

	// ─── Honest-tiles invariant: non-dispositionable keys are NOT present ───

	test('governanceViolations is NOT a key in ActionableCounts', () => {
		const counts = computeActionableCounts(makeReport());
		assert.equal(
			Object.prototype.hasOwnProperty.call(counts, 'governanceViolations'),
			false,
			'governanceViolations must not be counted as amber-actionable',
		);
	});

	test('inboxDecisions is NOT a key in ActionableCounts', () => {
		const counts = computeActionableCounts(makeReport());
		assert.equal(
			Object.prototype.hasOwnProperty.call(counts, 'inboxDecisions'),
			false,
			'inboxDecisions must not be counted as amber-actionable',
		);
	});

	test('indexed is NOT a key in ActionableCounts', () => {
		const counts = computeActionableCounts(makeReport());
		assert.equal(
			Object.prototype.hasOwnProperty.call(counts, 'indexed'),
			false,
			'indexed must not appear in actionable counts',
		);
	});

	test('ActionableCounts has exactly the 6 dispositionable keys', () => {
		const counts = computeActionableCounts(makeReport());
		const keys = Object.keys(counts).sort();
		const expected = [...DISPOSITIONABLE_KEYS].sort();
		assert.deepEqual(keys, expected);
	});
});

// ─── sumActionable ───────────────────────────────────────────────────────────

describe('sumActionable', () => {
	test('sums all 6 bucket counts', () => {
		const counts: ActionableCounts = {
			unresolved: 3,
			orphans: 2,
			staleInbox: 1,
			statusContradictions: 4,
			misplacedNotes: 2,
			adrImplementationDrift: 1,
		};
		assert.equal(sumActionable(counts), 13);
	});

	test('returns 0 when all buckets are zero', () => {
		const counts: ActionableCounts = {
			unresolved: 0,
			orphans: 0,
			staleInbox: 0,
			statusContradictions: 0,
			misplacedNotes: 0,
			adrImplementationDrift: 0,
		};
		assert.equal(sumActionable(counts), 0);
	});
});

// ─── DISPOSITIONABLE_KEYS ────────────────────────────────────────────────────

describe('DISPOSITIONABLE_KEYS', () => {
	test('contains exactly the 6 disposition-wired bucket keys (ADR-009 adds adrImplementationDrift)', () => {
		const expected = new Set([
			'unresolved',
			'orphans',
			'staleInbox',
			'statusContradictions',
			'misplacedNotes',
			'adrImplementationDrift',
		]);
		assert.deepEqual(new Set([...DISPOSITIONABLE_KEYS]), expected);
	});

	test('does not contain governanceViolations (no web disposition path per ADR-006 item 4)', () => {
		// @ts-expect-error -- checking a key NOT in the const type
		assert.equal(DISPOSITIONABLE_KEYS.includes('governanceViolations'), false);
	});

	test('does not contain inboxDecisions (human-judgment surface, not one-click disposition)', () => {
		// @ts-expect-error -- checking a key NOT in the const type
		assert.equal(DISPOSITIONABLE_KEYS.includes('inboxDecisions'), false);
	});

	test('does not contain indexed', () => {
		// @ts-expect-error -- checking a key NOT in the const type
		assert.equal(DISPOSITIONABLE_KEYS.includes('indexed'), false);
	});
});

// ─── Tiles == list invariant (ADR-006 falsifier) ─────────────────────────────

describe('tiles == list invariant (ADR-006 P2)', () => {
	test('tile count for each dispositionable bucket equals array .length (what the list renders)', () => {
		// This is the ADR falsifier: tile shown count MUST equal list item count.
		// Both derive from computeActionableCounts — they cannot disagree.
		const report = makeReport({
			unresolved: Array.from({ length: 5 }, (_, i) => ({ source: `s${i}.md`, raw: `[[r${i}]]` })),
			orphans: Array.from({ length: 3 }, (_, i) => ({ path: `o${i}.md`, title: `O${i}` })),
			staleInbox: Array.from({ length: 7 }, (_, i) => ({
				path: `inbox/s${i}.md`,
				title: `S${i}`,
				ageDays: i + 8,
			})),
			adrImplementationDrift: Array.from({ length: 2 }, (_, i) => ({
				path: `projects/proj/adr-00${i + 1}-slug.md`,
				project: 'proj',
				slug: `adr-00${i + 1}-slug`,
				currentStatus: 'proposed',
				mergeEvidence: `sha${i} Merge branch 'orchestration/run-123/adr-00${i + 1}-slug'`,
			})),
		});
		const counts = computeActionableCounts(report);

		// Tile count == array.length == what the list renders
		assert.equal(counts.unresolved, report.unresolved.length, 'unresolved tile == list');
		assert.equal(counts.orphans, report.orphans.length, 'orphans tile == list');
		assert.equal(counts.staleInbox, report.staleInbox.length, 'staleInbox tile == list');
		assert.equal(counts.statusContradictions, report.statusContradictions.length, 'statusContradictions tile == list');
		assert.equal(counts.misplacedNotes, report.misplacedNotes.length, 'misplacedNotes tile == list');
		assert.equal(counts.adrImplementationDrift, report.adrImplementationDrift.length, 'adrImplementationDrift tile == list');
	});

	test('sumActionable matches the total item count the list renders', () => {
		const report = makeReport();
		const counts = computeActionableCounts(report);

		// The list header shows sumActionable; the list body renders all 6 arrays.
		const manualSum =
			report.unresolved.length +
			report.orphans.length +
			report.staleInbox.length +
			report.statusContradictions.length +
			report.misplacedNotes.length +
			report.adrImplementationDrift.length;

		assert.equal(sumActionable(counts), manualSum, 'list header total == list body item count');
	});

	test('governance and inbox-decisions counts do NOT affect the amber-state sum', () => {
		// Governance and inbox-decisions have counts but no disposition path.
		// They must not contribute to sumActionable.
		const counts = computeActionableCounts(makeReport());
		const amberTotal = sumActionable(counts);

		// Adding phantom governance/inbox keys would change the sum — confirm they are absent.
		const withPhantoms = { ...counts, governanceViolations: 99, inboxDecisions: 50 };
		// sumActionable only reads the 6 known keys; phantoms are ignored.
		assert.equal(sumActionable(withPhantoms), amberTotal);
	});
});
