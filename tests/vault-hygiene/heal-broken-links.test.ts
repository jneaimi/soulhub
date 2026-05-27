/** Tests for healBrokenLinks — fuzzy-match dead-link auto-rewriter (vault-healer.ts).
 *
 *  healBrokenLinks is a standalone file-operation function — no vault engine
 *  required. allNotes are constructed inline; only the source files need to
 *  exist on disk (for read/write).
 *
 *  Covers:
 *    1. HealResult shape invariant: type='dead_links', fixed/skipped/errors arrays.
 *    2. Happy path: unambiguous high-confidence match → link rewritten in source,
 *       result.fixed.length = 1, result.fixed[0] names the replacement.
 *    3. No-match: similarity below 0.88 threshold → skipped, source unchanged.
 *    4. Ambiguous: two candidates share the same top basename score → skipped,
 *       source unchanged. (Two notes with equal basename similarity = exact tie.)
 *    5. Missing source file: source doesn't exist on disk → errors entry, no crash.
 *
 *  Run:
 *    node --import ./tests/vault-hygiene/register.mjs \
 *         --test --experimental-strip-types \
 *         tests/vault-hygiene/heal-broken-links.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultNote } from '../../src/lib/vault/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal VaultNote stub for the healBrokenLinks candidate index.
 *  healBrokenLinks uses: n.path, n.title (for optional title key).
 *  All other fields are required by the interface but unused by the function. */
function fakeNote(path: string, title: string): VaultNote {
	return {
		path,
		title,
		meta: { type: 'learning', created: '2026-01-01', tags: ['test'] },
		content: '',
		links: [],
		backlinks: [],
		mtime: Date.now(),
		size: 100,
	};
}

// ── Shared vault setup ─────────────────────────────────────────────────────────

let tmpVault = '';

before(async () => {
	tmpVault = await mkdtemp(join(tmpdir(), 'soul-hub-heal-links-'));
	await mkdir(join(tmpVault, 'knowledge'), { recursive: true });

	// Happy-path source: contains [[old-broken-link]]
	await writeFile(
		join(tmpVault, 'knowledge', 'happy-source.md'),
		[
			"---",
			"type: learning",
			"created: '2026-01-01'",
			"tags: [test]",
			"---",
			"",
			"# Happy Source",
			"",
			"This note has a broken link: [[old-broken-link]] right here.",
			"",
		].join('\n'),
	);

	// No-match source: contains [[completely-unrelated-xyzzy]]
	await writeFile(
		join(tmpVault, 'knowledge', 'no-match-source.md'),
		[
			"---",
			"type: learning",
			"created: '2026-01-01'",
			"tags: [test]",
			"---",
			"",
			"# No Match Source",
			"",
			"Broken link with no close candidate: [[completely-unrelated-xyzzy]].",
			"",
		].join('\n'),
	);

	// Ambiguous source: contains [[my-note]] — two candidates share the same basename
	await writeFile(
		join(tmpVault, 'knowledge', 'ambig-source.md'),
		[
			"---",
			"type: learning",
			"created: '2026-01-01'",
			"tags: [test]",
			"---",
			"",
			"# Ambiguous Source",
			"",
			"Ambiguous link — two candidates share the same basename: [[my-note]].",
			"",
		].join('\n'),
	);
	// Note: ghost-source.md is intentionally NOT written (missing-file test).
});

after(async () => {
	await rm(tmpVault, { recursive: true, force: true });
});

// ── HealResult shape invariant ─────────────────────────────────────────────────

describe('HealResult shape invariant', () => {
	test('empty call returns type="dead_links" with empty fixed/skipped/errors arrays', async () => {
		const { healBrokenLinks } = await import('../../src/lib/system/healers/vault-healer.ts');
		const result = await healBrokenLinks(tmpVault, [], []);

		assert.equal(result.type, 'dead_links', `type should be 'dead_links'`);
		assert.ok(Array.isArray(result.fixed), 'fixed must be an array');
		assert.ok(Array.isArray(result.skipped), 'skipped must be an array');
		assert.ok(Array.isArray(result.errors), 'errors must be an array');
		assert.equal(result.fixed.length, 0);
		assert.equal(result.skipped.length, 0);
		assert.equal(result.errors.length, 0);
	});
});

// ── Happy path: unambiguous high-confidence match ─────────────────────────────

describe('healBrokenLinks — happy path: unambiguous match', () => {
	test('rewrites [[old-broken-link]] to [[knowledge/old-broken-link]] in source file', async () => {
		const { healBrokenLinks } = await import('../../src/lib/system/healers/vault-healer.ts');

		// 'old-broken-link' basename normalises to 'old broken link'.
		// The candidate's basename key also normalises to 'old broken link' → score 1.0.
		const allNotes: VaultNote[] = [
			fakeNote('knowledge/happy-source.md', 'Happy Source'),          // self — skipped
			fakeNote('knowledge/old-broken-link.md', 'Old Broken Link'),    // candidate
		];

		const result = await healBrokenLinks(
			tmpVault,
			[{ source: 'knowledge/happy-source.md', raw: 'old-broken-link' }],
			allNotes,
		);

		assert.equal(result.type, 'dead_links');
		assert.equal(result.fixed.length, 1, `fixed.length should be 1; got: ${result.fixed.length}`);
		assert.equal(result.skipped.length, 0, `skipped.length should be 0; got: ${result.skipped.length}`);
		assert.equal(result.errors.length, 0, `errors.length should be 0; got: ${result.errors.length}`);
		assert.ok(
			result.fixed[0].includes('knowledge/old-broken-link'),
			`fixed[0] should name the replacement target; got: ${result.fixed[0]}`,
		);

		// Source file must be rewritten on disk
		const content = await readFile(join(tmpVault, 'knowledge', 'happy-source.md'), 'utf-8');
		assert.ok(
			content.includes('[[knowledge/old-broken-link]]'),
			`source should contain [[knowledge/old-broken-link]] after fix\n${content}`,
		);
		assert.ok(
			!content.includes('[[old-broken-link]]'),
			`original broken link must be gone after fix\n${content}`,
		);
	});
});

