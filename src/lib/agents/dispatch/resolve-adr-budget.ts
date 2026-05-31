/**
 * ADR-020 P3 — Per-ADR cumulative dispatch budget.
 *
 * Reads the `dispatch_budget_usd` frontmatter field from the ADR at
 * `subjectPath`. The dispatcher uses this with `cumulativeAdrSpend()` to
 * refuse a fresh dispatch when prior runs of the same ADR have already burned
 * through the cap (or this run would push them over).
 *
 * Pure: the `getNote` function is injected so this is unit-testable without a
 * live vault engine — same shape as `resolveProjectRepo`.
 *
 * Backward-compatible: ADRs without the field return `undefined` and the
 * dispatcher skips the gate. Per-run budgets (`agent.budget`,
 * `opts.budget_override`) still apply unchanged.
 */

import type { NoteRepoShape } from './resolve-project-repo.js';

/**
 * Resolve the `dispatch_budget_usd` cap from the ADR at `subjectPath`.
 *
 * @param subjectPath  Vault-relative path of the ADR (e.g.
 *                     `projects/soul-hub-agents/adr-011-foo.md`). Paths without
 *                     a corresponding note return `undefined`.
 * @param getNote      Lookup function: given a vault-relative path, return the
 *                     note's minimal shape or `undefined` when not indexed.
 * @returns            The cap in USD (positive number), or `undefined` when
 *                     the ADR has no `dispatch_budget_usd` field, the value is
 *                     non-positive, or the note isn't indexed.
 */
export function resolveAdrBudget(
	subjectPath: string | undefined,
	getNote: (path: string) => NoteRepoShape | undefined,
): number | undefined {
	if (!subjectPath) return undefined;
	const note = getNote(subjectPath);
	if (!note) return undefined;
	const raw = note.meta['dispatch_budget_usd'];
	const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value;
}
