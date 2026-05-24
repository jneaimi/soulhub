/** Vault engine types — the knowledge layer for Soul Hub */

// ── Note Types ──────────────────────────────────────────────

export interface VaultNote {
	/** Relative path from vault root (e.g., "projects/soul-hub/decisions/pty-bridge.md") */
	path: string;
	/** Note title (from frontmatter title, first heading, or filename) */
	title: string;
	/** Parsed frontmatter fields */
	meta: VaultMeta;
	/** Raw markdown content (without frontmatter block) */
	content: string;
	/** Extracted outgoing wikilinks */
	links: VaultLink[];
	/** Computed backlinks — paths of notes that link TO this note */
	backlinks: string[];
	/** File modification time (ms since epoch) */
	mtime: number;
	/** File size in bytes */
	size: number;
}

/** Per projects-graph ADR-001. Declared shape of a project — drives shape-aware
 *  rendering on `/projects` and `/projects/[slug]`. Only meaningful on a project
 *  root `index.md`; enforced at the vault-write chokepoint. Five PRIMARY modes +
 *  two META modes. See ~/vault/projects/CLAUDE.md `## Allowed Project Shapes`. */
export type ProjectShape =
	| 'coding-spine'
	| 'producer-pipeline'
	| 'publishing-outlet'
	| 'strategy-initiative'
	| 'time-boxed-bet'
	| 'maintained-system'
	| 'parent';

/** Canonical enum list — same order as `## Allowed Project Shapes` in
 *  `~/vault/projects/CLAUDE.md`. Used by the chokepoint validator and the
 *  `soul project label-shape` CLI verb. Single source of truth in code. */
export const PROJECT_SHAPES: readonly ProjectShape[] = [
	'coding-spine',
	'producer-pipeline',
	'publishing-outlet',
	'strategy-initiative',
	'time-boxed-bet',
	'maintained-system',
	'parent',
] as const;

export interface VaultMeta {
	type?: string;
	status?: string;
	created?: string;
	updated?: string;
	tags?: string[];
	project?: string;
	source?: string;
	language?: string;
	resolved?: boolean;
	source_agent?: string;
	source_context?: string;
	/** projects-graph ADR-001 — declared project shape. Applies only on
	 *  `projects/<slug>/index.md` notes; enforced at chokepoint. */
	project_shape?: ProjectShape;
	/** projects-graph ADR-001 — free-text claim that if true at
	 *  `falsifier_date:` signals the project has failed. Lives on the project
	 *  root `index.md` alongside companion `falsifier_date:` (Shape A) or
	 *  alone (Shape D, undated commitment). */
	project_falsifier?: string;
	/** projects-graph ADR-006 — cross-project producer→consumer edges
	 *  declared on the PRODUCER side only. Each entry is either a bare
	 *  wikilink string (`"[[social-media-launch|social-media-launch]]"`)
	 *  or a rich-form object with optional `destination` (for `edge-flow`
	 *  staleness watching), `falsifier`, and `falsifier_date`. The
	 *  reverse view (`consumes_from`) is COMPUTED read-time by inverting
	 *  every project's declarations — never stored. */
	produces_for?: ProducerEdge[];
	/** Catch-all for custom frontmatter fields */
	[key: string]: unknown;
}

/** projects-graph ADR-006 — single `produces_for[]` entry. Operators
 *  reach for the simple string form for typical producer→consumer
 *  declarations; the rich object form opts the edge into vault-scout's
 *  edge-stale watcher by adding `destination` + `falsifier`. */
export type ProducerEdge =
	| string
	| {
		/** Wikilink to the consumer project: `[[<slug>|<alias>]]`. */
		target: string;
		/** Path the consumer reads from. Vault-internal
		 *  (`~/vault/content/signal-forge/drafts/`) OR external
		 *  (`~/Downloads/peer-brief-*.pdf`). Watched by edge-flow.ts. */
		destination?: string;
		/** Free-text claim that, if true at `falsifier_date:`, signals
		 *  the producer→consumer chain is broken. */
		falsifier?: string;
		/** Companion ISO date for `falsifier`. */
		falsifier_date?: string;
	};

