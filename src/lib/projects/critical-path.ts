/** projects-graph ADR-014 — critical-path computation for the Gantt.
 *
 *  Given a set of ADR rows with `blockedBy: string[]` wikilink strings,
 *  compute:
 *    - The dependency edges (blocker → dependent) the SVG overlay needs.
 *    - The critical path: longest dependency chain (weighted by ADR
 *      date-span) that ends at an unshipped node (proposed or accepted).
 *    - Cycle detection — cycles are data bugs the operator should resolve;
 *      we render the involved edges in red and surface a warning.
 *
 *  Pure function, no `graphology` dep. Kahn's algorithm + DP on the topo
 *  order is ~80 LOC and reads cleanly; `graphology` is reserved for the
 *  `/vault` page's force-atlas layout which actually needs its layout
 *  algorithms. */
interface RowLike {
	path: string;
	status: string;
	created: string | null;
	acceptedOn: string | null;
	shippedOn: string | null;
	targetDate: string | null;
	blockedBy: string[];
}

export interface DepEdge {
	/** Row key (filename without `.md`) of the blocking ADR. When `external`
	 *  is true, this is the raw external slug from the wikilink. */
	blocker: string;
	/** Row key of the dependent ADR — always intra-project. */
	dependent: string;
	/** True when the blocker is NOT in the visible row set — either filtered
	 *  out (rejected/superseded with `showInactive=false`) or in a different
	 *  project. The renderer uses this to draw an off-canvas marker rather
	 *  than a cross-row arrow. */
	external: boolean;
	/** Status of the blocker row, used by the renderer to color the arrow.
	 *  `null` for external edges where the blocker isn't loaded. */
	blockerStatus: string | null;
}

export interface CriticalPathResult {
	edges: DepEdge[];
	/** Row keys whose bars sit on the critical path. Includes the sink and
	 *  every ancestor reachable via the `prev` chain. */
	criticalSlugs: Set<string>;
	/** Edges (encoded `"blocker→dependent"`) that are part of a cycle.
	 *  Renderer uses this to color those arrows red. */
	cycleEdges: Set<string>;
	hasCycle: boolean;
}

const WIKILINK_RE = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/;

/** Extract the last `/`-segment of a wikilink target, stripping a `.md`
 *  suffix. Mirrors the slug-derivation used by the rest of the projects
 *  surface (see `parseParentSlug` in `+server.ts`). */
function parseLinkSlug(raw: string): string | null {
	const m = WIKILINK_RE.exec(raw.trim());
	if (!m) return null;
	const last = m[1].trim().split('/').pop();
	if (!last) return null;
	return last.replace(/\.md$/i, '');
}

function rowKey(path: string): string {
	const last = path.split('/').pop() ?? path;
	return last.replace(/\.md$/i, '');
}

function endIsoMs(d: RowLike): number {
	const iso = d.shippedOn ?? d.acceptedOn ?? d.targetDate ?? new Date().toISOString().slice(0, 10);
	return Date.parse(iso);
}

function startIsoMs(d: RowLike): number {
	return d.created ? Date.parse(d.created) : Date.now();
}

