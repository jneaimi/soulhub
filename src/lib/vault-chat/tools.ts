/** Vault retrieval tools — thin typed wrappers over the in-process vault
 *  engine. Each tool returns `RetrievedNote[]`, a uniform shape the selector
 *  result merger consumes. The orchestrator picks 1–3 of these per query
 *  (per ADR-004's lexical-first design) instead of running a single
 *  semantic embedding lookup.
 *
 *  All tools degrade gracefully: if the engine isn't initialised they
 *  return `[]` rather than throwing — callers add the orchestrator's
 *  failure mode (no augmentation), not a 500. A one-time warning fires on
 *  the first null-engine call so silent retrieval failures become visible
 *  in logs (this masquerades as a model bug otherwise; see ADR-034 smoke
 *  2026-05-14). */

import { getVaultEngine, type VaultEngine } from '../vault/index.js';
import type { VaultNote, SearchResult } from '../vault/types.js';

let warnedEngineNull = false;

/** Return the vault engine if initialised; warn-once and return null otherwise.
 *  Use instead of `getVaultEngine()` directly so missing-init bugs surface as
 *  a single log line rather than silent empty retrievals. Exported so other
 *  vault-chat modules (e.g. `retrieval.ts`) share the same warned-once flag. */
export function requireEngine(): VaultEngine | null {
	const engine = getVaultEngine();
	if (engine) return engine;
	if (!warnedEngineNull) {
		warnedEngineNull = true;
		console.warn(
			'[vault-chat/tools] getVaultEngine() returned null — vault retrieval tools will return [] until initVault() runs. In the PM2 server this indicates a startup ordering bug; in smoke/test scripts call `await initVault(config.resolved.vaultDir)` first.',
		);
	}
	return null;
}

/** Tool names exposed to the selector. Keep this list small — every name
 *  becomes part of the JSON schema we ship to Gemini. */
export type ToolName =
	| 'fulltext'
	| 'recent'
	| 'byType'
	| 'byTag'
	| 'byZone'
	| 'byProject'
	| 'backlinks';

export interface ToolCall {
	name: ToolName;
	args: Record<string, unknown>;
}

/** Uniform retrieval result. `score` is normalised so the merger can
 *  rerank across tools with different scoring conventions. `source` lets
 *  the formatter show provenance ("via fulltext", "via byProject"). */