export interface VaultLink {
	/** Raw link text as written: "Some Note" or "folder/note" */
	raw: string;
	/** Resolved path relative to vault root (null if unresolved) */
	resolved: string | null;
	/** Display alias (from [[target|alias]]) */
	alias?: string;
	/** Heading anchor (from [[target#heading]]) */
	heading?: string;
	/** Whether this is an embed (![[...]]) */
	embed: boolean;
}

// ── Parsed Note (before indexing) ───────────────────────────

export interface ParsedNote {
	title: string;
	meta: VaultMeta;
	content: string;
	links: VaultLink[];
}

// ── Config & Governance ─────────────────────────────────────

export interface VaultConfig {
	/** Vault root directory (absolute path) */
	rootDir: string;
	/** Template directory (absolute path) */
	templateDir: string;
	/** Index cache file path */
	indexPath: string;
	/** Auto-discovered zone rules */
	zones: VaultZone[];
}

export interface VaultZone {
	/** Folder path relative to vault root */
	path: string;
	/** Allowed note types in this zone */
	allowedTypes: string[];
	/** Whether templates are required for writes */
	requireTemplate: boolean;
	/** Required frontmatter fields beyond the global defaults */
	requiredFields: string[];
	/** Naming pattern regex (validated on write) */
	namingPattern?: string;
	/** Allowed `status:` values (canonical set per zone). Empty = no
	 *  restriction. Sourced from CLAUDE.md `## Allowed Statuses` section.
	 *  Scope (decision-only vs all-types) is controlled separately via
	 *  `allowedStatusesScope` — see below. */
	allowedStatuses: string[];
	/** projects-graph ADR-002 — which note types `allowedStatuses` applies to.
	 *  `'decisions-only'` (default, backwards-compat): only `type: decision`
	 *  notes get canonical-set validation. `'all-types'`: every note in the
	 *  zone with a `status:` field gets validated, regardless of `type`.
	 *  Sourced from CLAUDE.md `## Allowed Statuses Scope` (a one-line
	 *  section containing exactly one of the two values). */
	allowedStatusesScope: 'decisions-only' | 'all-types';
	/** Allowed relationship-field NAMES on decision notes (e.g. supersedes,
	 *  blocks, blocked_by, relates_to, extends, superseded_by). Values for
	 *  these fields must be wikilink format `[[slug]]` (or list of). Empty =
	 *  no restriction. Sourced from CLAUDE.md `## Allowed Relationship Fields`. */
	allowedRelationshipFields: string[];
	/** projects-graph ADR-001 — allowed `project_shape:` values on project root
	 *  `index.md` notes. Empty = no restriction. Sourced from CLAUDE.md
	 *  `## Allowed Project Shapes`. */
	allowedProjectShapes: string[];
	/** Raw governance text (from CLAUDE.md) */
	rawGovernance: string;
}

// ── Search ──────────────────────────────────────────────────

export interface SearchQuery {
	/** Text query (fuzzy matched against title + content + tags) */
	q?: string;
	/** Filter by note type (single or multiple, OR logic) */
	type?: string | string[];
	/** Filter by tags (AND logic — all must match) */
	tags?: string[];
	/** Filter by zone (top-level folder) */
	zone?: string;
	/** Filter by project name */
	project?: string;
	/** Max results (default 20) */
	limit?: number;
	/** Offset for pagination */
	offset?: number;
}

export interface SearchResult {
	path: string;
	title: string;
	type?: string;
	tags?: string[];
	project?: string;
	status?: string;
	score: number;
	/** Matching content snippet */
	snippet?: string;
}

