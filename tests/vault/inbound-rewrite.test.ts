/** ADR-006 P1.0 — Inbound-wikilink-rewrite primitive unit tests.
 *
 *  `moveNote` now delegates to `relocateNotes` which uses `rewriteBody`
 *  and `rewriteMeta` from relocate.ts to rewrite inbound links. These
 *  tests validate the rewrite logic directly (no vault engine needed).
 *
 *  Happy path: path-form, bare-slug, and alias links are rewritten.
 *  Sad  path:  links NOT in the move map pass through unchanged. */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { rewriteBody, rewriteMeta } from '../../src/lib/vault/relocate.ts';

// ── Happy path — rewriteBody ──────────────────────────────────────────────────

describe('rewriteBody — inbound link rewrite on moveNote (ADR-006 P1.0)', () => {
	test('path-form [[zone/slug]] is rewritten when note moves to a new zone', () => {
		const content = 'See [[knowledge/my-note]] for details.';
		const oldPath = 'knowledge/my-note.md';
		const newPath = 'projects/my-note.md';
		const moveMap = new Map([[oldPath, newPath]]);

		// Resolver: 'knowledge/my-note' → oldPath (the pre-move state)
		const resolveTarget = (raw: string): string | null =>
			raw === 'knowledge/my-note' ? oldPath : null;
		const bareSlugIsUnique = () => false; // force full-path form in output

		const { content: out, count } = rewriteBody(content, resolveTarget, moveMap, bareSlugIsUnique);

		assert.equal(count, 1, 'exactly one link rewritten');
		assert.ok(out.includes('[[projects/my-note]]'), `expected new path in: ${out}`);
		assert.ok(!out.includes('[[knowledge/my-note]]'), 'old path must be gone');
	});

	test('bare-slug [[slug]] is preserved as bare when slug is unique after move', () => {
		const content = 'See [[my-note]] for details.';
		const oldPath = 'knowledge/my-note.md';
		const newPath = 'projects/my-note.md';
		const moveMap = new Map([[oldPath, newPath]]);

		const resolveTarget = (raw: string): string | null =>
			raw === 'my-note' ? oldPath : null;
		const bareSlugIsUnique = (slug: string) => slug === 'my-note'; // still unique after move

		const { content: out, count } = rewriteBody(content, resolveTarget, moveMap, bareSlugIsUnique);

		assert.equal(count, 1, 'link should be considered rewritten (target changed zone)');
		// Bare slug preserved because still unique
		assert.ok(out.includes('[[my-note]]'), `bare slug preserved: ${out}`);
	});

	test('[[slug|display alias]] — alias is preserved through zone move', () => {
		const content = 'Read [[knowledge/my-note|My Note]] for context.';
		const oldPath = 'knowledge/my-note.md';
		const newPath = 'projects/my-note.md';
		const moveMap = new Map([[oldPath, newPath]]);

		const resolveTarget = (raw: string): string | null =>
			raw === 'knowledge/my-note' ? oldPath : null;
		const bareSlugIsUnique = () => false;

		const { content: out, count } = rewriteBody(content, resolveTarget, moveMap, bareSlugIsUnique);

		assert.equal(count, 1);
		assert.ok(out.includes('[[projects/my-note|My Note]]'), `alias preserved: ${out}`);
		assert.ok(!out.includes('knowledge/my-note'), 'old zone gone');
	});

	test('embed ![[path/note]] is rewritten (bang preserved)', () => {
		const content = '![[knowledge/image-note]] is embedded.';
		const oldPath = 'knowledge/image-note.md';
		const newPath = 'projects/image-note.md';
		const moveMap = new Map([[oldPath, newPath]]);

		const resolveTarget = (raw: string): string | null =>
			raw === 'knowledge/image-note' ? oldPath : null;
		const bareSlugIsUnique = () => false;

		const { content: out, count } = rewriteBody(content, resolveTarget, moveMap, bareSlugIsUnique);

		assert.equal(count, 1);
		assert.ok(out.includes('![[projects/image-note]]'), `embed bang preserved: ${out}`);
	});

	test('multiple inbound links in the same content all rewritten', () => {
		const content = 'See [[knowledge/my-note]] and [[knowledge/my-note|alias]] here.';
		const oldPath = 'knowledge/my-note.md';
		const newPath = 'projects/my-note.md';
		const moveMap = new Map([[oldPath, newPath]]);

		const resolveTarget = (raw: string): string | null =>
			(raw === 'knowledge/my-note' || raw === 'knowledge/my-note') ? oldPath : null;
		const bareSlugIsUnique = () => false;

		const { content: out, count } = rewriteBody(content, resolveTarget, moveMap, bareSlugIsUnique);

		assert.equal(count, 2, 'both occurrences rewritten');
		assert.ok(out.includes('[[projects/my-note]]'), 'path form rewritten');
		assert.ok(out.includes('[[projects/my-note|alias]]'), 'alias form rewritten');
	});
});

