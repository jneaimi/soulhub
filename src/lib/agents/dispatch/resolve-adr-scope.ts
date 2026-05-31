/**
 * ADR-020 P4 — Mid-run path-scope enforcement.
 *
 * Reads `scope.allowed_paths` + `scope.forbidden_paths` from the ADR at
 * `subjectPath`. The dispatcher snapshots this to `agent_runs.scope_json` at
 * dispatch start; a PreToolUse hook reads it back to refuse out-of-scope
 * Edit/Write/MultiEdit/NotebookEdit calls during the run.
 *
 * Same shape as `resolveAdrBudget` — pure, injectable `getNote` for tests.
 *
 * Backward-compatible: ADRs without a `scope:` block return `null` and the
 * hook treats it as "no enforcement" (unchanged behaviour from pre-P4).
 *
 * Operator updates scope between phases by editing the ADR's `scope:` block.
 * Each dispatch snapshots whatever scope was active at start time, so prior
 * runs' `agent_runs.scope_json` preserves the historical scope (audit trail).
 */

import type { NoteRepoShape } from './resolve-project-repo.js';

export interface AdrScope {
	/** When set + non-empty, ONLY these paths may be written. Absence = no
	 *  allow-list (any path matches as long as it's not in forbidden_paths). */
	allowed_paths: string[];
	/** Paths that may NEVER be written, even when allowed_paths is empty. */
	forbidden_paths: string[];
}

/** Coerce a YAML-parsed value to a path-array, dropping non-strings.
 *  Frontmatter might give us an array, a single string, or undefined. */
function toPathArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
	if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
	return [];
}

/**
 * Resolve the dispatch scope from an ADR's frontmatter.
 *
 * @param subjectPath  Vault-relative path of the ADR (e.g.
 *                     `projects/soul-hub-agents/adr-011-foo.md`).
 * @param getNote      Lookup function: vault path → note shape or undefined.
 *                     Injected so this is unit-testable.
 * @returns            `{ allowed_paths, forbidden_paths }` or `null` when
 *                     the ADR has no `scope:` block, both lists are empty,
 *                     or the note isn't indexed. Null = hook bypass (no
 *                     enforcement), matching pre-P4 behaviour.
 */
export function resolveAdrScope(
	subjectPath: string | undefined,
	getNote: (path: string) => NoteRepoShape | undefined,
): AdrScope | null {
	if (!subjectPath) return null;
	const note = getNote(subjectPath);
	if (!note) return null;
	const raw = note.meta['scope'];
	if (!raw || typeof raw !== 'object') return null;
	const obj = raw as Record<string, unknown>;
	const allowed_paths = toPathArray(obj['allowed_paths']);
	const forbidden_paths = toPathArray(obj['forbidden_paths']);
	// Both lists empty → equivalent to no scope at all.
	if (allowed_paths.length === 0 && forbidden_paths.length === 0) return null;
	return { allowed_paths, forbidden_paths };
}

/**
 * Decide whether a write to `targetPath` is permitted under `scope`. Mirror
 * of the hook's logic in TypeScript so tests can lock down the contract.
 *
 *   - forbidden_paths match → BLOCK (always wins)
 *   - allowed_paths non-empty AND no match → BLOCK
 *   - otherwise → ALLOW
 *
 * `cwd` is the run's working directory (the worktree path for ADR-022
 * dispatches). When provided, absolute targets that start with cwd are
 * relativised before matching, so an operator-authored entry like
 * `.worktrees/**` correctly refers to the `.worktrees/` dir inside the cwd
 * — not the `.worktrees/` segment in the cwd's own absolute path. Without
 * cwd, the matcher falls back to the lenient path-segment containment used
 * pre-#60.
 */
export function isPathInScope(
	scope: AdrScope,
	targetPath: string,
	cwd?: string,
): { allowed: boolean; reason?: string } {
	const target = targetPath.trim();
	for (const forbidden of scope.forbidden_paths) {
		if (matchesPath(target, forbidden, cwd)) {
			return { allowed: false, reason: `forbidden_paths matches "${forbidden}"` };
		}
	}
	if (scope.allowed_paths.length > 0) {
		const hit = scope.allowed_paths.some((p) => matchesPath(target, p, cwd));
		if (!hit) {
			return {
				allowed: false,
				reason: `target not in allowed_paths (${scope.allowed_paths.length} entries)`,
			};
		}
	}
	return { allowed: true };
}