// ── Graph ───────────────────────────────────────────────────

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface GraphNode {
	/** Note path (unique ID) */
	id: string;
	/** Display label (note title) */
	label: string;
	/** Note type from frontmatter */
	type?: string;
	/** Top-level zone folder */
	zone: string;
	/** Note tags from frontmatter */
	tags?: string[];
	/** Node size (based on total link count: outgoing + incoming) */
	size: number;
	/** Color (derived from zone) */
	color: string;
	/** Raw degree count (links + backlinks + tag connections) for ranking */
	degree?: number;
	/** File modification time (ms since epoch) — for date range filtering */
	mtime?: number;
	/** Frontmatter `created` date string (YYYY-MM-DD) — semantic newness */
	created?: string;
	// ── projects-graph ADR-005 — project-level graph extension ────────
	// All fields below are OPTIONAL and only populated by the project-level
	// endpoint (`/api/vault/projects/graph`). The note-level endpoint
	// (`/api/vault/graph`, consumed by `/vault`) keeps the original shape
	// bit-for-bit and never reads these. Reusing one struct so the
	// `<VaultGraph>` renderer stays a single component for both surfaces.
	/** ADR-001 project shape — drives shape-aware colorizer when set. */
	shape?: ProjectShape;
	/** ADR-004 aggregate-status rollup summed across self + descendants
	 *  (open / shipped / total). Drives badge rendering on the node. */
	aggregateStatus?: { open: number; shipped: number; total: number };
	/** True when this project — or any descendant — has a falsifier whose
	 *  date is in the past. Surfaces an urgency badge on the node. */
	hasOverdueFalsifier?: boolean;
	/** Cluster name extracted from `cluster:<name>` tag on root index.md.
	 *  Drives cluster-band grouping in hierarchical layout. */
	cluster?: string;
	/** Slug of parent project (from `parent_project: "[[slug]]"`); null
	 *  for root projects. Layout-mode picker uses this for hierarchical
	 *  positioning. */
	parent?: string | null;
}

export interface GraphEdge {
	/** Source note path */
	source: string;
	/** Target note path */
	target: string;
	/** Edge label (link alias if any) */
	label?: string;
	/** projects-graph ADR-005 — edge type. Only set on project-level
	 *  graph; note-level edges leave it unset. `'parent'` is the only
	 *  type emitted by ADR-005; ADR-006 extends with `'produces_for'`
	 *  and `'consumes_from'`. */
	type?: 'parent' | 'produces_for' | 'consumes_from' | 'supersedes' | 'successor_of';
}

// ── Projects graph (ADR-005) ───────────────────────────────

/** Response shape of `/api/vault/projects/graph` — project-level graph
 *  for the `/projects?view=graph` opt-in view. Nodes are projects; edges
 *  are parent_project (today) + ADR-006 cross-project producer edges
 *  (future). Clusters group nodes by `cluster:<name>` tag on root
 *  index.md; projects with no cluster land in `'ungrouped'`. */
export interface ProjectGraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	clusters: Array<{ name: string; member_slugs: string[] }>;
}

// ── Stats & Health ──────────────────────────────────────────

export interface VaultStats {
	totalNotes: number;
	notesByType: Record<string, number>;
	notesByZone: Record<string, number>;
	totalLinks: number;
	unresolvedLinks: number;
	orphanNotes: number;
	lastIndexed: string;
}

export interface VaultHealth {
	indexed: number;
	staleFiles: string[];
	orphanNotes: string[];
	unresolvedLinks: { source: string; raw: string }[];
	lastIndexed: string;
}

// ── Write Operations ────────────────────────────────────────

export interface CreateNoteRequest {
	/** Target zone (e.g., "projects/soul-hub/learnings") */
	zone: string;
	/** Filename (e.g., "2026-04-10-scheduler-race.md") */
	filename: string;
	/** Frontmatter fields */
	meta: VaultMeta;
	/** Markdown content body */
	content: string;
}

export interface UpdateNoteRequest {
	/** Updated frontmatter fields (merged with existing) */
	meta?: Partial<VaultMeta>;
	/** Updated content (replaces existing) */
	content?: string;
}

/** ADR-003 S4 — per-call provenance for `updateNote`. Lets server-side
 *  callers (orchestrator tools, recipe steps, internal mutators) stamp the
 *  audit log + git commit with WHO triggered this update, distinct from
 *  the note's frontmatter `source_agent` (which records the author of the
 *  note, not the last toucher).
 *
 *  When omitted, audit-log + commit attribution fall back to
 *  `existing.meta.source_agent` / `source_context` (pre-S4 behaviour). */
