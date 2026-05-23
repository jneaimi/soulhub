/** GET /api/vault/projects/graph — project-level knowledge graph.
 *
 *  Per projects-graph ADR-005. Distinct from the note-level
 *  `/api/vault/graph` (every node is a note; edges are wikilinks). Here
 *  every node is a PROJECT (one `projects/<slug>/index.md`) and edges
 *  follow `parent_project` (ADR-006 will extend with `produces_for`).
 *
 *  Shape returned: `ProjectGraphData` from `src/lib/vault/types.ts`.
 *  Consumed by `/projects?view=graph` (opt-in toggle) and by the AI
 *  surface `soul project graph`. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getVaultEngine } from '$lib/vault/index.js';
import type {
	GraphEdge,
	GraphNode,
	ProjectGraphData,
	ProjectShape,
} from '$lib/vault/types.js';
import { PROJECT_SHAPES, SHAPE_COLORS } from '$lib/vault/types.js';

const PROJECT_ZONE = 'projects';
const ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const UNGROUPED_CLUSTER = 'ungrouped';

/** Extract the target slug from a `parent_project` wikilink. Kept in sync
 *  with `parseParentSlug` in `src/routes/api/vault/projects/+server.ts:194`
 *  and `parseWikilinkSlug` in `src/lib/vault/project-similarity.ts:260`.
 *  Three live copies today; consolidation deferred to its own ADR. */
function parseParentSlug(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const m = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(raw.trim());
	if (!m) return null;
	const target = m[1].trim();
	const segs = target.split('/').filter(Boolean);
	while (segs.length > 1 && /^index(\.md)?$/i.test(segs[segs.length - 1])) {
		segs.pop();
	}
	const lastSeg = segs[segs.length - 1] ?? target;
	return lastSeg.replace(/\.md$/i, '') || null;
}

function bucketIsOpen(status: unknown): boolean {
	const s = String(status ?? '').toLowerCase();
	return s === 'proposed' || s === 'accepted';
}

function bucketIsShipped(status: unknown): boolean {
	return String(status ?? '').toLowerCase() === 'shipped';
}

function asProjectShape(raw: unknown): ProjectShape | undefined {
	if (typeof raw !== 'string') return undefined;
	const s = raw.toLowerCase().trim();
	return (PROJECT_SHAPES as readonly string[]).includes(s)
		? (s as ProjectShape)
		: undefined;
}

function parseClusterTag(tags: unknown): string | undefined {
	if (!Array.isArray(tags)) return undefined;
	for (const t of tags) {
		if (typeof t === 'string' && t.startsWith('cluster:')) {
			const name = t.slice('cluster:'.length).trim();
			if (name) return name;
		}
	}
	return undefined;
}

function parseFalsifierDate(raw: unknown): number | null {
	if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.getTime();
	if (typeof raw === 'string') {
		const t = Date.parse(raw.trim());
		return Number.isNaN(t) ? null : t;
	}
	return null;
}

