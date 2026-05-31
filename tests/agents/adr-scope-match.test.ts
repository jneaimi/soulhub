/** Unit tests for `matchesPath` + `isPathInScope` — the ADR-020 P4 dispatch
 *  scope decision logic.
 *
 *  This is the bug fix from #60: the matcher used to do pure exact-or-prefix
 *  on the raw scope entry, which silently failed when the operator wrote
 *  relative paths with `**` globs in the ADR's frontmatter (e.g.
 *  `src/lib/vault/**`) while Claude Code reported absolute targets
 *  (`/Users/.../worktree/src/lib/vault/index.ts`).
 *
 *  The new contract:
 *    - `**` and trailing `/` are normalised away.
 *    - Absolute scope entries → pure prefix match.
 *    - Relative + cwd known → relativise target, strict prefix match
 *      (the precise semantics).
 *    - Relative + cwd unknown → lenient containment fallback (back-compat).
 *
 *  Test classes cross-validate the two consumer surfaces (the SvelteKit code
 *  via `matchesPath` and the bash hook via the parallel jq function). When
 *  this test moves the contract, update install/hooks/dispatch-scope-guard.sh
 *  in the same commit. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	isPathInScope,
	matchesPath,
	type AdrScope,
} from '../../src/lib/agents/dispatch/resolve-adr-scope.ts';

const WT = '/Users/x/dev/soul-hub/.worktrees/adr-042-phased-adr-tier-1-workflow';

describe('matchesPath — glob and trailing-slash normalisation', () => {
	test('`src/lib/vault/**` matches `<cwd>/src/lib/vault/index.ts`', () => {
		assert.equal(
			matchesPath(`${WT}/src/lib/vault/index.ts`, 'src/lib/vault/**', WT),
			true,
		);
	});

	test('`src/lib/vault/` (trailing slash) is equivalent to `src/lib/vault`', () => {
		assert.equal(
			matchesPath(`${WT}/src/lib/vault/index.ts`, 'src/lib/vault/', WT),
			true,
		);
	});

	test('`src/lib/vault` matches `<cwd>/src/lib/vault/index.ts`', () => {
		assert.equal(
			matchesPath(`${WT}/src/lib/vault/index.ts`, 'src/lib/vault', WT),
			true,
		);
	});

	test('bare `**` is a wildcard — matches anything', () => {
		assert.equal(matchesPath('/anywhere/file.ts', '**', WT), true);
	});

	test('exact-file relative entry matches the exact file', () => {
		assert.equal(
			matchesPath(`${WT}/src/foo.ts`, 'src/foo.ts', WT),
			true,
		);
	});
});

describe('matchesPath — cwd-aware relativisation', () => {
	test('`.worktrees/**` does NOT match files INSIDE a `.worktrees/` cwd', () => {
		// This is the precise bug from #60: the worktree itself lives at
		// `.../.worktrees/<slug>/`, so an absolute target carries `.worktrees/`
		// in its path. The forbidden entry `.worktrees/**` means
		// "the `.worktrees/` dir UNDER this cwd", NOT "the segment in the cwd".
		assert.equal(
			matchesPath(`${WT}/src/lib/vault/index.ts`, '.worktrees/**', WT),
			false,
		);
	});

	test('`.worktrees/**` DOES match a literal `.worktrees/` dir under cwd', () => {
		assert.equal(
			matchesPath(`${WT}/.worktrees/nested/foo.ts`, '.worktrees/**', WT),
			true,
		);
	});

	test('`node_modules/**` matches `<cwd>/node_modules/foo.ts`', () => {
		assert.equal(
			matchesPath(`${WT}/node_modules/foo.ts`, 'node_modules/**', WT),
			true,
		);
	});

	test('`cli/src/verbs/**` does NOT match `<cwd>/cli/src/index.ts`', () => {
		// Sibling directory, not under the entry. This was a TRUE positive in
		// the run 525 block log — the agent really tried to edit a non-allowed
		// file and was correctly refused.
		assert.equal(
			matchesPath(`${WT}/cli/src/index.ts`, 'cli/src/verbs/**', WT),
			false,
		);
	});

	test('target outside cwd → does not relativise; falls back to containment', () => {
		const target = '/Users/x/elsewhere/foo.ts';
		// With no path-segment match, no hit.
		assert.equal(matchesPath(target, 'src/lib/vault/**', WT), false);
		// But if the foreign target HAPPENS to contain the segment, lenient match.
		assert.equal(
			matchesPath('/Users/x/elsewhere/src/lib/vault/foo.ts', 'src/lib/vault/**', WT),
			true,
		);
	});
});

describe('matchesPath — fallback (no cwd) keeps back-compat', () => {
	test('relative entry against absolute target via path-segment containment', () => {
		assert.equal(
			matchesPath(`${WT}/src/lib/vault/index.ts`, 'src/lib/vault'),
			true,
		);
	});

	test('relative entry against another relative target', () => {
		assert.equal(matchesPath('src/lib/vault/foo.ts', 'src/lib/vault'), true);
	});

	test('does NOT spuriously match a prefix-extended sibling name', () => {
		// `src/lib/vault` should NOT match `src/lib/vaultext/...` — the `/`
		// anchor is the whole point of the segment match.
		assert.equal(
			matchesPath(`${WT}/src/lib/vaultext/foo.ts`, 'src/lib/vault'),
			false,
		);
	});
});

describe('matchesPath — absolute entries', () => {
	test('absolute entry matches absolute target via pure prefix', () => {
		assert.equal(
			matchesPath(`${WT}/src/lib/vault/index.ts`, `${WT}/src/lib/vault`),
			true,
		);
	});

	test('absolute entry exact match', () => {
		assert.equal(matchesPath('/abs/path', '/abs/path'), true);
	});

	test('absolute entry does NOT match unrelated target', () => {
		assert.equal(matchesPath('/other/path/foo.ts', '/abs/path'), false);
	});
});

describe('isPathInScope — end-to-end scope decisions', () => {
	const scope: AdrScope = {
		allowed_paths: [
			'src/lib/vault/**',
			'src/lib/components/projects/**',
			'src/routes/api/agents/**',
			'cli/src/verbs/**',
			'tests/**',
		],
		forbidden_paths: ['node_modules/**', 'build/**', '.svelte-kit/**', '.worktrees/**'],
	};

	test('the exact bug case from run 525 — AdrDrawer.svelte is now allowed', () => {
		const r = isPathInScope(
			scope,
			`${WT}/src/lib/components/projects/AdrDrawer.svelte`,
			WT,
		);
		assert.equal(r.allowed, true);
	});

	test('the exact bug case — vault/index.ts is now allowed', () => {
		const r = isPathInScope(scope, `${WT}/src/lib/vault/index.ts`, WT);
		assert.equal(r.allowed, true);
	});

	test('the exact bug case — merge-partial endpoint is now allowed', () => {
		const r = isPathInScope(
			scope,
			`${WT}/src/routes/api/agents/merge-partial/+server.ts`,
			WT,
		);
		assert.equal(r.allowed, true);
	});

	test('worktree cwd no longer false-positives on `.worktrees/**` forbidden', () => {
		const r = isPathInScope(scope, `${WT}/src/lib/vault/index.ts`, WT);
		assert.equal(r.allowed, true);
		assert.equal(r.reason, undefined);
	});

	test('forbidden node_modules still blocks (true positive preserved)', () => {
		const r = isPathInScope(scope, `${WT}/node_modules/foo.ts`, WT);
		assert.equal(r.allowed, false);
		assert.match(r.reason!, /forbidden_paths matches/);
	});

	test('out-of-allowed-scope still blocks (true positive preserved)', () => {
		const r = isPathInScope(scope, `${WT}/cli/src/index.ts`, WT);
		assert.equal(r.allowed, false);
		assert.match(r.reason!, /target not in allowed_paths/);
	});

	test('forbidden wins over allowed when both match', () => {
		const scopeBoth: AdrScope = {
			allowed_paths: ['src/**'],
			forbidden_paths: ['src/lib/secrets/**'],
		};
		const r = isPathInScope(scopeBoth, `${WT}/src/lib/secrets/key.ts`, WT);
		assert.equal(r.allowed, false);
		assert.match(r.reason!, /forbidden_paths/);
	});

	test('empty allowed_paths means no allow-list (any path passes the allowed gate)', () => {
		const scopeNoAllow: AdrScope = {
			allowed_paths: [],
			forbidden_paths: ['build/**'],
		};
		const r = isPathInScope(scopeNoAllow, `${WT}/random/foo.ts`, WT);
		assert.equal(r.allowed, true);
	});

	test('cwd-less call hits the worktree false-positive — documented limitation', () => {
		// Without cwd, the matcher can't tell that `.worktrees/...` in the
		// target is the worktree's own path vs an in-cwd `.worktrees/` dir.
		// Modern Claude Code always passes `cwd` in PreToolUse so this only
		// affects fall-back callers. Documented here so the regression is
		// caught if someone "fixes" the fallback to be permissive.
		const r = isPathInScope(scope, `${WT}/src/lib/vault/foo.ts`);
		assert.equal(r.allowed, false);
		assert.match(r.reason!, /forbidden_paths matches/);
	});

	test('cwd-less call on a non-worktree path works via lenient fallback', () => {
		// A "normal" cwd-less call (target not in a `.worktrees/` path) is
		// handled correctly by the lenient containment match.
		const scopeSimple: AdrScope = {
			allowed_paths: ['src/lib/vault/**'],
			forbidden_paths: ['node_modules/**'],
		};
		assert.equal(
			isPathInScope(scopeSimple, '/Users/x/project/src/lib/vault/foo.ts').allowed,
			true,
		);
		assert.equal(
			isPathInScope(scopeSimple, '/Users/x/project/node_modules/foo.ts').allowed,
			false,
		);
	});
});
