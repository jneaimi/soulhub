/**
 * ADR-015 — Tighten the repo-less dispatch guard: derive work_type server-side.
 *
 * Derives the effective work_type for a dispatch by reading the subject note's
 * frontmatter from the vault (the authoritative source) rather than trusting the
 * caller-supplied body field. The body value is used only as a fallback when:
 *   (a) no subject path was provided, or
 *   (b) the note is not indexed, or
 *   (c) the note has no `work_type` field.
 *
 * Accepting `getNote` as a parameter keeps this function pure and trivially
 * testable without initialising a real vault engine.
 */

/** Minimal note shape needed for work_type derivation. */
export interface NoteWorkTypeShape {
	meta: Record<string, unknown>;
}

/**
 * Derives the effective work_type for a dispatch request.
 *
 * The vault note's `meta.work_type` is authoritative when present; the
 * caller-supplied `bodyWorkType` is the fallback only when the note has none
 * or no subject was given. This prevents a caller from bypassing the D2
 * repo-less guard (ADR-014) by simply omitting `work_type` from the request
 * body.
 *
 * @param subject       Vault-relative path of the artifact (may be undefined).
 * @param bodyWorkType  Caller-supplied work_type (should be lowercased + trimmed
 *                      by the caller before passing in; may be empty string).
 * @param getNote       Function to look up a note by vault-relative path.
 *                      Returns undefined if the note is not indexed (e.g. vault
 *                      engine not yet initialised, or path does not exist).
 * @returns             The effective work_type string (empty string when absent).
 */
export function deriveWorkType(
	subject: string | undefined,
	bodyWorkType: string,
	getNote: (path: string) => NoteWorkTypeShape | undefined,
): string {
	if (subject) {
		const note = getNote(subject);
		const noteWorkType =
			typeof note?.meta?.work_type === 'string'
				? note.meta.work_type.trim().toLowerCase()
				: '';
		if (noteWorkType) return noteWorkType;
	}
	return bodyWorkType;
}
