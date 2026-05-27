/**
 * ADR-015 — Tighten the repo-less dispatch guard: derive work_type server-side.
 *
 * Tests for `deriveWorkType` — the helper that makes the D2 guard (ADR-014)
 * independent of the caller supplying `work_type` in the request body.
 *
 * Key falsifier scenario: POST /api/agents/<repo-less-agent>/test?mode=production
 * with `{ subject: "<coding ADR path>" }` and NO `work_type` field in the body
 * must still derive `work_type: "coding"` from the note's frontmatter and
 * therefore be refused with 422 by the existing D2 guard.
 *
 * Run with:
 *   node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *     tests/agents/dispatch-d2-server-guard.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveWorkType } from '../../src/lib/agents/dispatch/derive-work-type.ts';
import type { NoteWorkTypeShape } from '../../src/lib/agents/dispatch/derive-work-type.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal NoteWorkTypeShape with the given work_type value. */
function noteWith(work_type: unknown): NoteWorkTypeShape {
	return { meta: { work_type } };
}

/** getNote stub: always returns undefined (note not indexed). */
const notFound = (_path: string): NoteWorkTypeShape | undefined => undefined;

// ---------------------------------------------------------------------------
// ADR-015 falsifier — the core scenario
// ---------------------------------------------------------------------------

describe('ADR-015 falsifier: coding subject with no work_type in body', () => {
	test('subject note has work_type:coding, body work_type absent → "coding" derived', () => {
		// This is the exact bypass ADR-015 closes: the caller omits work_type from
		// the request body, but the subject note's frontmatter says "coding". The
		// server guard should still fire.
		const getNote = (path: string): NoteWorkTypeShape | undefined => {
			if (path === 'projects/soul-hub-agents/adr-015.md') return noteWith('coding');
			return undefined;
		};
		const result = deriveWorkType(
			'projects/soul-hub-agents/adr-015.md',
			'', // body.work_type absent → bodyWorkType = ''
			getNote,
		);
		assert.equal(result, 'coding');
	});

	test('subject note has work_type:coding, body work_type also coding → "coding"', () => {
		// When body agrees with note, result is the same. Belt-and-suspenders path.
		const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith('coding');
		assert.equal(deriveWorkType('projects/x.md', 'coding', getNote), 'coding');
	});
});

// ---------------------------------------------------------------------------
// Note is authoritative over body
// ---------------------------------------------------------------------------

describe('note frontmatter is authoritative', () => {
	test('note has work_type:research, body sends coding → "research" wins', () => {
		// The note is the ground truth; a caller claiming "coding" cannot override it.
		const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith('research');
		assert.equal(deriveWorkType('projects/x.md', 'coding', getNote), 'research');
	});

	test('note has work_type:writing, body sends research → "writing" wins', () => {
		const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith('writing');
		assert.equal(deriveWorkType('projects/x.md', 'research', getNote), 'writing');
	});

	test('note work_type is trimmed and lowercased', () => {
		// Frontmatter values in the wild may have leading/trailing whitespace or
		// mixed case. The helper normalises them.
		const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith('  Coding  ');
		assert.equal(deriveWorkType('projects/x.md', '', getNote), 'coding');
	});
});

// ---------------------------------------------------------------------------
// Fallback to body when note has no work_type
// ---------------------------------------------------------------------------

describe('fallback to body work_type', () => {
	test('note has no work_type field → falls back to body "coding"', () => {
		// note.meta.work_type is missing → bodyWorkType is the fallback.
		const getNote = (_path: string): NoteWorkTypeShape | undefined => ({ meta: {} });
		assert.equal(deriveWorkType('projects/x.md', 'coding', getNote), 'coding');
	});

	test('note has work_type:null → falls back to body "research"', () => {
		const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith(null);
		assert.equal(deriveWorkType('projects/x.md', 'research', getNote), 'research');
	});

	test('note has work_type:42 (wrong type) → falls back to body "writing"', () => {
		const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith(42);
		assert.equal(deriveWorkType('projects/x.md', 'writing', getNote), 'writing');
	});

	test('note has work_type:"" (empty string) → falls back to body "coding"', () => {
		// An empty string in frontmatter is treated as absent.
		const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith('');
		assert.equal(deriveWorkType('projects/x.md', 'coding', getNote), 'coding');
	});

	test('note has work_type:"   " (whitespace-only) → falls back to body "coding"', () => {
		const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith('   ');
		assert.equal(deriveWorkType('projects/x.md', 'coding', getNote), 'coding');
	});
});

// ---------------------------------------------------------------------------
// Note not indexed (getNote returns undefined)
// ---------------------------------------------------------------------------

describe('note not found (vault not indexed / missing path)', () => {
	test('note not found + body has coding → "coding" (fallback to body)', () => {
		// A dispatch whose subject is not in the vault index falls back gracefully.
		// This is safe: if there's no subject artifact, there's nothing to protect.
		assert.equal(deriveWorkType('projects/missing.md', 'coding', notFound), 'coding');
	});

	test('note not found + body has empty → "" (guard will not fire)', () => {
		assert.equal(deriveWorkType('projects/missing.md', '', notFound), '');
	});
});

// ---------------------------------------------------------------------------
// No subject path provided
// ---------------------------------------------------------------------------

describe('no subject path (chat dispatch, not artifact-linked)', () => {
	test('no subject + body has coding → "coding"', () => {
		// Chat-mode dispatch with no artifact: body is the only source.
		assert.equal(deriveWorkType(undefined, 'coding', notFound), 'coding');
	});

	test('no subject + body empty → ""', () => {
		// No subject, no body work_type → empty, guard inactive.
		assert.equal(deriveWorkType(undefined, '', notFound), '');
	});

	test('no subject + body research → "research"', () => {
		assert.equal(deriveWorkType(undefined, 'research', notFound), 'research');
	});
});

// ---------------------------------------------------------------------------
// Non-coding subjects — guard must NOT fire for these
// ---------------------------------------------------------------------------

describe('non-coding work_types are passed through unchanged', () => {
	for (const wt of ['research', 'writing', 'design', 'media', 'manual']) {
		test(`note work_type:"${wt}" → "${wt}" (guard must not fire)`, () => {
			const getNote = (_path: string): NoteWorkTypeShape | undefined => noteWith(wt);
			assert.equal(deriveWorkType('projects/x.md', '', getNote), wt);
		});
	}
});

// ---------------------------------------------------------------------------
// getNote is called with the correct path
// ---------------------------------------------------------------------------

describe('getNote receives the exact subject path', () => {
	test('getNote is called with the un-modified subject path', () => {
		const seen: string[] = [];
		const getNote = (path: string): NoteWorkTypeShape | undefined => {
			seen.push(path);
			return noteWith('research');
		};
		deriveWorkType('projects/soul-hub-agents/adr-015-tighten-repo-less-guard.md', '', getNote);
		assert.deepEqual(seen, ['projects/soul-hub-agents/adr-015-tighten-repo-less-guard.md']);
	});

	test('getNote is NOT called when no subject', () => {
		const seen: string[] = [];
		const getNote = (path: string): NoteWorkTypeShape | undefined => {
			seen.push(path);
			return noteWith('coding');
		};
		deriveWorkType(undefined, 'research', getNote);
		assert.deepEqual(seen, []);
	});
});
