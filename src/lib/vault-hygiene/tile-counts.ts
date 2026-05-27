/** ADR-006 P2 — Tile honesty: the single source of truth for the counts that
 *  tiles AND the "Needs your call" list both consume.
 *
 *  Problem (pre-P2):
 *   - Tile amber-state read `vault.totals[key]`  — the FULL pre-cap count.
 *   - List total summed `vault[array].length`     — the ISSUE_LIST_CAP-sliced count.
 *   - When ≥ 20 items exist, `totals.orphans = 25` but `orphans.length = 20`:
 *     tile showed 25 amber, list showed 20 items — two sources of truth that drift.
 *
 *  Fix (P2):
 *   Both surfaces call `computeActionableCounts(report)` which reads `.length`
 *   on the post-suppression, ISSUE_LIST_CAP-sliced arrays.  Tile count ==
 *   list count because they are the same `.length`.  `vault.totals.*` is never
 *   used for amber-state or list total.
 *
 *  The non-dispositionable buckets (governanceViolations, inboxDecisions,
 *  indexed) are intentionally absent from ActionableCounts — they do not
 *  drive amber-state. */

import type { HygieneTotals } from './types.js';

/** The 6 buckets that have a disposition path in the "Needs your call" list.
 *  These are the only buckets that may render amber on the tile grid.
 *  ADR-009 adds `adrImplementationDrift`. */
export const DISPOSITIONABLE_KEYS = [
	'unresolved',
	'orphans',
	'staleInbox',
	'statusContradictions',
	'misplacedNotes',
	'adrImplementationDrift',
] as const satisfies ReadonlyArray<keyof HygieneTotals>;

export type DispositionableKey = (typeof DISPOSITIONABLE_KEYS)[number];

/** Counts for the 6 disposition-wired buckets.
 *  governanceViolations, inboxDecisions, and indexed are intentionally absent. */
export interface ActionableCounts {
	unresolved: number;
	orphans: number;
	staleInbox: number;
	statusContradictions: number;
	misplacedNotes: number;
	/** ADR-009 — code merged to main but ADR status still proposed/accepted. */
	adrImplementationDrift: number;
}

/** Compute the single actionable-count set that tiles AND the "Needs your call"
 *  list total both consume.  Pass the post-suppression, ISSUE_LIST_CAP-sliced
 *  arrays from the hygiene report — NOT the `totals` object (which can diverge
 *  from array lengths when ISSUE_LIST_CAP caps the returned slice).
 *
 *  The returned counts are what the list renders: tile amber-state derives from
 *  these values so tiles and list are always in sync. */
export function computeActionableCounts(report: {
	unresolved: unknown[];
	orphans: unknown[];
	staleInbox: unknown[];
	statusContradictions: unknown[];
	misplacedNotes: unknown[];
	adrImplementationDrift: unknown[];
}): ActionableCounts {
	return {
		unresolved: report.unresolved.length,
		orphans: report.orphans.length,
		staleInbox: report.staleInbox.length,
		statusContradictions: report.statusContradictions.length,
		misplacedNotes: report.misplacedNotes.length,
		adrImplementationDrift: report.adrImplementationDrift.length,
	};
}

/** Total count of all actionable items — what the "Needs your call" header shows.
 *  Use this instead of hand-summing the 6 array lengths in the component template. */
export function sumActionable(counts: ActionableCounts): number {
	return (
		counts.unresolved +
		counts.orphans +
		counts.staleInbox +
		counts.statusContradictions +
		counts.misplacedNotes +
		counts.adrImplementationDrift
	);
}
