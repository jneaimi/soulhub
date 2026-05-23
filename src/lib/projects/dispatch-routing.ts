/** projects-graph ADR-018 S2 — work-type → specialist-agent routing.
 *
 *  "Dispatch to AI" needs to pick *which* roster agent runs an artifact. The
 *  artifact's `work_type` (ADR-018 P-B) drives the default; an `assignee` that
 *  is itself a roster agent slug overrides it (the operator already chose).
 *
 *  Returns null when no agent fits (e.g. `work_type: manual` or `decision` —
 *  human-only work, or an unmapped/missing work_type with a human assignee).
 *  A null target means the drawer hides the Dispatch button. */

/** Default work_type → agent-slug map. Values are roster ids (see /api/agents).
 *  Kept deliberately small; extend as the roster/work-types grow. */
const WORK_TYPE_AGENT: Record<string, string> = {
	research: 'researcher',
	writing: 'author',
	design: 'designer',
	media: 'media-generator',
	coding: 'developer',
	// `decision` and `manual` intentionally absent — human-owned work.
};

/**
 * @param workType  the artifact's `work_type` frontmatter (may be null)
 * @param assignee  the artifact's `assignee` frontmatter (may be null)
 * @param agentIds  lowercased set of valid roster agent ids
 * @returns the agent slug to dispatch to, or null when none fits
 */
export function resolveAgentForWork(
	workType: string | null | undefined,
	assignee: string | null | undefined,
	agentIds: Set<string>,
): string | null {
	// An assignee that is itself a roster agent wins — the operator picked it.
	const a = (assignee ?? '').trim().toLowerCase();
	if (a && agentIds.has(a)) return a;

	const wt = (workType ?? '').trim().toLowerCase();
	const mapped = WORK_TYPE_AGENT[wt];
	if (mapped && agentIds.has(mapped)) return mapped;

	return null;
}