export const GET: RequestHandler = async () => {
	const engine = getVaultEngine();
	if (!engine) {
		return json({ error: 'Vault not initialized' }, { status: 503 });
	}

	const projectsDir = resolve(engine.vaultDir, PROJECT_ZONE);
	let entries: string[];
	try {
		entries = await readdir(projectsDir);
	} catch (err) {
		return json(
			{ error: `Cannot read projects dir: ${err instanceof Error ? err.message : String(err)}` },
			{ status: 500 },
		);
	}

	const now = Date.now();
	const activityCutoff = now - ACTIVITY_WINDOW_MS;
	const nodes: GraphNode[] = [];
	// slug → node so we can resolve parent edges with O(1) lookup.
	const bySlug = new Map<string, GraphNode>();
	// Edges queued during node construction; resolved against bySlug after
	// the first pass so we never emit an edge to a slug that doesn't have
	// a node (e.g. parent declared in frontmatter but the folder doesn't
	// exist in the vault yet).
	const pendingParentEdges: Array<{ from: string; to: string }> = [];
	// projects-graph ADR-006 — second pending-edge queue for
	// producer→consumer flows. Resolved against `bySlug` after the
	// node pass so we never emit a green arrow pointing at a slug that
	// has no node.
	const pendingProducerEdges: Array<{ from: string; to: string }> = [];

	for (const slug of entries) {
		if (slug.startsWith('.') || slug.startsWith('_')) continue;

		const abs = resolve(projectsDir, slug);
		try {
			const s = await stat(abs);
			if (!s.isDirectory()) continue;
		} catch {
			continue;
		}

		const indexPath = `projects/${slug}/index.md`;
		const indexNote = engine.getNote(indexPath);

		// Project notes (excluding archive/, mirroring the rollup endpoint).
		const projectNotes = engine
			.getNotes({ project: slug, limit: 500 })
			.filter((n) => !n.path.startsWith('archive/'));

		// activity_30d — count of project notes with mtime in the trailing
		// 30-day window. We read mtime from the full VaultNote (search
		// results don't surface it). Cheap because indexer holds notes in
		// memory; measured <10 ms vault-wide per ADR-005 §A5.
		let activity30d = 0;
		let openCount = 0;
		let shippedCount = 0;
		let totalDecisions = 0;
		let hasOverdueFalsifier = false;

		for (const search of projectNotes) {
			const full = engine.getNote(search.path);
			if (!full) continue;
			if (full.mtime > activityCutoff) activity30d += 1;

			// Aggregate ADR-level status (decisions only). The graph view
			// surfaces "is this project moving" — only decisions carry
			// canonical-status today, so artifacts (task/risk/etc.) are
			// excluded from this rollup to keep the badge legible.
			if (full.meta.type === 'decision') {
				totalDecisions += 1;
				if (bucketIsOpen(full.meta.status)) openCount += 1;
				else if (bucketIsShipped(full.meta.status)) shippedCount += 1;

				const fd = parseFalsifierDate(full.meta.falsifier_date);
				if (fd !== null && fd < now) hasOverdueFalsifier = true;
			}
		}

		// Root-index-only fields (project-level metadata). Nested
		// `index.md` files in design/, content-bank/, docs/ are intentionally
		// ignored — they don't carry the project's parent_project / shape /
		// cluster identity.
		let parent: string | null = null;
		let shape: ProjectShape | undefined;
		let cluster: string | undefined;
		let createdIso: string | undefined;
		let tagList: string[] | undefined;

		if (indexNote) {
			parent = parseParentSlug(indexNote.meta.parent_project);
			shape = asProjectShape(indexNote.meta.project_shape);
			cluster = parseClusterTag(indexNote.meta.tags);
			if (typeof indexNote.meta.created === 'string') {
				createdIso = indexNote.meta.created;
			}
			if (Array.isArray(indexNote.meta.tags)) {
				tagList = indexNote.meta.tags.filter((t): t is string => typeof t === 'string');
			}

			// Project-level falsifier (ADR-001) — also feeds the overdue
			// badge.
			const projFalsifier = parseFalsifierDate(indexNote.meta.falsifier_date);
			if (projFalsifier !== null && projFalsifier < now) hasOverdueFalsifier = true;

			// projects-graph ADR-006 — outgoing producer→consumer edges.
			// Honor both bare-string and rich-form entries; rich-form
			// metadata (destination, falsifier) is surfaced via the
			// rollup endpoint, not duplicated on the graph edge.
			const rawProducesFor = indexNote.meta.produces_for;
			if (Array.isArray(rawProducesFor)) {
				for (const entry of rawProducesFor) {
					let target: string | undefined;
					if (typeof entry === 'string') {
						target = entry;
					} else if (entry && typeof entry === 'object' && 'target' in entry) {
						const t = (entry as { target?: unknown }).target;
						if (typeof t === 'string') target = t;
					}
					if (!target) continue;
					const consumerSlug = parseParentSlug(target);
					if (!consumerSlug || consumerSlug === slug) continue;
					pendingProducerEdges.push({ from: slug, to: consumerSlug });
				}
			}
		}

		const color = shape ? SHAPE_COLORS[shape] : '#9ca3af'; // gray-400 fallback

		const node: GraphNode = {
			id: indexPath,
			// Slug as label — operators recognise project slugs (`naseej`,
			// `soul-hub-whatsapp`) instantly; the full index.md `title:`
			// often runs ~80 chars of descriptive prose that occludes
			// neighbouring nodes in graph view. Detail-page tooltips still
			// surface the rich title.
			label: slug,
			type: 'project',
			zone: 'projects',
			tags: tagList,
			// Per ADR-005: `size` is repurposed for project-level graph to
			// activity_30d so the renderer can scale nodes by activity.
			// Floor of 1 keeps inactive projects visible.
			size: Math.max(1, activity30d),
			color,
			mtime: indexNote?.mtime,
			created: createdIso,
			shape,
			aggregateStatus: { open: openCount, shipped: shippedCount, total: totalDecisions },
			hasOverdueFalsifier,
			cluster,
			parent,
		};

		nodes.push(node);
		bySlug.set(slug, node);

		if (parent) pendingParentEdges.push({ from: parent, to: slug });
	}

	// Resolve parent edges. Drop any edge whose parent slug doesn't appear
	// as a node — keeps the graph clean if a project references a parent
	// that hasn't been created yet (or was deleted out from under it).
	const edges: GraphEdge[] = [];
	for (const e of pendingParentEdges) {
		const parentNode = bySlug.get(e.from);
		const childNode = bySlug.get(e.to);
		if (!parentNode || !childNode) continue;
		edges.push({
			source: parentNode.id,
			target: childNode.id,
			type: 'parent',
		});
	}
	// projects-graph ADR-006 — resolve producer→consumer edges. Same
	// drop-when-orphaned discipline as parent edges. Producer's id =
	// source; consumer's id = target so the arrowhead points consumer-ward.
	for (const e of pendingProducerEdges) {
		const producerNode = bySlug.get(e.from);
		const consumerNode = bySlug.get(e.to);
		if (!producerNode || !consumerNode) continue;
		edges.push({
			source: producerNode.id,
			target: consumerNode.id,
			type: 'produces_for',
		});
	}

	// Cluster grouping — projects with no `cluster:<name>` tag land in
	// `ungrouped`. Determinism: sort cluster names alphabetically so the
	// downstream renderer (which assigns colors by index) is stable.
	const clusterMap = new Map<string, string[]>();
	for (const node of nodes) {
		const key = node.cluster ?? UNGROUPED_CLUSTER;
		const list = clusterMap.get(key) ?? [];
		list.push(node.id.replace(/^projects\//, '').replace(/\/index\.md$/, ''));
		clusterMap.set(key, list);
	}
	const clusters = [...clusterMap.entries()]
		.map(([name, member_slugs]) => ({ name, member_slugs: member_slugs.sort() }))
		.sort((a, b) => {
			if (a.name === UNGROUPED_CLUSTER) return 1;
			if (b.name === UNGROUPED_CLUSTER) return -1;
			return a.name.localeCompare(b.name);
		});

	const payload: ProjectGraphData = { nodes, edges, clusters };
	return json(payload);
};
