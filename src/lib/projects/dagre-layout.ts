/** projects-graph ADR-016 — dagre Sugiyama layout for the per-project
 *  ADR network view.
 *
 *  Pure wrapper around `@dagrejs/dagre` that:
 *    - builds a directed graph from the project's `blocked_by` edges
 *      (reuses ADR-014's already-computed `DepEdge[]`),
 *    - runs `dagre.layout()` (rank assignment + crossing minimization +
 *      node positioning),
 *    - re-projects the result into `LaidOutNode[] + LaidOutEdge[]`
 *      shapes the `AdrNetwork.svelte` renderer consumes directly.
 *
 *  No DOM access, no Svelte runtime — testable with tsx + jq.
 *
 *  The vault is the layout source: every edge comes from `blocked_by`
 *  frontmatter on individual ADR notes (parsed by ADR-014's
 *  `computeCriticalPath()`). This file imposes no schema on top of the
 *  vault. */

import dagre from '@dagrejs/dagre';
import type { DepEdge } from './critical-path.js';

interface RowLike {
	path: string;
}

export interface LaidOutNode {
	/** Filename-without-extension — matches the key shape used everywhere
	 *  else in projects-graph (critical-path utility, edge derivation). */
	slug: string;
	/** Pixel center, in dagre's output coordinate space. The SVG canvas
	 *  is sized to `bounds.width × bounds.height` and these coords are
	 *  used verbatim — no further scaling needed. */
	x: number;
	y: number;
	/** Topological column index (0 = source, max = sink). Exposed for
	 *  AI consumption via the `/api/vault/projects?layout=network`
	 *  endpoint: an LLM reading the response sees the rank layer
	 *  directly without inferring it from coordinates. */
	rank: number;
}

export interface LaidOutEdge {
	/** Source edge from ADR-014's `DepEdge[]`. Carries blocker status
	 *  for color decisions + external flag (always false for laid-out
	 *  edges — externals are filtered upstream). */
	edge: DepEdge;
	/** dagre's polyline from blocker center → dependent center, in the
	 *  same px coordinate space as `LaidOutNode.x/y`. */
	points: { x: number; y: number }[];
}

export interface LayoutResult {
	nodes: LaidOutNode[];
	edges: LaidOutEdge[];
	bounds: { width: number; height: number };
	/** Total number of topological ranks. The legend in the renderer
	 *  may show "5 ranks · 15 nodes". */
	ranks: number;
}

export interface LayoutOptions {
	nodeWidth?: number;
	nodeHeight?: number;
	/** Rank flow direction. `'LR'` (left-to-right, default) suits long
	 *  ADR dependency chains; `'TB'` (top-to-bottom) suits wide project
	 *  hierarchies (one root with many children). projects-graph ADR-005
	 *  uses TB for the `/projects?view=graph` consumer. */
	rankdir?: 'LR' | 'TB';
	/** Gap between ranks (along the rankdir axis). */
	rankSep?: number;
	/** Gap between sibling nodes within a rank (perpendicular to rankdir). */
	nodeSep?: number;
	/** Canvas inner margin. */
	margin?: number;
}

function rowKey(path: string): string {
	const last = path.split('/').pop() ?? path;
	return last.replace(/\.md$/i, '');
}

/** Compute a Sugiyama (layered DAG) layout for the project's ADRs.
 *  External + non-laid-out edges are filtered: only edges whose blocker
 *  AND dependent both appear in `rows` participate in the graph. The
 *  intra-graph filter mirrors the renderer's `renderEdges` derivation
 *  in ADR-014 — same semantics, same edge set. */
export function computeNetworkLayout(
	rows: RowLike[],
	edges: DepEdge[],
	opts: LayoutOptions = {},
): LayoutResult {
	const nodeWidth = opts.nodeWidth ?? 130;
	const nodeHeight = opts.nodeHeight ?? 32;
	const rankSep = opts.rankSep ?? 90;
	const nodeSep = opts.nodeSep ?? 24;
	const margin = opts.margin ?? 20;
	const rankdir = opts.rankdir ?? 'LR';

	const g = new dagre.graphlib.Graph();
	g.setGraph({
		rankdir,
		nodesep: nodeSep,
		ranksep: rankSep,
		marginx: margin,
		marginy: margin,
	});
	g.setDefaultEdgeLabel(() => ({}));

	const rowSlugs = new Set<string>();
	for (const r of rows) {
		const slug = rowKey(r.path);
		rowSlugs.add(slug);
		g.setNode(slug, { width: nodeWidth, height: nodeHeight });
	}

	const intraEdges = edges.filter(
		(e) => !e.external && rowSlugs.has(e.blocker) && rowSlugs.has(e.dependent),
	);
	for (const e of intraEdges) {
		g.setEdge(e.blocker, e.dependent);
	}

	dagre.layout(g);

	// dagre.graphlib's node + edge data is typed loosely — narrow at the
	// boundary so downstream consumers get strict shapes.
	const laidOutNodes: LaidOutNode[] = [];
	for (const slug of g.nodes()) {
		const n = g.node(slug) as { x: number; y: number; rank?: number } | undefined;
		if (!n) continue;
		laidOutNodes.push({
			slug,
			x: n.x,
			y: n.y,
			rank: typeof n.rank === 'number' ? n.rank : 0,
		});
	}

	const laidOutEdges: LaidOutEdge[] = [];
	for (const [i, depEdge] of intraEdges.entries()) {
		const e = g.edge(depEdge.blocker, depEdge.dependent) as
			| { points?: { x: number; y: number }[] }
			| undefined;
		laidOutEdges.push({
			edge: depEdge,
			points: e?.points ?? [],
		});
		// Silence unused-var warning for `i` in some strict configs.
		void i;
	}

	const graph = g.graph() as { width?: number; height?: number };
	const ranks = laidOutNodes.length > 0 ? Math.max(...laidOutNodes.map((n) => n.rank)) + 1 : 0;

	return {
		nodes: laidOutNodes,
		edges: laidOutEdges,
		bounds: {
			width: graph.width ?? 0,
			height: graph.height ?? 0,
		},
		ranks,
	};
}
