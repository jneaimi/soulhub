/**
 * projects-graph ADR-025 D5 — decision actions UI model.
 *
 * Pure derivation of which buttons to show and what the confirm message says.
 * Extracted so it can be unit-tested without a DOM or Svelte runtime.
 *
 * Consumers: DecisionActions.svelte (list rows in queue + project detail).
 */

import { resolveAgentForWork, clusterFromTags } from './dispatch-routing.ts';

export interface DecisionActionModel {
	/** The resolved agent slug, or null when nothing routes. */
	resolvedAgent: string | null;
	/** Whether to show the AI dispatch button.
	 *  True only when `resolvedAgent` is non-null. */
	showAiButton: boolean;
}

/**
 * Derive the button model for a decision row.
 *
 * @param workType  note's `work_type` frontmatter (null/undefined = absent)
 * @param assignee  note's `assignee` frontmatter (null/undefined = absent)
 * @param tags      note's `tags` array (drives cluster detection via clusterFromTags)
 * @param roster    Set of live agent ids (lowercased, from /api/agents)
 * @param repoMap   optional map of agent-id → repo path (ADR-014 D1).
 *                  When provided, coding candidates without a repo are skipped
 *                  and the AI-dispatch button is hidden. Omit for backward compat.
 */
export function decisionActionModel(
	workType: string | null | undefined,
	assignee: string | null | undefined,
	tags: string[],
	roster: Set<string>,
	repoMap?: ReadonlyMap<string, string | undefined>,
): DecisionActionModel {
	const cluster = clusterFromTags(tags);
	const resolvedAgent = resolveAgentForWork(workType, assignee, roster, cluster, repoMap);
	return {
		resolvedAgent,
		showAiButton: resolvedAgent !== null,
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