export function computeCriticalPath(rows: RowLike[]): CriticalPathResult {
	const rowsByKey = new Map<string, RowLike>();
	for (const d of rows) rowsByKey.set(rowKey(d.path), d);

	// Operators occasionally shorten `[[adr-014-…]]` to `[[adr-014]]` even
	// though the canonical form is the full slug (per global wikilink rules).
	// Defensive prefix-index so we tolerate both shapes without forcing a
	// vault-wide rewrite.
	const shortIndex = new Map<string, string>();
	for (const key of rowsByKey.keys()) {
		const m = /^(adr-\d+)/i.exec(key);
		if (m) shortIndex.set(m[1].toLowerCase(), key);
	}

	function resolveBlocker(linkSlug: string): string | null {
		if (rowsByKey.has(linkSlug)) return linkSlug;
		const short = /^(adr-\d+)/i.exec(linkSlug)?.[1]?.toLowerCase();
		if (short) {
			const full = shortIndex.get(short);
			if (full) return full;
		}
		return null;
	}

	const edges: DepEdge[] = [];
	for (const d of rows) {
		if (!d.blockedBy || d.blockedBy.length === 0) continue;
		const dependentKey = rowKey(d.path);
		for (const raw of d.blockedBy) {
			const link = parseLinkSlug(raw);
			if (!link) continue;
			const blockerKey = resolveBlocker(link);
			if (blockerKey) {
				const br = rowsByKey.get(blockerKey)!;
				edges.push({
					blocker: blockerKey,
					dependent: dependentKey,
					external: false,
					blockerStatus: br.status,
				});
			} else {
				edges.push({
					blocker: link,
					dependent: dependentKey,
					external: true,
					blockerStatus: null,
				});
			}
		}
	}

	// Kahn's topo sort over intra-project edges. External edges don't
	// participate — they have no in-graph node to count an indegree against.
	const intraEdges = edges.filter((e) => !e.external);
	const inDegree = new Map<string, number>();
	const outAdj = new Map<string, string[]>();
	for (const key of rowsByKey.keys()) {
		inDegree.set(key, 0);
		outAdj.set(key, []);
	}
	for (const e of intraEdges) {
		inDegree.set(e.dependent, (inDegree.get(e.dependent) ?? 0) + 1);
		outAdj.get(e.blocker)!.push(e.dependent);
	}

	const queue: string[] = [];
	for (const [k, deg] of inDegree.entries()) {
		if (deg === 0) queue.push(k);
	}
	const topo: string[] = [];
	while (queue.length > 0) {
		const k = queue.shift()!;
		topo.push(k);
		for (const next of outAdj.get(k) ?? []) {
			const nd = (inDegree.get(next) ?? 0) - 1;
			inDegree.set(next, nd);
			if (nd === 0) queue.push(next);
		}
	}

	const hasCycle = topo.length < rowsByKey.size;
	const cycleEdges = new Set<string>();
	if (hasCycle) {
		// Every node not in the topo order is either ON a cycle or downstream
		// of one. Mark all incident intra-edges as "cycle edges" so the
		// renderer can color them red without us having to find the exact
		// cycle membership (which would need Tarjan's SCC for tight scope).
		const inTopo = new Set(topo);
		for (const e of intraEdges) {
			if (!inTopo.has(e.blocker) || !inTopo.has(e.dependent)) {
				cycleEdges.add(`${e.blocker}→${e.dependent}`);
			}
		}
	}

	// Longest-path-by-date-span DP over the topo order. Weight per node =
	// `endMs - startMs` clamped to ≥1ms so zero-span ADRs (created+shipped
	// same day) still contribute to path length.
	const weight = new Map<string, number>();
	for (const [k, row] of rowsByKey.entries()) {
		weight.set(k, Math.max(1, endIsoMs(row) - startIsoMs(row)));
	}

	const longestEndingAt = new Map<string, number>();
	const prev = new Map<string, string | null>();
	for (const k of topo) {
		let best = weight.get(k)!;
		let pred: string | null = null;
		for (const e of intraEdges) {
			if (e.dependent !== k) continue;
			const fromTotal = longestEndingAt.get(e.blocker);
			if (fromTotal !== undefined) {
				const total = fromTotal + weight.get(k)!;
				if (total > best) {
					best = total;
					pred = e.blocker;
				}
			}
		}
		longestEndingAt.set(k, best);
		prev.set(k, pred);
	}

	// Sink selection: the unshipped (proposed or accepted) node with the
	// highest longest-path weight. If no unshipped node exists, the project
	// is fully shipped and the critical-path set is empty.
	let sink: string | null = null;
	let sinkWeight = -1;
	for (const [k, total] of longestEndingAt.entries()) {
		const row = rowsByKey.get(k);
		if (!row) continue;
		if (row.status !== 'proposed' && row.status !== 'accepted') continue;
		if (total > sinkWeight) {
			sinkWeight = total;
			sink = k;
		}
	}

	const criticalSlugs = new Set<string>();
	if (sink) {
		let cur: string | null = sink;
		while (cur) {
			criticalSlugs.add(cur);
			cur = prev.get(cur) ?? null;
		}
	}

	return { edges, criticalSlugs, cycleEdges, hasCycle };
}
