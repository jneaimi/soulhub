/**
 * projects-graph ADR-004 — `parent_project` descendant walker.
 *
 * Pure function: given a flat list of `{slug, parentProject}` pairs (the
 * shape every `/api/vault/projects` consumer already gets), returns the
 * transitive descendant slugs of a target project.
 *
 * Why a separate utility:
 *   - Four surfaces (Gantt, statusCounts, AssumptionAudit, falsifiers)
 *     need the same walk. One implementation, four call sites.
 *   - Cycle detection lives here. ADR-047 chokepoint does NOT enforce
 *     `parent_project` acyclicity today (separate slice). Live data
 *     verified zero cycles 2026-05-18, but the walker still defends
 *     against bad data — log + skip + flag.
 *   - `cluster:` tag is explicitly OUT of scope. Per ADR-038 D3, only
 *     `parent_project` is the canonical tree edge; cluster is a flat
 *     label. Callers that want cluster-grouping use a separate filter.
 */

export interface ProjectEdge {
	slug: string;
	parentProject: string | null;
}

export interface DescendantWalk {
	/** Descendant slugs in deterministic (alphabetical) order. Excludes
	 *  the root itself. Empty when the project has no children. */
	descendants: string[];
	/** True when a cycle was hit during the walk. The cycle edge is
	 *  skipped (the walker doesn't infinite-loop) and `descendants`
	 *  contains the partial result up to the cycle break. */
	cycleDetected: boolean;
	/** Maximum depth seen during the walk (1 = direct children only,
	 *  2 = grandchildren, etc.). 0 when the project is a leaf. */
	maxDepth: number;
}

/**
 * Walk descendants of `rootSlug` through `parent_project` edges.
 *
 * BFS so depth is well-defined. Cycle defense via a `seen` Set —
 * revisits flip `cycleDetected` and skip the edge so the walk
 * terminates with a partial result rather than spinning.
 */
export function getDescendants(rootSlug: string, projects: ProjectEdge[]): DescendantWalk {
	// Build a parent -> children index in one pass for O(N+E) walks.
	const childrenOf = new Map<string, string[]>();
	for (const p of projects) {
		if (!p.parentProject) continue;
		const arr = childrenOf.get(p.parentProject) ?? [];
		arr.push(p.slug);
		childrenOf.set(p.parentProject, arr);
	}

	const out = new Set<string>();
	const seen = new Set<string>([rootSlug]);
	let cycleDetected = false;
	let maxDepth = 0;

	type Frame = { slug: string; depth: number };
	const queue: Frame[] = [{ slug: rootSlug, depth: 0 }];

	while (queue.length > 0) {
		const { slug, depth } = queue.shift() as Frame;
		const kids = childrenOf.get(slug) ?? [];
		for (const child of kids) {
			if (seen.has(child)) {
				// Cycle (or diamond-merge — both treated as cycle for safety
				// since `parent_project` should be a tree edge per ADR-038).
				cycleDetected = true;
				continue;
			}
			seen.add(child);
			out.add(child);
			const nextDepth = depth + 1;
			if (nextDepth > maxDepth) maxDepth = nextDepth;
			queue.push({ slug: child, depth: nextDepth });
		}
	}

	return {
		descendants: Array.from(out).sort(),
		cycleDetected,
		maxDepth,
	};
}

/**
 * Same walk, but returns the full nested tree shape (not just a flat
 * list). Used by the Gantt rollup to render parent → children
 * recursively. Each node carries the source `ProjectEdge` and an
 * (optionally empty) children array.
 *
 * Cycles still don't loop — second-visit branches are dropped.
 */
export interface DescendantNode {
	slug: string;
	depth: number;
	children: DescendantNode[];
}

export function getDescendantTree(rootSlug: string, projects: ProjectEdge[]): {
	tree: DescendantNode | null;
	cycleDetected: boolean;
} {
	const childrenOf = new Map<string, string[]>();
	for (const p of projects) {
		if (!p.parentProject) continue;
		const arr = childrenOf.get(p.parentProject) ?? [];
		arr.push(p.slug);
		childrenOf.set(p.parentProject, arr);
	}

	const seen = new Set<string>();
	let cycleDetected = false;

	const build = (slug: string, depth: number): DescendantNode | null => {
		if (seen.has(slug)) {
			cycleDetected = true;
			return null;
		}
		seen.add(slug);
		const childSlugs = (childrenOf.get(slug) ?? []).slice().sort();
		const children: DescendantNode[] = [];
		for (const c of childSlugs) {
			const node = build(c, depth + 1);
			if (node) children.push(node);
		}
		return { slug, depth, children };
	};

	// Confirm root exists in the project set; if not, tree is null.
	if (!projects.some((p) => p.slug === rootSlug)) {
		return { tree: null, cycleDetected: false };
	}

	return { tree: build(rootSlug, 0), cycleDetected };
}
