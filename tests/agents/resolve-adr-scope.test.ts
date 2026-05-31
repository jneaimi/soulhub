/** ADR-020 P4 — `resolveAdrScope` + `isPathInScope` unit tests. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdrScope, isPathInScope } from '../../src/lib/agents/dispatch/resolve-adr-scope.ts';
import type { NoteRepoShape } from '../../src/lib/agents/dispatch/resolve-project-repo.ts';

function mkGetNote(notes: Record<string, NoteRepoShape>): (p: string) => NoteRepoShape | undefined {
	return (p) => notes[p];
}

describe('resolveAdrScope', () => {
	test('no subjectPath → null', () => {
		assert.strictEqual(resolveAdrScope(undefined, () => undefined), null);
	});

	test('note not indexed → null', () => {
		assert.strictEqual(
			resolveAdrScope('projects/x/adr-001.md', mkGetNote({})),
			null,
		);
	});

	test('no scope: block → null (hook bypass)', () => {
		const notes = { 'projects/x/adr-001.md': { meta: { type: 'decision' } } };
		assert.strictEqual(resolveAdrScope('projects/x/adr-001.md', mkGetNote(notes)), null);
	});

	test('both lists empty → null (equivalent to no scope)', () => {
		const notes = {
			'projects/x/adr-001.md': { meta: { scope: { allowed_paths: [], forbidden_paths: [] } } },
		};
		assert.strictEqual(resolveAdrScope('projects/x/adr-001.md', mkGetNote(notes)), null);
	});

	test('forbidden_paths only → returned', () => {
		const notes = {
			'projects/x/adr-001.md': { meta: { scope: { forbidden_paths: ['src/x.ts'] } } },
		};
		assert.deepStrictEqual(
			resolveAdrScope('projects/x/adr-001.md', mkGetNote(notes)),
			{ allowed_paths: [], forbidden_paths: ['src/x.ts'] },
		);
	});

	test('allowed_paths only → returned', () => {
		const notes = {
			'projects/x/adr-001.md': { meta: { scope: { allowed_paths: ['src/x.ts', 'src/y.ts'] } } },
		};
		assert.deepStrictEqual(
			resolveAdrScope('projects/x/adr-001.md', mkGetNote(notes)),
			{ allowed_paths: ['src/x.ts', 'src/y.ts'], forbidden_paths: [] },
		);
	});

	test('non-string entries are filtered out', () => {
		const notes = {
			'projects/x/adr-001.md': {
				meta: { scope: { allowed_paths: ['src/x.ts', 42, null, '', '  '] } },
			},
		};
		const scope = resolveAdrScope('projects/x/adr-001.md', mkGetNote(notes));
		assert.deepStrictEqual(scope?.allowed_paths, ['src/x.ts']);
	});

	test('single-string value is normalised to array', () => {
		const notes = {
			'projects/x/adr-001.md': {
				meta: { scope: { forbidden_paths: 'src/secret.ts' } },
			},
		};
		const scope = resolveAdrScope('projects/x/adr-001.md', mkGetNote(notes));
		assert.deepStrictEqual(scope?.forbidden_paths, ['src/secret.ts']);
	});
});

describe('isPathInScope', () => {
	test('forbidden_paths exact match → block', () => {
		const r = isPathInScope(
			{ allowed_paths: [], forbidden_paths: ['src/secret.ts'] },
			'src/secret.ts',
		);
		assert.strictEqual(r.allowed, false);
		assert.match(r.reason ?? '', /forbidden/);
	});

	test('forbidden_paths prefix match (dir) → block', () => {
		const r = isPathInScope(
			{ allowed_paths: [], forbidden_paths: ['src/forbidden/'] },
			'src/forbidden/nested/deep.ts',
		);
		assert.strictEqual(r.allowed, false);
	});

	test('forbidden_paths bare-dir match (no trailing slash) → block', () => {
		const r = isPathInScope(
			{ allowed_paths: [], forbidden_paths: ['src/forbidden'] },
			'src/forbidden/nested.ts',
		);
		assert.strictEqual(r.allowed, false);
	});

	test('allowed_paths empty + no forbidden match → allow', () => {
		const r = isPathInScope(
			{ allowed_paths: [], forbidden_paths: ['src/secret.ts'] },
			'src/anything-else.ts',
		);
		assert.strictEqual(r.allowed, true);
	});

	test('allowed_paths non-empty + match → allow', () => {
		const r = isPathInScope(
			{ allowed_paths: ['src/x.ts', 'src/y.ts'], forbidden_paths: [] },
			'src/x.ts',
		);
		assert.strictEqual(r.allowed, true);
	});

	test('allowed_paths non-empty + no match → block', () => {
		const r = isPathInScope(
			{ allowed_paths: ['src/x.ts'], forbidden_paths: [] },
			'src/other.ts',
		);
		assert.strictEqual(r.allowed, false);
		assert.match(r.reason ?? '', /not in allowed_paths/);
	});

	test('forbidden takes precedence over allowed', () => {
		// File is in BOTH lists — operator should never set this, but the
		// deterministic outcome is BLOCK (defense in depth).
		const r = isPathInScope(
			{ allowed_paths: ['src/x.ts'], forbidden_paths: ['src/x.ts'] },
			'src/x.ts',
		);
		assert.strictEqual(r.allowed, false);
	});

	test('prefix-match handles trailing-slash entries identically to bare-dir', () => {
		const r1 = isPathInScope(
			{ allowed_paths: ['src/lib/'], forbidden_paths: [] },
			'src/lib/foo.ts',
		);
		const r2 = isPathInScope(
			{ allowed_paths: ['src/lib'], forbidden_paths: [] },
			'src/lib/foo.ts',
		);
		assert.strictEqual(r1.allowed, true);
		assert.strictEqual(r2.allowed, true);
	});

	test('prefix-match does NOT accept sibling-prefix files', () => {
		// `src/lib_other.ts` must NOT match `src/lib/` — verifies the dir-boundary.
		const r = isPathInScope(
			{ allowed_paths: ['src/lib/'], forbidden_paths: [] },
			'src/lib_other.ts',
		);
		assert.strictEqual(r.allowed, false);
	});
});