export interface UpdateNoteOpts {
	/** Actor performing this specific update — e.g. `"projectShipSlice"`. */
	actor?: string;
	/** Free-form one-line context, e.g. `"adr=adr-003 slice=S4 status=shipped"`. */
	actorContext?: string;
}

/** ADR-005 S0 — per-call provenance for `createNote`. Mirror of
 *  `UpdateNoteOpts`. Lets server-side callers (orchestrator tools like
 *  proposeAdr, recipe steps, propose-slice) stamp the audit log + git
 *  commit with WHO triggered this CREATE, distinct from the new note's
 *  frontmatter `source_agent` (which records the author of the note,
 *  not the tool that triggered the write).
 *
 *  When omitted, audit-log + commit attribution fall back to
 *  `req.meta.source_agent` / `source_context` (pre-S0 behaviour). */
export interface CreateNoteOpts {
	/** Actor performing this specific create — e.g. `"proposeAdr"`. */
	actor?: string;
	/** Free-form one-line context, e.g. `"slug=naseej tier=2 working_title='X'"`. */
	actorContext?: string;
}

export interface WriteResult {
	success: true;
	path: string;
	/** ADR-047 — link-validator warnings (non-fatal). Empty array elided on the
	 *  wire by the API route when there are no warnings. */
	warnings?: LinkIssue[];
	/** ADR-049 — stub notes materialised for forward refs when the caller set
	 *  `meta.scaffold_stubs: true`. Each entry is a vault-relative path to a
	 *  newly-created empty stub. Elided when none were created. */
	stubs_created?: StubInfo[];
}

/** ADR-049 — record of one stub note created by the scaffold_stubs flow. */
export interface StubInfo {
	/** Vault-relative path of the new stub (e.g., "projects/foo/bar.md"). */
	path: string;
	/** The raw wikilink in the parent that triggered the stub creation. */
	for_link: string;
	/** Parent note's vault-relative path. */
	source: string;
}

export interface WriteError {
	success: false;
	error: string;
	field?: string;
	/** ADR-047 — populated when refusal is link-validation driven. The `error`
	 *  string carries the first issue's human-readable message; this array
	 *  carries every error for batch correction by the agent. */
	linkErrors?: LinkIssue[];
}

/** ADR-047 — shape of a single wikilink validation issue. Re-exported from
 *  `link-validator.ts` so API callers don't need to import the validator. */
export interface LinkIssue {
	rule: 'auto-memory-wikilink' | 'bare-project-slug' | 'unresolved-target';
	link: string;
	suggestion: string;
}

export interface WriteLogEntry {
	timestamp: string;
	action: 'create' | 'update' | 'archive' | 'move' | 'delete' | 'create-asset';
	path: string;
	previousPath?: string;
	agent?: string;
	context?: string;
	zone: string;
	type?: string;
	success: boolean;
	error?: string;
}

/** Slice 0 — binary asset writes. Mirrors `CreateNoteRequest` discipline
 *  but for non-markdown files (images, voice, video, documents). Captures
 *  land in `inbox/assets/<YYYY-MM-DD>-<slug>.<ext>` per the brain
 *  frontmatter contract. Notes reference assets via `attachments[].path`. */
export interface WriteAssetRequest {
	/** Target zone (e.g., "inbox/assets"). */
	zone: string;
	/** Filename including extension (e.g., "2026-05-03-voice-note.ogg"). */
	filename: string;
	/** Raw bytes. */
	buffer: Buffer;
	/** MIME type (e.g., "audio/ogg", "image/jpeg"). Stored in the write
	 *  log for audit; not enforced beyond size + zone checks. */
	mimetype: string;
	/** Agent name for rate limiting + audit (e.g., "whatsapp-brain"). */
	agent?: string;
	/** Optional source context (chat JID, message ID) for traceability. */
	context?: string;
}

// ── Template ────────────────────────────────────────────────

