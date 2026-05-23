import type { VaultNote, GraphData, GraphNode, GraphEdge } from './types.js';
import { ZONE_COLORS, TYPE_COLORS, DEFAULT_ZONE } from './types.js';

export class VaultGraph {
	build(notes: VaultNote[]): GraphData {
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];
		const edgeSet = new Set<string>();
		const noteSet = new Set(notes.map((n) => n.path));

		// Build tag index for tag-based edges
		const tagToNotes = new Map<string, string[]>();
		for (const note of notes) {
			for (const tag of note.meta.tags ?? []) {
				if (!tagToNotes.has(tag)) tagToNotes.set(tag, []);
				tagToNotes.get(tag)!.push(note.path);
			}
		}

		// Track tag connections per note for size calculation
		const tagConnections = new Map<string, number>();

		for (const note of notes) {
			const zone = getZone(note.path);
			const type = note.meta.type;

			nodes.push({
				id: note.path,
				label: note.title,
				type,
				zone,
				tags: note.meta.tags,
				mtime: note.mtime,
				size: 1, // updated below after edges are computed
				color: (type && TYPE_COLORS[type]) || ZONE_COLORS[zone] || '#6b7280',
			});

			// Wikilink edges (explicit connections)
			for (const link of note.links) {
				if (!link.resolved) continue;
				if (link.resolved === note.path) continue;
				if (!noteSet.has(link.resolved)) continue;

				const edgeKey = `${note.path}->${link.resolved}`;
				if (edgeSet.has(edgeKey)) continue;
				edgeSet.add(edgeKey);

				edges.push({
					source: note.path,
					target: link.resolved,
					label: link.alias,
				});
			}
		}

		// Tag-based edges: connect notes sharing tags (max 3 connections per tag to avoid clutter)
		const TAG_MAX_CONNECTIONS = 3;
		// Skip generic tags that would create too many edges
		const SKIP_TAGS = new Set(['test', 'session', 'pipeline', 'run-summary']);

		for (const [tag, paths] of tagToNotes) {
			if (SKIP_TAGS.has(tag)) continue;
			if (paths.length < 2 || paths.length > 30) continue; // skip rare or too-common tags

			// Connect first N pairs (not all combinations — O(n^2) would be too many)
			const limit = Math.min(paths.length, TAG_MAX_CONNECTIONS + 1);
			for (let i = 0; i < limit; i++) {
				for (let j = i + 1; j < limit; j++) {
					const a = paths[i];
					const b = paths[j];
					// Use canonical order to deduplicate
					const edgeKey = a < b ? `${a}~${b}` : `${b}~${a}`;
					if (edgeSet.has(edgeKey)) continue;
					edgeSet.add(edgeKey);

					edges.push({ source: a, target: b });

					tagConnections.set(a, (tagConnections.get(a) || 0) + 1);
					tagConnections.set(b, (tagConnections.get(b) || 0) + 1);
				}
			}
		}

		// Update node sizes — degree-based scaling (4–18px range)
		const MIN_SIZE = 4;
		const MAX_SIZE = 18;
		let maxDegree = 1;
		for (const node of nodes) {
			const wikilinks = notes.find(n => n.path === node.id);
			const linkCount = (wikilinks?.links.length || 0) + (wikilinks?.backlinks.length || 0);
			const tagCount = tagConnections.get(node.id) || 0;
			const degree = linkCount + tagCount;
			node.degree = degree;
			node.created = (wikilinks?.meta.created as string) || undefined;
			node.size = degree;
			if (degree > maxDegree) maxDegree = degree;
		}
		for (const node of nodes) {
			node.size = MIN_SIZE + ((node.degree ?? 0) / maxDegree) * (MAX_SIZE - MIN_SIZE);
		}

		return { nodes, edges };
	}

	local(notes: VaultNote[], centerPath: string, depth = 2): GraphData {
		const noteMap = new Map(notes.map((n) => [n.path, n]));
		const center = noteMap.get(centerPath);
		if (!center) return { nodes: [], edges: [] };

		const visited = new Set<string>();
		const queue: { path: string; d: number }[] = [{ path: centerPath, d: 0 }];
		visited.add(centerPath);

		while (queue.length > 0) {
			const current = queue.shift()!;
			if (current.d >= depth) continue;

			const note = noteMap.get(current.path);
			if (!note) continue;

			// Follow outgoing links
			for (const link of note.links) {
				if (link.resolved && !visited.has(link.resolved)) {
					visited.add(link.resolved);
					queue.push({ path: link.resolved, d: current.d + 1 });
				}
			}

			// Follow backlinks
			for (const bl of note.backlinks) {
				if (!visited.has(bl)) {
					visited.add(bl);
					queue.push({ path: bl, d: current.d + 1 });
				}
			}
		}

		const localNotes = notes.filter((n) => visited.has(n.path));
		return this.build(localNotes);
	}

}

function getZone(path: string): string {
	const segments = path.split('/');
	if (segments.length <= 1) return DEFAULT_ZONE;
	const first = segments[0];
	return ['inbox', 'projects', 'knowledge', 'content', 'operations', 'archive', 'finance', 'security'].includes(first)
		? first
		: DEFAULT_ZONE;
}
