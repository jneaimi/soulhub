/**
 * projects-graph ADR-025 D5 — decision actions UI model.
 *
 * Pure derivation of which buttons to show and what the confirm message says.
 * Extracted so it can be unit-tested without a DOM or Svelte runtime.
 *
 * Consumers: DecisionActions.svelte (list rows in queue + project detail).
 */

import { resolveAgentForWork, clusterFromTags, expectedSpecialistForWorkType } from './dispatch-routing.ts';

export interface DecisionActionModel {
	/** The resolved agent slug, or null when nothing routes. */
	resolvedAgent: string | null;
	/** Whether to show the AI dispatch button.
	 *  True only when `resolvedAgent` is non-null. */
	showAiButton: boolean;
	/** ADR-025 D2 — the expected specialist agent slug when a non-coding
	 *  work_type maps to a specialist that is NOT in the live roster.
	 *  e.g. `work_type: design` but `designer` is absent → `'designer'`.
	 *  Null when: the agent resolved, there is no work_type, the work_type is
	 *  `coding`/`decision`/`manual`, or the specialist happens to be present.
	 *  Used by DecisionActions.svelte to surface "no `<agent>` installed". */
	missingSpecialist: string | null;
	/** ADR-025 D3 — true when the artifact is coding work and the dispatch
	 *  would succeed IF the project had a `repo:` binding, but it does not
	 *  yet. Mutually exclusive with `showAiButton` (if AI can run, no scaffold
	 *  is needed). Used by DecisionActions.svelte to surface a "Bind / scaffold
	 *  a repo" affordance so the operator can unblock the coding dispatch. */
	needsScaffold: boolean;
}

/**
 * Derive the button model for a decision row.
 *
 * @param workType             note's `work_type` frontmatter (null/undefined = absent)
 * @param assignee             note's `assignee` frontmatter (null/undefined = absent)
 * @param tags                 note's `tags` array (drives cluster detection via clusterFromTags)
 * @param roster               Set of live agent ids (lowercased, from /api/agents)
 * @param repoMap              optional map of agent-id → repo path (ADR-014 D1).
 *                             When provided, coding candidates without a repo are skipped
 *                             and the AI-dispatch button is hidden. Omit for backward compat.
 * @param subjectHasProjectRepo ADR-011 D2 — true when the artifact's project has a `repo:`
 *                             binding. Opens the carve-out for `implementer` specifically so
 *                             the AI button appears on project-bound coding work. Default false.
 */
export function decisionActionModel(
	workType: string | null | undefined,
	assignee: string | null | undefined,
	tags: string[],
	roster: Set<string>,
	repoMap?: ReadonlyMap<string, string | undefined>,
	subjectHasProjectRepo?: boolean,
): DecisionActionModel {
	const cluster = clusterFromTags(tags);
	const resolvedAgent = resolveAgentForWork(workType, assignee, roster, cluster, repoMap, subjectHasProjectRepo);

	// ADR-025 D2 — surface "no `<agent>` installed" when a non-coding specialist
	// is expected but absent from the live roster. Only fires when:
	//   1. nothing resolved (resolvedAgent === null)
	//   2. work_type maps to a non-coding specialist (not coding/decision/manual/unknown)
	//   3. that specialist is genuinely missing from the roster
	// Coding work uses the implementer floor — never triggers this hint.
	let missingSpecialist: string | null = null;
	if (!resolvedAgent) {
		const expected = expectedSpecialistForWorkType(workType);
		if (expected !== null && !roster.has(expected)) {
			missingSpecialist = expected;
		}
	}

	// ADR-025 D3 — needsScaffold: coding dispatch is blocked ONLY because the
	// project has no repo binding. Fires when:
	//   1. nothing resolved (resolvedAgent === null)
	//   2. work_type is coding (the floor implementer would run if a repo existed)
	//   3. the project has no repo binding (subjectHasProjectRepo is falsy)
	// Mutually exclusive with showAiButton — if the agent resolved, no scaffold
	// is needed. Non-coding work and missing-specialist cases do not trigger it.
	const wt = (workType ?? '').trim().toLowerCase();
	const needsScaffold =
		!resolvedAgent &&
		wt === 'coding' &&
		!(subjectHasProjectRepo ?? false);

	return {
		resolvedAgent,
		showAiButton: resolvedAgent !== null,
		missingSpecialist,
		needsScaffold,
	};
}

/**
 * Build the pre-dispatch confirm message for the named agent.
 *
 * Matches the D5 spec text exactly so the confirm dialog is unambiguous:
 * "Run `{agent}` · production · isolated git worktree · ~$5–8 · ~10 min · branch handed back for review."
 */
export function buildConfirmMessage(agent: string): string {
	return `Run \`${agent}\` · production · isolated git worktree · ~$5–8 · ~10 min · branch handed back for review.`;
}