// ── Sad path — no rewrite when note not in move map ──────────────────────────

describe('rewriteBody — sad path (no inbound links)', () => {
	test('link to a NOTE NOT in the move map passes through unchanged', () => {
		const content = 'See [[other-note]] for details.';
		const moveMap = new Map([['knowledge/my-note.md', 'projects/my-note.md']]);

		// other-note resolves to a DIFFERENT path, not in the map
		const resolveTarget = (raw: string): string | null =>
			raw === 'other-note' ? 'knowledge/other-note.md' : null;
		const bareSlugIsUnique = () => false;

		const { content: out, count } = rewriteBody(content, resolveTarget, moveMap, bareSlugIsUnique);

		assert.equal(count, 0, 'no links rewritten');
		assert.equal(out, content, 'content must be unchanged');
	});

	test('unresolvable link [[dead-link]] passes through unchanged', () => {
		const content = 'See [[dead-link]] — this does not resolve.';
		const moveMap = new Map([['knowledge/my-note.md', 'projects/my-note.md']]);

		const resolveTarget = () => null; // nothing resolves
		const bareSlugIsUnique = () => false;

		const { content: out, count } = rewriteBody(content, resolveTarget, moveMap, bareSlugIsUnique);

		assert.equal(count, 0);
		assert.equal(out, content);
	});

	test('empty content produces zero rewrites', () => {
		const moveMap = new Map([['knowledge/my-note.md', 'projects/my-note.md']]);
		const { content: out, count } = rewriteBody('', () => null, moveMap, () => false);
		assert.equal(count, 0);
		assert.equal(out, '');
	});
});

// ── rewriteMeta — frontmatter relationship fields ─────────────────────────────

describe('rewriteMeta — frontmatter relationship fields on move', () => {
	test('single wikilink in frontmatter field is rewritten', () => {
		const meta = { type: 'decision', relates_to: '[[knowledge/my-note]]' };
		const oldPath = 'knowledge/my-note.md';
		const newPath = 'projects/my-note.md';
		const moveMap = new Map([[oldPath, newPath]]);

		const resolveTarget = (raw: string): string | null =>
			raw === 'knowledge/my-note' ? oldPath : null;
		const bareSlugIsUnique = () => false;

		const { meta: out, count } = rewriteMeta(
			meta,
			['relates_to'],
			resolveTarget,
			moveMap,
			bareSlugIsUnique,
		);

		assert.equal(count, 1, 'one frontmatter value rewritten');
		assert.equal(out.relates_to, '[[projects/my-note]]');
	});

	test('array of wikilinks in frontmatter — only the matching link rewritten', () => {
		const meta = {
			type: 'decision',
			relates_to: ['[[knowledge/my-note]]', '[[knowledge/other-note]]'],
		};
		const oldPath = 'knowledge/my-note.md';
		const newPath = 'projects/my-note.md';
		const moveMap = new Map([[oldPath, newPath]]);

		const resolveTarget = (raw: string): string | null => {
			if (raw === 'knowledge/my-note') return oldPath;
			if (raw === 'knowledge/other-note') return 'knowledge/other-note.md'; // NOT in map
			return null;
		};
		const bareSlugIsUnique = () => false;

		const { meta: out, count } = rewriteMeta(
			meta,
			['relates_to'],
			resolveTarget,
			moveMap,
			bareSlugIsUnique,
		);

		assert.equal(count, 1, 'only the moved note rewritten');
		const arr = out.relates_to as string[];
		assert.ok(Array.isArray(arr));
		assert.ok(arr.includes('[[projects/my-note]]'), 'moved note rewritten');
		assert.ok(arr.includes('[[knowledge/other-note]]'), 'other link unchanged');
	});

	test('non-relationship field not in relFields list passes through unchanged', () => {
		const meta = { type: 'decision', relates_to: '[[knowledge/my-note]]', tags: ['foo'] };
		const moveMap = new Map([['knowledge/my-note.md', 'projects/my-note.md']]);
		const resolveTarget = (raw: string): string | null =>
			raw === 'knowledge/my-note' ? 'knowledge/my-note.md' : null;

		// `tags` not listed in relFields — it must not be touched
		const { meta: out, count } = rewriteMeta(
			meta,
			['relates_to'], // only this field is scanned
			resolveTarget,
			moveMap,
			() => false,
		);

		assert.equal(count, 1);
		assert.deepEqual(out.tags, ['foo'], 'tags field untouched');
	});
});
