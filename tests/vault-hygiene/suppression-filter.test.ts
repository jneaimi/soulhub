/** ADR-006 P1.0 — Suppression filter unit tests.
 *
 *  Tests `parseSuppressedKeys` (the pure parser) and the key-composition
 *  contract (`vaultHygieneKeyFor`). No filesystem I/O — the `today`
 *  parameter overrides the calendar date for deterministic results.
 *
 *  Happy path: an active suppression hides the item.
 *  Sad  path:  an expired suppression does NOT hide the item. */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseSuppressedKeys, vaultHygieneKeyFor } from '../../src/lib/vault-hygiene/suppression-reader.ts';

const TODAY = '2026-05-26';

// ── Happy path ────────────────────────────────────────────────────────────────

describe('parseSuppressedKeys — happy path', () => {
	test('active suppression hides matching item (bare-path bucket)', () => {
		const json = JSON.stringify([
			{ slug: 'inbox/my-note.md', bucket: 'stale_inbox_item', until: '2099-12-31' },
		]);
		const set = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		assert.ok(set.has('inbox/my-note.md'), 'active suppression key should be in set');
	});

	test('active suppression hides matching orphan (bare-path bucket)', () => {
		const json = JSON.stringify([
			{ slug: 'knowledge/orphan.md', bucket: 'orphan_note', until: '2099-12-31' },
		]);
		const set = parseSuppressedKeys(json, 'orphan_note', TODAY);
		assert.ok(set.has('knowledge/orphan.md'));
	});

	test('active unresolved suppression via composite vaultHygieneKeyFor key', () => {
		const source = 'projects/foo/adr-001.md';
		const raw = 'missing-note';
		const key = vaultHygieneKeyFor(source, raw);
		assert.equal(key, `${source}::${raw}`, 'key shape must be source::raw');
		const json = JSON.stringify([
			{ slug: key, bucket: 'unresolved', until: '2099-12-31' },
		]);
		const set = parseSuppressedKeys(json, 'unresolved', TODAY);
		assert.ok(set.has(key), 'composite key must be present in suppressed set');
	});

	test('legacy `key` field (not `slug`) is read via key ?? slug fallback', () => {
		const json = JSON.stringify([
			{ key: 'knowledge/orphan.md', bucket: 'orphan_note', until: '2099-12-31' },
		]);
		const set = parseSuppressedKeys(json, 'orphan_note', TODAY);
		assert.ok(set.has('knowledge/orphan.md'), 'key field must be honoured');
	});

	test('multiple active suppressions across same bucket all present', () => {
		const json = JSON.stringify([
			{ slug: 'inbox/a.md', bucket: 'stale_inbox_item', until: '2099-12-31' },
			{ slug: 'inbox/b.md', bucket: 'stale_inbox_item', until: '2099-12-31' },
		]);
		const set = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		assert.ok(set.has('inbox/a.md'));
		assert.ok(set.has('inbox/b.md'));
		assert.equal(set.size, 2);
	});
});

// ── Sad path / expiry semantics ───────────────────────────────────────────────

describe('parseSuppressedKeys — expiry semantics (sad path)', () => {
	test('expired suppression (until < today) does NOT hide item', () => {
		const json = JSON.stringify([
			{ slug: 'inbox/old-note.md', bucket: 'stale_inbox_item', until: '2026-01-01' },
		]);
		const set = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		assert.ok(!set.has('inbox/old-note.md'), 'expired suppression must NOT hide item');
	});

	test('suppression expiring exactly today (until == today) is treated as EXPIRED', () => {
		// ADR-006 edge case #1: "until <= today means expired".
		// The escalator uses `entry.until <= today ? continue : add`; we must match.
		const json = JSON.stringify([
			{ slug: 'inbox/edge.md', bucket: 'stale_inbox_item', until: TODAY },
		]);
		const set = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		assert.ok(!set.has('inbox/edge.md'), 'until == today is expired — item must appear in report');
	});

	test('suppression expiring tomorrow is still active', () => {
		const json = JSON.stringify([
			{ slug: 'inbox/near.md', bucket: 'stale_inbox_item', until: '2026-05-27' },
		]);
		const set = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		assert.ok(set.has('inbox/near.md'), 'until tomorrow is still active');
	});
});

// ── Cross-bucket isolation ────────────────────────────────────────────────────

describe('parseSuppressedKeys — cross-bucket isolation', () => {
	test('suppression for a different bucket is not included', () => {
		const json = JSON.stringify([
			{ slug: 'inbox/note.md', bucket: 'orphan_note', until: '2099-12-31' },
		]);
		const set = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		assert.ok(!set.has('inbox/note.md'), 'wrong-bucket entry must not leak');
	});

	test('mixed buckets: only the requested bucket is returned', () => {
		const json = JSON.stringify([
			{ slug: 'inbox/note.md', bucket: 'stale_inbox_item', until: '2099-12-31' },
			{ slug: 'knowledge/orphan.md', bucket: 'orphan_note', until: '2099-12-31' },
		]);
		const staleSet = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		const orphanSet = parseSuppressedKeys(json, 'orphan_note', TODAY);
		assert.ok(staleSet.has('inbox/note.md') && !staleSet.has('knowledge/orphan.md'));
		assert.ok(orphanSet.has('knowledge/orphan.md') && !orphanSet.has('inbox/note.md'));
	});
});

// ── Robustness / corrupt input ────────────────────────────────────────────────

describe('parseSuppressedKeys — robustness', () => {
	test('corrupt JSON returns empty set', () => {
		const set = parseSuppressedKeys('not valid json {{{{', 'orphan_note', TODAY);
		assert.equal(set.size, 0, 'corrupt JSON must return empty set');
	});

	test('empty array returns empty set', () => {
		const set = parseSuppressedKeys('[]', 'orphan_note', TODAY);
		assert.equal(set.size, 0);
	});

	test('non-array JSON (object) returns empty set', () => {
		const set = parseSuppressedKeys('{"slug":"x","bucket":"orphan_note","until":"2099-12-31"}', 'orphan_note', TODAY);
		assert.equal(set.size, 0, 'non-array top-level value must return empty set');
	});

	test('entry missing `until` field is skipped', () => {
		const json = JSON.stringify([
			{ slug: 'inbox/a.md', bucket: 'stale_inbox_item' }, // no until
		]);
		const set = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		assert.equal(set.size, 0, 'entry without until must be skipped');
	});

	test('entry missing both `key` and `slug` is skipped', () => {
		const json = JSON.stringify([
			{ bucket: 'stale_inbox_item', until: '2099-12-31' }, // no key/slug
		]);
		const set = parseSuppressedKeys(json, 'stale_inbox_item', TODAY);
		assert.equal(set.size, 0, 'entry without key/slug must be skipped');
	});
});