// ── No-match: similarity below threshold ──────────────────────────────────────

describe('healBrokenLinks — no-match: similarity below threshold', () => {
	test('skips [[completely-unrelated-xyzzy]] when no candidate reaches 0.88', async () => {
		const { healBrokenLinks } = await import('../../src/lib/system/healers/vault-healer.ts');

		const allNotes: VaultNote[] = [
			fakeNote('knowledge/no-match-source.md', 'No Match Source'),
			fakeNote('knowledge/some-unrelated-note.md', 'Some Unrelated Note'),
		];

		const contentBefore = await readFile(
			join(tmpVault, 'knowledge', 'no-match-source.md'),
			'utf-8',
		);

		const result = await healBrokenLinks(
			tmpVault,
			[{ source: 'knowledge/no-match-source.md', raw: 'completely-unrelated-xyzzy' }],
			allNotes,
		);

		assert.equal(result.fixed.length, 0, `fixed.length should be 0 when no candidate matches`);
		assert.ok(result.skipped.length >= 1, `skipped.length should be ≥1; got: ${result.skipped.length}`);
		assert.equal(result.errors.length, 0);

		// Source file must NOT have been modified
		const contentAfter = await readFile(
			join(tmpVault, 'knowledge', 'no-match-source.md'),
			'utf-8',
		);
		assert.equal(contentAfter, contentBefore, 'source file must be unchanged when no match found');
	});
});

// ── Ambiguous: two equal-score candidates ─────────────────────────────────────

describe('healBrokenLinks — ambiguous: two equal-score candidates → skipped', () => {
	test('skips [[my-note]] when two candidates have the same basename score (exact tie)', async () => {
		const { healBrokenLinks } = await import('../../src/lib/system/healers/vault-healer.ts');

		// Two notes with the same basename 'my-note' in different parent folders.
		// Both have basename key 'my note' → rawSimilarity('my note', 'my note') = 1.0.
		// The second candidate triggers the ambiguous=true branch.
		const allNotes: VaultNote[] = [
			fakeNote('knowledge/ambig-source.md', 'Ambiguous Source'),          // self — skipped
			fakeNote('knowledge/zone1/my-note.md', 'My Note (zone1)'),          // candidate A
			fakeNote('knowledge/zone2/my-note.md', 'My Note (zone2)'),          // candidate B — tie
		];

		const contentBefore = await readFile(
			join(tmpVault, 'knowledge', 'ambig-source.md'),
			'utf-8',
		);

		const result = await healBrokenLinks(
			tmpVault,
			[{ source: 'knowledge/ambig-source.md', raw: 'my-note' }],
			allNotes,
		);

		assert.equal(result.fixed.length, 0, `ambiguous link must NOT be auto-fixed`);
		assert.ok(result.skipped.length >= 1, `ambiguous link should appear in skipped`);
		assert.equal(result.errors.length, 0);

		// Source file must NOT have been modified
		const contentAfter = await readFile(
			join(tmpVault, 'knowledge', 'ambig-source.md'),
			'utf-8',
		);
		assert.equal(contentAfter, contentBefore, 'source file must be unchanged for ambiguous links');
	});
});

// ── Missing source file → errors entry, no crash ─────────────────────────────

describe('healBrokenLinks — missing source file: errors entry, no crash', () => {
	test('produces an errors entry (not a crash) when the source file is absent from disk', async () => {
		const { healBrokenLinks } = await import('../../src/lib/system/healers/vault-healer.ts');

		// 'knowledge/ghost-source.md' was never written — readFile will throw ENOENT.
		// 'target' basename-matches 'knowledge/target.md' at score 1.0, so the rewrite
		// IS queued before the read attempt — triggering the error path.
		const allNotes: VaultNote[] = [
			fakeNote('knowledge/ghost-source.md', 'Ghost Source'),   // self — skipped by self-link guard
			fakeNote('knowledge/target.md', 'Target'),               // candidate (score 1.0)
		];

		const result = await healBrokenLinks(
			tmpVault,
			[{ source: 'knowledge/ghost-source.md', raw: 'target' }],
			allNotes,
		);

		// Must not throw. The rewrite attempt fails with ENOENT → errors entry.
		assert.equal(result.fixed.length, 0, 'fixed should be empty when source file is missing');
		assert.ok(result.errors.length >= 1, `errors.length should be ≥1; got: ${result.errors.length}`);
	});
});
