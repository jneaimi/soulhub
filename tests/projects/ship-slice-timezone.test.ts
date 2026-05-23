/**
 * project-phases ADR-011 S1 — ship-slice timezone regression tests.
 *
 * `ship-slice.ts` has a transitive `.js`-suffixed runtime import
 * (`'../vault/falsifier-parser.js'`) which `node --test
 * --experimental-strip-types` can't resolve. Per the global
 * `feedback_no_raw_node_for_sveltekit_lib_smoke` rule, run this file via
 * `tsx` which maps `.js` → `.ts` automatically:
 *
 *   npx tsx --test tests/projects/ship-slice-timezone.test.ts
 *
 * (NOT plain `node --test`.)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
	ShipSliceRequestSchema,
	buildPreview,
} from '../../src/lib/projects/ship-slice.ts';

const MINIMAL_ADR = `# ADR-X

## Status

**PROPOSED 2026-01-01**

## Implementation plan

| Slice | Scope | Estimate |
|---|---|---|
| S1 | initial slice | 1h |
`;

const MINIMAL_INDEX = `# Project

## Ship log

`;

function baseReq(overrides: Record<string, unknown> = {}) {
	return ShipSliceRequestSchema.parse({
		adr: 'adr-x',
		slice_id: 'S1',
		status: 'shipped',
		commit: 'abcdef0',
		notes: 'test',
		...overrides,
	});
}

describe('buildPreview — ADR-011 timezone-aware date derivation', () => {
	test('Dubai-default is applied when neither req.date nor req.timezone supplied', () => {
		const req = baseReq();
		const preview = buildPreview(
			'projects/p/adr-x.md',
			MINIMAL_ADR,
			'projects/p/index.md',
			MINIMAL_INDEX,
			req,
		);
		// Derived from `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' })`
		// — what `todayInTimezone(new Date())` returns. Determined by clock,
		// not test pinning, but always Dubai-day not UTC-day.
		const dubaiToday = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'Asia/Dubai',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(new Date());
		assert.equal(preview.resolved_date, dubaiToday);
		assert.match(preview.new_status_line, new RegExp(dubaiToday));
		assert.match(preview.new_ship_log_entry, new RegExp(dubaiToday));
	});

	test('req.date operator override wins over the timezone-derived default', () => {
		const req = baseReq({ date: '2026-01-01' });
		const preview = buildPreview(
			'projects/p/adr-x.md',
			MINIMAL_ADR,
			'projects/p/index.md',
			MINIMAL_INDEX,
			req,
		);
		assert.equal(preview.resolved_date, '2026-01-01');
		assert.match(preview.new_status_line, /2026-01-01/);
	});

	test('explicit req.timezone shifts the auto-derived default', () => {
		const utcReq = baseReq({ timezone: 'UTC' });
		const dubaiReq = baseReq({ timezone: 'Asia/Dubai' });

		const utcPreview = buildPreview(
			'projects/p/adr-x.md',
			MINIMAL_ADR,
			'projects/p/index.md',
			MINIMAL_INDEX,
			utcReq,
		);
		const dubaiPreview = buildPreview(
			'projects/p/adr-x.md',
			MINIMAL_ADR,
			'projects/p/index.md',
			MINIMAL_INDEX,
			dubaiReq,
		);

		const utcToday = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(new Date());
		const dubaiToday = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'Asia/Dubai',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(new Date());

		assert.equal(utcPreview.resolved_date, utcToday);
		assert.equal(dubaiPreview.resolved_date, dubaiToday);
	});

	test('req.date wins even when req.timezone is also supplied', () => {
		const req = baseReq({ date: '2025-12-31', timezone: 'UTC' });
		const preview = buildPreview(
			'projects/p/adr-x.md',
			MINIMAL_ADR,
			'projects/p/index.md',
			MINIMAL_INDEX,
			req,
		);
		// Operator override is absolute — timezone is only used to derive
		// the default WHEN req.date is absent.
		assert.equal(preview.resolved_date, '2025-12-31');
	});
});

describe('ShipSliceRequestSchema — ADR-011 timezone field', () => {
	test('optional timezone parses cleanly', () => {
		const parsed = ShipSliceRequestSchema.parse({
			adr: 'adr-x',
			slice_id: 'S1',
			status: 'shipped',
			timezone: 'Asia/Dubai',
		});
		assert.equal(parsed.timezone, 'Asia/Dubai');
	});

	test('missing timezone is undefined (helper applies its own default)', () => {
		const parsed = ShipSliceRequestSchema.parse({
			adr: 'adr-x',
			slice_id: 'S1',
			status: 'shipped',
		});
		assert.equal(parsed.timezone, undefined);
	});

	test('empty timezone string rejected (min 1 char)', () => {
		const result = ShipSliceRequestSchema.safeParse({
			adr: 'adr-x',
			slice_id: 'S1',
			status: 'shipped',
			timezone: '',
		});
		assert.equal(result.success, false);
	});

	test('absurdly long timezone string rejected (max 60 chars)', () => {
		const result = ShipSliceRequestSchema.safeParse({
			adr: 'adr-x',
			slice_id: 'S1',
			status: 'shipped',
			timezone: 'A'.repeat(61),
		});
		assert.equal(result.success, false);
	});
});