export interface VaultTemplate {
	/** Template name (matches note type) */
	name: string;
	/** Raw template content with {{placeholders}} */
	raw: string;
	/** Required frontmatter fields extracted from template */
	requiredFields: string[];
	/** Section headings expected in the content */
	expectedSections: string[];
	/** True when the template's body leads with a top-level `# ` H1 (e.g.
	 *  `# {{title}}`). Notes of this type must then carry an H1 — the project
	 *  graph derives node labels from it, and a body starting at `## Status`
	 *  falls back to an ugly slug-derived label. */
	requiresH1: boolean;
}

// ── Zone color mapping ──────────────────────────────────────

export const ZONE_COLORS: Record<string, string> = {
	inbox: '#f59e0b',        // amber
	projects: '#6366f1',     // indigo
	knowledge: '#06b6d4',    // cyan
	content: '#8b5cf6',      // violet
	operations: '#64748b',   // slate
	archive: '#6b7280',      // gray
};

/** projects-graph ADR-005 — project shape → color. Used by the
 *  project-level graph endpoint (`/api/vault/projects/graph`) to derive
 *  `GraphNode.color`. Mirrors the seven `ProjectShape` enum values; the
 *  hex palette matches the per-shape pill rendering on `/projects/[slug]`
 *  so the graph and detail views read consistently. */
export const SHAPE_COLORS: Record<ProjectShape, string> = {
	'coding-spine':         '#6366f1', // indigo  — ADR-driven engineering work
	'producer-pipeline':    '#14b8a6', // teal    — agent/cadence-driven outputs
	'publishing-outlet':    '#8b5cf6', // violet  — content kanban
	'strategy-initiative':  '#f59e0b', // amber   — multi-facet planning
	'time-boxed-bet':       '#ef4444', // red     — dated, falsifier-anchored
	'maintained-system':    '#64748b', // slate   — shipped + ongoing
	'parent':               '#9ca3af', // gray    — pure container
};

export const TYPE_COLORS: Record<string, string> = {
	// Knowledge types
	learning: '#10b981',     // emerald
	decision: '#f59e0b',     // amber
	debugging: '#ef4444',    // red
	pattern: '#8b5cf6',      // violet
	research: '#06b6d4',     // cyan
	snippet: '#ec4899',      // pink
	report: '#14b8a6',       // teal
	analysis: '#06b6d4',     // cyan
	review: '#14b8a6',       // teal
	recipe: '#f97316',       // orange
	evaluation: '#06b6d4',   // cyan
	'data-pack': '#06b6d4',  // cyan
	reference: '#9ca3af',    // gray-400
	guide: '#9ca3af',        // gray-400
	wiki: '#9ca3af',         // gray-400
	// Content types
	draft: '#a78bfa',        // violet-400
	'social-draft': '#a78bfa',
	'social-post': '#8b5cf6',
	'article-draft': '#a78bfa',
	'video-script': '#c084fc',
	'video-script-draft': '#c084fc',
	'content-menu': '#8b5cf6',
	'content-prep': '#8b5cf6',
	ideas: '#d946ef',        // fuchsia
	'daily-quote': '#d946ef',
	'media-asset': '#8b5cf6',
	'insight-draft': '#a78bfa',
	'miner-report': '#14b8a6',
	'signal-report': '#14b8a6',
	'strategist-prep': '#14b8a6',
	'action-list': '#0d9488',       // teal-600 — Strategist outputs
	'weekly-review': '#0d9488',
	// Project types
	project: '#6366f1',      // indigo
	output: '#3b82f6',       // blue
	index: '#9ca3af',        // gray-400
	task: '#3b82f6',         // blue
	design: '#6366f1',       // indigo
	requirements: '#6366f1', // indigo
	// Operations types
	'agent-profile': '#64748b',
	config: '#64748b',
	'session-log': '#64748b',
	playbook: '#64748b',
	'system-config': '#64748b',
	identity: '#64748b',
	boundaries: '#64748b',
	// Legacy (migration compat)
	daily: '#6b7280',
	adr: '#f59e0b',
	analytics: '#06b6d4',
};

/**
 * Tailwind chip classes per note type — used by sidebar/search/list chips.
 * Format: `bg-{color}-500/20 text-{color}-400` for visual distinction
 * (darker shade behind a lighter foreground). Single source of truth so
 * Sidebar/Search/List don't drift out of sync.
 *
 * For inline-style chips (e.g. table cells in `VaultList`), use `TYPE_COLORS`
 * directly with `style="background-color: {hex}26; color: {hex}"`.
 */
