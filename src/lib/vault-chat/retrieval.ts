/** Retrieval merger — runs the selected tools, merges results, deduplicates
 *  by path, reranks, and hydrates the top-K notes with their full body for
 *  the formatter. */

import type { VaultNote } from '../vault/types.js';
import type { RetrievedNote, ToolCall } from './tools.js';
import { runTool, requireEngine } from './tools.js';

const TOP_K = 6;

export interface HydratedNote extends RetrievedNote {
	/** Full markdown body (no frontmatter). Trimmed to a sensible length
	 *  before the formatter ever sees it. */
	body: string;
	/** Note creation/update dates from frontmatter, when present. */
	created?: string;
	updated?: string;
	/** Outgoing wikilinks — useful for the LLM to suggest related notes. */
	outgoingLinks: string[];
}

/** Merge results across tools: dedupe by path, sum scores when a note is
 *  surfaced by multiple tools (cross-tool agreement = stronger signal),
 *  and remember every tool that surfaced it (for provenance). */
function mergeResults(perTool: RetrievedNote[][]): RetrievedNote[] {
	const byPath = new Map<string, RetrievedNote & { sources: Set<string> }>();
	for (const list of perTool) {
		for (const r of list) {
			const existing = byPath.get(r.path);
			if (existing) {
				existing.score += r.score;
				existing.sources.add(r.source);
				// Preserve the best snippet (fulltext usually wins).
				if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
			} else {
				byPath.set(r.path, { ...r, sources: new Set([r.source]) });
			}
		}
	}
	return Array.from(byPath.values()).map((entry) => ({
		path: entry.path,
		title: entry.title,
		type: entry.type,
		tags: entry.tags,
		project: entry.project,
		score: entry.score,
		snippet: entry.snippet,
		// Encode provenance in source as a comma-joined string for the formatter.
		source: Array.from(entry.sources).join('+') as RetrievedNote['source'],
	}));
}

/** Hydrate a result with the full note body so the formatter can pull a
 *  decent excerpt. Falls back to snippet if the engine can't find the
 *  note (race with file deletion). */
function hydrate(r: RetrievedNote, note: VaultNote | undefined): HydratedNote {
	if (!note) {
		return {
			...r,
			body: r.snippet ?? '',
			outgoingLinks: [],
		};
	}
	return {
		...r,
		body: note.content,
		created: typeof note.meta.created === 'string' ? note.meta.created : undefined,
		updated: typeof note.meta.updated === 'string' ? note.meta.updated : undefined,
		outgoingLinks: note.links.map((l) => l.resolved ?? l.raw).filter(Boolean) as string[],
	};
}

export interface RetrievalOutcome {
	notes: HydratedNote[];
	totalSurfaced: number;
	toolsRun: ToolCall[];
}

export function retrieve(toolCalls: ToolCall[]): RetrievalOutcome {
	const engine = requireEngine();
	if (!engine) {
		return { notes: [], totalSurfaced: 0, toolsRun: toolCalls };
	}

	const perTool: RetrievedNote[][] = toolCalls.map((c) => runTool(c));
	const merged = mergeResults(perTool);
	const totalSurfaced = merged.length;

	const top = merged
		.sort((a, b) => b.score - a.score)
		.slice(0, TOP_K)
		.map((r) => hydrate(r, engine.getNote(r.path)));

	return { notes: top, totalSurfaced, toolsRun: toolCalls };
}
