/**
 * soul-hub-agents ADR-018 — single source of truth for "known benign auto-gen
 * drift": tracked files that tooling rewrites on every run and therefore show
 * as perpetually modified in the working tree, yet carry no deliverable
 * content.
 *
 * Today that is the GitNexus index-count block in AGENTS.md / CLAUDE.md
 * (`This project is indexed by GitNexus as **soul-hub** (N symbols, …)`),
 * rewritten by every `npx gitnexus analyze`. It left the ship-merge clean-tree
 * guard 409-ing on every Ship & merge (surfaced repeatedly this session) and
 * showed up as noise in the gate-runner's synthesized `files_changed`.
 *
 * Consumed by:
 *  - ship-merge clean-tree guard (projects-graph ADR-027 / ADR-018) — must not
 *    block a merge on this drift (git's own merge-safety still refuses if a
 *    branch actually touches these files, so tolerating them is safe).
 *  - the gate-runner (ADR-016) — must not list it as a deliverable change.
 *
 * Pure, dependency-free: safe to import from a route handler, a dispatch
 * module, and tests alike.
 */

/** Exact repo-relative paths that are known benign auto-generated drift.
 *  Only these are tolerated — anything else is real work and still blocks. */
export const BENIGN_DRIFT_PATHS: ReadonlySet<string> = new Set(['AGENTS.md', 'CLAUDE.md']);

/** True iff `repoRelativePath` is known benign auto-generated drift. */
export function isBenignDriftPath(repoRelativePath: string): boolean {
	return BENIGN_DRIFT_PATHS.has(repoRelativePath.trim());
}

/**
 * Parse `git status --porcelain` output and return the dirty paths that are
 * NOT benign auto-gen drift. An empty array means the tree is clean enough to
 * merge (either truly clean, or dirty only with tolerated drift).
 *
 * Porcelain line format is `XY <path>` (two status chars + space + path); a
 * rename is `R  <old> -> <new>` — we key on the new path.
 */
export function nonBenignDirtyPaths(porcelainStdout: string): string[] {
	return porcelainStdout
		.split('\n')
		.filter(Boolean)
		.map((line) => line.slice(3).split(' -> ').pop()!.trim())
		.filter((p) => p.length > 0 && !isBenignDriftPath(p));
}