export const TYPE_CHIP_CLASSES: Record<string, string> = {
	// Knowledge
	learning: 'bg-emerald-500/20 text-emerald-400',
	decision: 'bg-amber-500/20 text-amber-400',
	debugging: 'bg-red-500/20 text-red-400',
	pattern: 'bg-violet-500/20 text-violet-400',
	research: 'bg-cyan-500/20 text-cyan-400',
	snippet: 'bg-pink-500/20 text-pink-400',
	report: 'bg-teal-500/20 text-teal-400',
	analysis: 'bg-cyan-500/20 text-cyan-400',
	review: 'bg-teal-500/20 text-teal-400',
	recipe: 'bg-orange-500/20 text-orange-400',
	reference: 'bg-gray-500/20 text-gray-400',
	guide: 'bg-gray-500/20 text-gray-400',
	wiki: 'bg-gray-500/20 text-gray-400',
	// Content
	draft: 'bg-violet-500/20 text-violet-300',
	'social-draft': 'bg-violet-500/20 text-violet-300',
	'social-post': 'bg-violet-500/20 text-violet-400',
	'article-draft': 'bg-violet-500/20 text-violet-300',
	'video-script': 'bg-purple-500/20 text-purple-400',
	'content-menu': 'bg-violet-500/20 text-violet-400',
	ideas: 'bg-fuchsia-500/20 text-fuchsia-400',
	'daily-quote': 'bg-fuchsia-500/20 text-fuchsia-400',
	'media-asset': 'bg-violet-500/20 text-violet-400',
	'miner-report': 'bg-teal-500/20 text-teal-400',
	'signal-report': 'bg-teal-500/20 text-teal-400',
	'strategist-prep': 'bg-teal-500/20 text-teal-300',
	'action-list': 'bg-teal-600/20 text-teal-300',
	'weekly-review': 'bg-teal-600/20 text-teal-300',
	'data-pack': 'bg-cyan-500/20 text-cyan-400',
	'content-prep': 'bg-violet-500/20 text-violet-300',
	// Project
	project: 'bg-indigo-500/20 text-indigo-400',
	output: 'bg-blue-500/20 text-blue-400',
	index: 'bg-gray-500/20 text-gray-400',
	task: 'bg-blue-500/20 text-blue-400',
	design: 'bg-indigo-500/20 text-indigo-400',
	// Operations
	'agent-profile': 'bg-slate-500/20 text-slate-400',
	config: 'bg-slate-500/20 text-slate-400',
	'session-log': 'bg-slate-500/20 text-slate-400',
	playbook: 'bg-slate-500/20 text-slate-400',
	// Legacy / migration compat
	daily: 'bg-gray-500/20 text-gray-400',
	adr: 'bg-amber-500/20 text-amber-400',
	analytics: 'bg-cyan-500/20 text-cyan-400',
};

/** Fallback chip class for an unrecognized note type. */
export const DEFAULT_TYPE_CHIP_CLASS = 'bg-hub-card text-hub-dim';

/** Default zone for notes without a recognized zone */
export const DEFAULT_ZONE = 'inbox';

/** Global required frontmatter fields (every note must have these) */
export const GLOBAL_REQUIRED_FIELDS = ['type', 'created', 'tags'];

/** Maximum note size in bytes (1MB) */
export const MAX_NOTE_SIZE = 1024 * 1024;

/** Maximum asset size in bytes (16MB). Aligned with the worker `_inbound`
 *  `mediaBase64?` cap so anything the worker can ship up the main app can
 *  also persist. Base64 inflates by ~33%, so 16MB raw ≈ 22MB encoded — the
 *  worker side caps the *encoded* string at 16MB to stay under SvelteKit's
 *  default request body limit. Keep in sync. */
export const MAX_ASSET_SIZE = 16 * 1024 * 1024;

/** Folders to ignore when scanning */
export const IGNORED_FOLDERS = ['.vault', '.obsidian', '.git', 'node_modules', '.trash'];
