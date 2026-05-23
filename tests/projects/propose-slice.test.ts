/**
 * project-phases ADR-005 S2 — pure-helper tests for proposeSlice.
 *
 * The orchestration entry point (`applyProposeSlice`) talks to the live
 * vault engine — that path is verified end-to-end via live integration
 * smoke after pm2 reload (synthetic project + propose-slice + cleanup).
 * This file covers only the pure functions: parseImplementationTable,
 * nextSliceOrdinalFromTable, detectDominantFamily, formatSliceRow,
 * appendSliceRow.
 *
 * Run via:
 *   node --test --experimental-strip-types tests/projects/propose-slice.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	parseImplementationTable,
	nextSliceOrdinalFromTable,
	detectDominantFamily,
	formatSliceRow,
	appendSliceRow,
	parseSliceLabel,
} from '../../src/lib/projects/propose-slice.ts';

const FIXTURE_3COL = `# ADR-005 — Example

## Status

**PROPOSED 2026-05-17**

## Implementation plan

| Slice | Scope | Estimate |
|---|---|---|
| S1 | First slice scope | 1-2 hours |
| S2 | Second slice scope | 2-3 hours |
| **S3** | Third slice in bold (operator emphasis) | 30 min |

## Related
`;

const FIXTURE_EMPTY_TABLE = `## Status

PROPOSED

## Implementation plan

| Slice | Scope | Estimate |
|---|---|---|

## Related
`;

const FIXTURE_NO_TABLE = `## Status

PROPOSED

## Implementation plan

TBD — operator to add a slice table after acceptance.

## Related
`;

const FIXTURE_NO_SECTION = `## Status

PROPOSED

## Decision

A decision.

## Related
`;

const FIXTURE_PHASE_FAMILY = `## Implementation plan

| Slice | Scope | Estimate |
|---|---|---|
| Phase 1 | Foundation | 1 day |
| Phase 2 | Build | 2 days |
| Phase 3 | Ship | 1 day |
`;

// ─── parseSliceLabel ──────────────────────────────────────────────────

describe('parseSliceLabel', () => {
	test('parses S1, S5, CP4, CP4.2, Phase 1, PASS 2, Stage 3', () => {
		assert.deepEqual(parseSliceLabel('S1')?.family, 'S');
		assert.equal(parseSliceLabel('S1')?.ordinal, 1);
		assert.equal(parseSliceLabel('CP4')?.family, 'CP');
		assert.equal(parseSliceLabel('CP4.2')?.ordinal, 4.2);
		assert.equal(parseSliceLabel('Phase 1')?.family, 'Phase');
		assert.equal(parseSliceLabel('PASS 2')?.family, 'PASS');
		assert.equal(parseSliceLabel('Stage 3')?.family, 'Stage');
	});

	test('returns null for unparseable labels', () => {
		assert.equal(parseSliceLabel(''), null);
		assert.equal(parseSliceLabel('foo'), null);
		assert.equal(parseSliceLabel('S'), null);
		assert.equal(parseSliceLabel('S 1.2.3'), null);
	});
});

// ─── parseImplementationTable ─────────────────────────────────────────

describe('parseImplementationTable', () => {
	test('parses a 3-column table with 3 rows', () => {
		const table = parseImplementationTable(FIXTURE_3COL);
		assert.ok(table, 'table should parse');
		assert.equal(table!.columnCount, 3);
		assert.equal(table!.rows.length, 3);
		assert.equal(table!.rows[0].parsed?.family, 'S');
		assert.equal(table!.rows[0].parsed?.ordinal, 1);
		assert.equal(table!.rows[2].parsed?.family, 'S');
		assert.equal(table!.rows[2].parsed?.ordinal, 3);
	});

	test('strips bold emphasis from cell labels', () => {
		const table = parseImplementationTable(FIXTURE_3COL);
		assert.ok(table);
		// Row 2 has `**S3**` — should still parse as S3 family=S, ordinal=3.
		assert.equal(table!.rows[2].parsed?.family, 'S');
		assert.equal(table!.rows[2].parsed?.ordinal, 3);
	});

	test('returns null when the section is missing', () => {
		assert.equal(parseImplementationTable(FIXTURE_NO_SECTION), null);
	});

	test('returns null when the section exists but has no table', () => {
		assert.equal(parseImplementationTable(FIXTURE_NO_TABLE), null);
	});

	test('handles an empty table (header + separator only)', () => {
		const table = parseImplementationTable(FIXTURE_EMPTY_TABLE);
		assert.ok(table);
		assert.equal(table!.rows.length, 0);
		assert.equal(table!.lastDataLine, table!.separatorLine);
	});

	test('stops at blank line / next heading', () => {
		const body = `## Implementation plan

| Slice | Scope | Estimate |
|---|---|---|
| S1 | a | 1h |

Some prose after the table.

| Slice | Scope | Estimate |
|---|---|---|
| Z9 | bogus | 0 |

## Related
`;
		const table = parseImplementationTable(body);
		assert.ok(table);
		assert.equal(table!.rows.length, 1, 'should only pick up first table');
		assert.equal(table!.rows[0].parsed?.ordinal, 1);
	});
});

// ─── nextSliceOrdinalFromTable / detectDominantFamily ─────────────────

describe('nextSliceOrdinalFromTable', () => {
	test('returns S4 when S1+S2+S3 exist', () => {
		const table = parseImplementationTable(FIXTURE_3COL)!;
		assert.equal(nextSliceOrdinalFromTable(table, 'S'), 'S4');
	});

	test('returns S1 when no S<N> rows exist (e.g. Phase-only table)', () => {
		const table = parseImplementationTable(FIXTURE_PHASE_FAMILY)!;
		assert.equal(nextSliceOrdinalFromTable(table, 'S'), 'S1');
	});

	test('returns Phase 4 for Phase family when Phase 1-3 exist', () => {
		const table = parseImplementationTable(FIXTURE_PHASE_FAMILY)!;
		assert.equal(nextSliceOrdinalFromTable(table, 'Phase'), 'Phase 4');
	});

	test('truncates sub-ordinals — Phase 4 follows Phase 3.5', () => {
		const body = `## Implementation plan

| Slice | Scope | Estimate |
|---|---|---|
| Phase 1 | a | 1h |
| Phase 3.5 | b | 1h |
`;
		const table = parseImplementationTable(body)!;
		assert.equal(nextSliceOrdinalFromTable(table, 'Phase'), 'Phase 4');
	});
});

describe('detectDominantFamily', () => {
	test('returns S when S is most common', () => {
		const table = parseImplementationTable(FIXTURE_3COL)!;
		assert.equal(detectDominantFamily(table), 'S');
	});

	test('returns Phase when Phase dominates', () => {
		const table = parseImplementationTable(FIXTURE_PHASE_FAMILY)!;
		assert.equal(detectDominantFamily(table), 'Phase');
	});

	test('returns S by default when no rows are parseable', () => {
		const body = `## Implementation plan

| Slice | Scope | Estimate |
|---|---|---|
| Hand-curated | weird label | n/a |
`;
		const table = parseImplementationTable(body)!;
		assert.equal(detectDominantFamily(table), 'S');
	});
});

// ─── formatSliceRow ───────────────────────────────────────────────────

describe('formatSliceRow', () => {
	test('renders a 3-column row', () => {
		assert.equal(
			formatSliceRow('S5', 'New scope text', '2-3 hours'),
			'| S5 | New scope text | 2-3 hours |',
		);
	});

	test('pads with em-dashes when columnCount > 3', () => {
		assert.equal(
			formatSliceRow('S5', 'scope', '1h', 5),
			'| S5 | scope | 1h | — | — |',
		);
	});

	test('keeps inline backticks and asterisks intact in the scope cell', () => {
		assert.equal(
			formatSliceRow('S5', 'See `foo.ts` and *bar.ts*', '1h'),
			'| S5 | See `foo.ts` and *bar.ts* | 1h |',
		);
	});
});

// ─── appendSliceRow ───────────────────────────────────────────────────

describe('appendSliceRow', () => {
	test('appends a row with auto-derived slice_id when none provided', () => {
		const result = appendSliceRow(FIXTURE_3COL, {
			scope: 'New auto-derived slice',
			estimate: '1-2 hours',
		});
		assert.ok(result.changed);
		assert.equal(result.resolved_slice_id, 'S4');
		assert.match(result.body, /\| S4 \| New auto-derived slice \| 1-2 hours \|/);
		// New row inserted in-section, not at end of body.
		assert.match(result.body, /\| S4 \| New auto-derived slice \| 1-2 hours \|\n\n## Related/);
	});

	test('honours an explicit slice_id', () => {
		const result = appendSliceRow(FIXTURE_3COL, {
			slice_id: 'S7',
			scope: 'Custom-numbered slice',
			estimate: '30 min',
		});
		assert.ok(result.changed);
		assert.equal(result.resolved_slice_id, 'S7');
		assert.match(result.body, /\| S7 \| Custom-numbered slice \| 30 min \|/);
	});

	test('honours a family override (Phase family with S table)', () => {
		const result = appendSliceRow(FIXTURE_3COL, {
			family: 'Phase',
			scope: 'A Phase-style slice on an S-family table',
			estimate: '1 day',
		});
		assert.ok(result.changed);
		assert.equal(result.resolved_slice_id, 'Phase 1');
	});

	test('is idempotent: existing slice_id returns changed=false', () => {
		const result = appendSliceRow(FIXTURE_3COL, {
			slice_id: 'S2',
			scope: 'Would conflict',
			estimate: '1h',
		});
		assert.equal(result.changed, false);
		assert.equal(result.resolved_slice_id, 'S2');
		assert.equal(result.body, FIXTURE_3COL);
	});

	test('idempotency strips bold emphasis on existing labels', () => {
		const result = appendSliceRow(FIXTURE_3COL, {
			slice_id: 'S3',
			scope: 'Would conflict with bold S3',
			estimate: '1h',
		});
		assert.equal(result.changed, false, 'bold **S3** should be detected as existing S3');
	});

	test('refuses when no `## Implementation plan` section exists', () => {
		const result = appendSliceRow(FIXTURE_NO_SECTION, {
			scope: 'scope',
			estimate: '1h',
		});
		assert.equal(result.changed, false);
		assert.ok(result.error);
		assert.match(result.error!, /Implementation plan/);
		assert.equal(result.status_hint, 422);
	});

	test('refuses when the section has no parseable table', () => {
		const result = appendSliceRow(FIXTURE_NO_TABLE, {
			scope: 'scope',
			estimate: '1h',
		});
		assert.equal(result.changed, false);
		assert.ok(result.error);
		assert.match(result.error!, /Implementation plan/);
		assert.match(result.error!, /table/);
	});

	test('handles an empty table — appends as first row', () => {
		const result = appendSliceRow(FIXTURE_EMPTY_TABLE, {
			scope: 'First slice on an empty table',
			estimate: '1h',
		});
		assert.ok(result.changed);
		assert.equal(result.resolved_slice_id, 'S1');
		assert.match(result.body, /\| S1 \| First slice on an empty table \| 1h \|/);
	});

	test('inserts after the last data row, preserving the section that follows', () => {
		const result = appendSliceRow(FIXTURE_3COL, {
			scope: 'Last row',
			estimate: '1h',
		});
		assert.ok(result.changed);
		// `## Related` section must still be intact after the new row.
		assert.ok(result.body.includes('## Related'));
		// The new row precedes `## Related`, not after.
		const newRowIdx = result.body.indexOf('| S4 |');
		const relatedIdx = result.body.indexOf('## Related');
		assert.ok(newRowIdx < relatedIdx);
	});
});