/** Normalise a scope entry the operator typed in YAML.
 *
 *  - `src/lib/vault/**`  →  `src/lib/vault`   (operator's natural "everything
 *                                              under this dir" glob)
 *  - `node_modules/**`   →  `node_modules`
 *  - `src/lib/vault/`    →  `src/lib/vault`   (trim trailing slash)
 *  - `**`                →  ``                (caller treats empty as wildcard)
 *
 *  We don't try to interpret real glob patterns like `star.ts` or
 *  double-star-slash-foo — operators use them as documentation but Claude
 *  Code's tool_input file_path is always a concrete file, so prefix-based
 *  matching is what actually does the work. The trailing-double-star is the
 *  only glob form we strip because it's how the operator-facing docs spell
 *  "this directory and everything in it". */
function normaliseScopeEntry(entry: string): string {
	let e = entry.trim();
	// Drop /** or ** suffix (operator's "everything under" notation).
	if (e.endsWith('/**')) e = e.slice(0, -3);
	else if (e.endsWith('**')) e = e.slice(0, -2);
	// Trim a trailing slash so `src/lib/vault/` and `src/lib/vault` are equal.
	if (e.endsWith('/') && e.length > 1) e = e.slice(0, -1);
	return e;
}

/** Decide whether `target` is under the directory described by `scopeEntry`.
 *
 *  Match semantics:
 *    - empty entry (after `**` strip)            →  wildcard, matches anything
 *    - exact equality (post-relativisation)      →  match
 *    - absolute entry (starts with `/`)          →  target startswith `entry+/`
 *    - relative entry + cwd given                →  relativise target to cwd,
 *                                                   then startswith match
 *                                                   (the precise semantics
 *                                                   operators expect: scope is
 *                                                   relative to the run's cwd)
 *    - relative entry + cwd absent (fallback)    →  startswith `entry+/` OR
 *                                                   contains `/entry/` (lenient,
 *                                                   for back-compat with older
 *                                                   Claude Code that didn't
 *                                                   pass cwd in PreToolUse)
 *
 *  The cwd-relativisation closes #60: the `.worktrees/**` forbidden entry must
 *  refer to a `.worktrees/` dir BELOW the run's cwd, NOT the `.worktrees/`
 *  segment in the cwd itself (which would falsely match every file in any
 *  ADR-022 per-ADR worktree).
 *
 *  Exported for unit tests + symmetry with the bash hook (install/hooks/
 *  dispatch-scope-guard.sh implements the same rules in jq). Keep the two
 *  implementations in lock-step — the test suite cross-validates them. */
export function matchesPath(target: string, scopeEntry: string, cwd?: string): boolean {
	const entry = normaliseScopeEntry(scopeEntry);
	if (entry === '') return true; // `**` alone = match-everything wildcard

	// Absolute entries: pure prefix match against the absolute target. No
	// relativisation — the operator deliberately anchored to a system path.
	if (entry.startsWith('/')) {
		if (target === entry) return true;
		return target.startsWith(entry + '/');
	}

	// Relative entry. When cwd is known AND target is under cwd, relativise
	// the target so semantics match the operator's mental model: "this entry
	// names a path under the run's working directory."
	if (cwd && target.startsWith(cwd + '/')) {
		const relativeTarget = target.slice(cwd.length + 1);
		if (relativeTarget === entry) return true;
		return relativeTarget.startsWith(entry + '/');
	}

	// No cwd, or target is outside cwd. Fall back to the lenient match: either
	// the target is itself a relative path with the right prefix, or any path
	// segment in the target matches. The `/` anchors prevent `src/lib/vault`
	// from spuriously matching `/foo/src/lib/vaultext/bar`.
	if (target === entry) return true;
	return target.startsWith(entry + '/') || target.includes('/' + entry + '/');
}