export interface RetrievedNote {
	path: string;
	title: string;
	type?: string;
	tags?: string[];
	project?: string;
	score: number;
	snippet?: string;
	source: ToolName;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function clampLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
	const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

function fromSearchResult(r: SearchResult, source: ToolName): RetrievedNote {
	return {
		path: r.path,
		title: r.title,
		type: r.type,
		tags: r.tags,
		project: r.project,
		score: r.score,
		snippet: r.snippet,
		source,
	};
}

/** VaultNote → RetrievedNote. Bare `getRecent` / `getBacklinks` return
 *  full notes with no score, so we synthesise one (lower than typical
 *  fulltext scores so MiniSearch hits stay on top when both fire). */
function fromVaultNote(n: VaultNote, source: ToolName, score = 0.4): RetrievedNote {
	return {
		path: n.path,
		title: n.title,
		type: n.meta.type,
		tags: n.meta.tags,
		project: n.meta.project,
		score,
		source,
	};
}

export function fulltext(args: { q?: string; limit?: number }): RetrievedNote[] {
	const engine = requireEngine();
	if (!engine || !args.q) return [];
	const results = engine.getNotes({ q: args.q, limit: clampLimit(args.limit) });
	return results.map((r) => fromSearchResult(r, 'fulltext'));
}

export function recent(args: { limit?: number }): RetrievedNote[] {
	const engine = requireEngine();
	if (!engine) return [];
	const notes = engine.getRecent(clampLimit(args.limit));
	// Recent-by-mtime — give the newest a small boost so freshness wins on ties.
	return notes.map((n, i) => fromVaultNote(n, 'recent', 0.5 - i * 0.01));
}

export function byType(args: { type?: string | string[]; limit?: number }): RetrievedNote[] {
	const engine = requireEngine();
	if (!engine || !args.type) return [];
	const results = engine.getNotes({ type: args.type, limit: clampLimit(args.limit) });
	return results.map((r) => fromSearchResult(r, 'byType'));
}

export function byTag(args: { tags?: string | string[]; limit?: number }): RetrievedNote[] {
	const engine = requireEngine();
	if (!engine) return [];
	const tags = Array.isArray(args.tags)
		? args.tags
		: typeof args.tags === 'string'
			? args.tags.split(',').map((t) => t.trim()).filter(Boolean)
			: [];
	if (tags.length === 0) return [];
	const results = engine.getNotes({ tags, limit: clampLimit(args.limit) });
	return results.map((r) => fromSearchResult(r, 'byTag'));
}

export function byZone(args: { zone?: string; limit?: number }): RetrievedNote[] {
	const engine = requireEngine();
	if (!engine || !args.zone) return [];
	// Top-level vault folder filter: `finance`, `projects`, `operations`,
	// `knowledge`, `inbox`, `content`, `archive`, `security`, plus any
	// nested zone path (`projects/soul-hub-whatsapp`). The engine accepts
	// both forms via SearchQuery.zone. Sorted by engine's default score
	// (mtime-recency-leaning for non-fulltext queries).
	const zone = args.zone.replace(/^\/+|\/+$/g, ''); // strip wrapping slashes
	const results = engine.getNotes({ zone, limit: clampLimit(args.limit) });
	return results.map((r) => fromSearchResult(r, 'byZone'));
}

export function byProject(args: { project?: string; limit?: number }): RetrievedNote[] {
	const engine = requireEngine();
	if (!engine || !args.project) return [];
	const results = engine.getNotes({ project: args.project, limit: clampLimit(args.limit) });
	return results.map((r) => fromSearchResult(r, 'byProject'));
}

export function backlinks(args: { path?: string; limit?: number }): RetrievedNote[] {
	const engine = requireEngine();
	if (!engine || !args.path) return [];
	const notes = engine.getBacklinks(args.path).slice(0, clampLimit(args.limit));
	return notes.map((n) => fromVaultNote(n, 'backlinks', 0.45));
}

/** Selector picks names; this dispatches to the right wrapper. Unknown
 *  names are dropped silently rather than throwing — the selector can
 *  hallucinate names and we'd rather lose retrieval than crash dispatch. */
export function runTool(call: ToolCall): RetrievedNote[] {
	switch (call.name) {
		case 'fulltext':
			return fulltext(call.args as Parameters<typeof fulltext>[0]);
		case 'recent':
			return recent(call.args as Parameters<typeof recent>[0]);
		case 'byType':
			return byType(call.args as Parameters<typeof byType>[0]);
		case 'byTag':
			return byTag(call.args as Parameters<typeof byTag>[0]);
		case 'byZone':
			return byZone(call.args as Parameters<typeof byZone>[0]);
		case 'byProject':
			return byProject(call.args as Parameters<typeof byProject>[0]);
		case 'backlinks':
			return backlinks(call.args as Parameters<typeof backlinks>[0]);
		default:
			return [];
	}
}

/** Tool catalog shipped to the selector — keeps name/description/argument
 *  shape in one place so the JSON schema and the runtime stay aligned. */
export const TOOL_CATALOG: Array<{
	name: ToolName;
	description: string;
	args: string;
}> = [
	{
		name: 'fulltext',
		description:
			'Full-text MiniSearch across every note (title × 3 + tags × 2 + body). Use for ANY query with topic words — "what did I write about X", concept lookups, partial recall.',
		args: 'q: string (required), limit: number (1–20, default 8)',
	},
	{
		name: 'recent',
		description:
			'Most-recently-modified notes across the whole vault. Use for "what did I do today/this week", "latest", "newest" — when the user wants temporal context, not topical.',
		args: 'limit: number (1–20, default 8)',
	},
	{
		name: 'byType',
		description:
			'Filter by note type. Common types: decision, learning, debugging, pattern, project, research, draft, output, snippet, recipe, note. Use when the user asks for a specific kind of note ("show my recent decisions", "find the ADRs about X").',
		args: 'type: string or string[] (required), limit: number (default 8)',
	},
	{
		name: 'byTag',
		description:
			'Filter by frontmatter tags (AND logic — every tag must match). Use when the user names a tag explicitly ("notes tagged whatsapp", "anything tagged retired and decision").',
		args: 'tags: string or string[] (required), limit: number (default 8)',
	},
	{
		name: 'byZone',
		description:
			'Notes inside a vault top-level zone (folder). The six canonical zones: `finance`, `inbox`, `knowledge`, `content`, `operations`, `projects`, `archive`, `security`. Use when the user names a zone directly ("my finance notes", "latest in operations", "what\'s in finance", "show me content drafts"). Frontmatter `tags` are unreliable for zone membership (auto-routed notes often have empty tags) — `byZone` reads the path prefix directly. For nested scopes, pass the full path (`projects/soul-hub-whatsapp`).',
		args: 'zone: string (required, e.g. "finance" or "projects/signal-forge"), limit: number (default 8)',
	},
	{
		name: 'byProject',
		description:
			'All notes for a given project (`project:` frontmatter field). Use when the user names a project ("show me the soul-hub-whatsapp project", "what\'s the status of signal-forge"). Project names are kebab-case. For zone-style queries ("my finance notes") prefer `byZone`.',
		args: 'project: string (required), limit: number (default 8)',
	},
	{
		name: 'backlinks',
		description:
			'Notes that link TO a given note path. Use only when the user has named a specific note path or you have a strong path-shaped reference from a previous tool call.',
		args: 'path: string (required, e.g. "projects/soul-hub-whatsapp/index.md"), limit: number (default 8)',
	},
];
