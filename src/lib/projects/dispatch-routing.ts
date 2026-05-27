/** projects-graph ADR-018 S2 — work-type → specialist-agent routing.
 *
 *  "Dispatch to AI" needs to pick *which* roster agent runs an artifact. The
 *  artifact's `work_type` (ADR-018 P-B) drives the default; an `assignee` that
 *  is itself a roster agent slug overrides it (the operator already chose).
 *
 *  Returns null when no agent fits (e.g. `work_type: manual` or `decision` —
 *  human-only work, or an unmapped/missing work_type with a human assignee).
 *  A null target means the drawer hides the Dispatch button.
 *
 *  projects-graph ADR-025 D2 — cluster-aware routing layer.
 *  `work_type: coding` in the soul-hub cluster routes to `soul-hub-implementer`
 *  when it is present in the live roster; otherwise falls through to `developer`.
 *  Use `clusterFromTags` to derive the cluster signal from a note's tags array. */

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
 * Parses the `cluster:<slug>` tag convention from a note's tags array.
 *
 * projects-graph ADR-025 D2 — cluster detection reuses the existing
 * `cluster:<slug>` tag set by the soul-hub cluster backfill (ADR-013 /
 * ADR-038 Phase 1). Returns the slug (e.g. `"soul-hub"`) or `null` when
 * no cluster tag is present.  Tag comparison is case-insensitive to be
 * defensive against mixed-case sources.
 */
/** ADR-012 P2/P3 — where an artifact's implementation actually lands. The
 *  default coding dispatch assumes the `~/dev/soul-hub` worktree (ADR-010); an
 *  ADR whose surface is global agent/skill config (`~/.claude/agents`, a
 *  DIFFERENT repo) breaks that assumption — the ADR-003 run edited live global
 *  state with no isolation. A `surface:` frontmatter hint lets the UI recognize
 *  this and route deliberately instead of pretending it's soul-hub code. */
export type SurfaceKind = 'soul-hub' | 'config-repo' | 'external';
export interface SurfaceInfo {
	kind: SurfaceKind;
	/** git repo for a `config-repo` surface (isolatable, eventually). */
	repo?: string;
	/** the raw declared `surface:` value, for display. */
	declared?: string;
}

/** Known out-of-worktree surfaces → the git repo that owns them. */
const SURFACE_REPOS: Record<string, string> = {
	'agent-config': '~/claude-config',
	'skill-config': '~/claude-config',
	'~/.claude/agents': '~/claude-config',
	'~/.claude/skills': '~/claude-config',
	'claude-config': '~/claude-config',
};

/** ADR-012 P3 — classify an artifact's implementation surface from its
 *  `surface:` frontmatter. Default (absent/`soul-hub`) = the in-worktree
 *  soul-hub code path. A mapped global-config value = `config-repo` (carries
 *  the owning repo). Any other declared value = `external` (no known repo —
 *  the implementer must stop and report rather than edit live). Pure. */
export function classifySurface(meta: { surface?: unknown }): SurfaceInfo {
	const declared = typeof meta.surface === 'string' ? meta.surface.trim() : '';
	if (!declared) return { kind: 'soul-hub' };
	const key = declared.toLowerCase();
	if (key === 'soul-hub' || key === '~/dev/soul-hub' || key === 'soul-hub-code') {
		return { kind: 'soul-hub', declared };
	}
	const repo = SURFACE_REPOS[key] ?? SURFACE_REPOS[declared];
	if (repo) return { kind: 'config-repo', repo, declared };
	return { kind: 'external', declared };
}

export function clusterFromTags(tags: string[]): string | null {
	for (const tag of tags) {
		const t = tag.trim().toLowerCase();
		if (t.startsWith('cluster:')) {
			const slug = t.slice('cluster:'.length).trim();
			return slug || null;
		}
	}
	return null;
}

/**
 * @param workType  the artifact's `work_type` frontmatter (may be null)
 * @param assignee  the artifact's `assignee` frontmatter (may be null)
 * @param agentIds  lowercased set of valid roster agent ids
 * @param cluster   the artifact's cluster derived from `clusterFromTags`
 *                  (projects-graph ADR-025 D2); may be null/undefined.
 *                  When `"soul-hub"` and `work_type` is `"coding"`, routes
 *                  to `soul-hub-implementer` instead of `developer` — but
 *                  only when `soul-hub-implementer` is in the live roster.
 * @param repoMap   optional map of agent-id → repo path (ADR-014 D1).
 *                  When provided, any candidate for a `coding` dispatch that
 *                  has no repo binding is **skipped** — no worktree, no dispatch.
 *                  Callers that omit this parameter get the pre-ADR-014 behaviour
 *                  (backward-compatible; all existing tests are unaffected).
 * @returns the agent slug to dispatch to, or null when none fits
 */
export function resolveAgentForWork(
	workType: string | null | undefined,
	assignee: string | null | undefined,
	agentIds: Set<string>,
	cluster?: string | null,
	repoMap?: ReadonlyMap<string, string | undefined>,
): string | null {
	const a = (assignee ?? '').trim().toLowerCase();
	const wt = (workType ?? '').trim().toLowerCase();

	// 1. An assignee that is itself a roster agent wins — the operator picked it.
	//    ADR-014 D1 — for coding work, skip repo-less assignees so an operator
	//    who set `assignee: developer` (pre-ADR-014 muscle memory) doesn't silently
	//    run without isolation.  When skipped, routing falls through to the cluster
	//    and floor steps below so a repo-bound coding agent can still be found.
	if (a && agentIds.has(a)) {
		if (wt !== 'coding' || hasRepo(a, repoMap)) return a;
		// coding + no repo → fall through to find a repo-bound agent
	}

	// 2. projects-graph ADR-025 D2 — soul-hub cluster coding → soul-hub-implementer.
	//    Only when the agent is actually installed in the live roster; absent
	//    roster entry falls through to the default `developer` mapping below.
	//    ADR-014 D1 — honour the repoMap check here too for consistency.
	if (wt === 'coding' && cluster === 'soul-hub' && agentIds.has('soul-hub-implementer')) {
		if (hasRepo('soul-hub-implementer', repoMap)) return 'soul-hub-implementer';
		// soul-hub-implementer has no repo (misconfigured) → fall through to floor
	}

	// 3. Default work_type → agent map (coding → developer for non-soul-hub, etc.).
	//    ADR-014 D1 — for coding, return null instead of a repo-less floor agent.
	const mapped = WORK_TYPE_AGENT[wt];
	if (mapped && agentIds.has(mapped)) {
		if (wt === 'coding' && !hasRepo(mapped, repoMap)) {
			// Floor agent has no repo — refuse rather than run without isolation.
			return null;
		}
		return mapped;
	}

	return null;
}

/**
 * ADR-014 D1 — returns true when the named agent has a non-empty repo binding
 * in the provided map, OR when no map is provided (backward-compat: skip check).
 *
 * Pure; no side-effects.
 */
function hasRepo(
	agentId: string,
	repoMap: ReadonlyMap<string, string | undefined> | undefined,
): boolean {
	if (!repoMap) return true; // no map → don't enforce (backward-compat path)
	const repo = repoMap.get(agentId);
	return typeof repo === 'string' && repo.trim().length > 0;
}
