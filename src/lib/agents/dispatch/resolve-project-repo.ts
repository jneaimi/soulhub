/**
 * ADR-030 — Per-project repo binding for worktree provisioning.
 *
 * Resolves the effective repo path from the project that owns a vault artifact.
 * Pure: the `getNote` function is injected so this is unit-testable without a
 * live vault engine.
 *
 * Given a subject path such as `projects/soul-hub/adr-030-foo.md`, this helper
 * extracts the project slug, looks up `projects/<slug>/index.md`, and returns
 * the optional `repo` frontmatter field — the local codebase path the project
 * is bound to (e.g. `~/dev/my-webapp`).
 *
 * Used by `dispatch/index.ts` to derive `effectiveRepo`:
 *   ```
 *   effectiveRepo = resolveProjectRepo(subjectPath, getNote) ?? agent.repo
 *   ```
 * Projects with no `repo` field return `undefined` and the dispatcher falls
 * back to the agent's static `repo` — **identical** behaviour to ADR-010.
 * Nothing changes until a project opts in by adding `repo:` to its index note.
 */

/** Minimal note shape needed for project-repo resolution. */
export interface NoteRepoShape {
	meta: Record<string, unknown>;
}

/**
 * Resolve the `repo` frontmatter from the project that owns a vault artifact.
 *
 * @param subjectPath  Vault-relative path of the artifact (e.g.
 *                     `projects/soul-hub/adr-030-foo.md`). Paths that do not
 *                     match `projects/<slug>/…` return `undefined` immediately.
 * @param getNote      Lookup function: given a vault-relative path, return the
 *                     note's minimal shape or `undefined` when not indexed.
 *                     Injected so the helper is pure and unit-testable without
 *                     a live vault engine.
 * @returns            The project's `repo` string (trimmed), or `undefined`
 *                     when the project index has no non-empty `repo` field, the
 *                     path is not under `projects/<slug>/`, or the note is not
 *                     yet indexed.
 */
export function resolveProjectRepo(
	subjectPath: string | undefined,
	getNote: (path: string) => NoteRepoShape | undefined,
): string | undefined {
	if (!subjectPath) return undefined;
	// Accept paths of the form `projects/<slug>/...`; bare non-project paths
	// (e.g. `knowledge/foo.md`) return undefined immediately.
	const match = subjectPath.match(/^projects\/([^/]+)\//);
	if (!match) return undefined;
	const slug = match[1];
	const indexNote = getNote(`projects/${slug}/index.md`);
	if (!indexNote) return undefined;
	const repo = indexNote.meta['repo'];
	return typeof repo === 'string' && repo.trim() ? repo.trim() : undefined;
}
