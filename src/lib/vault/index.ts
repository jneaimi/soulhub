import { resolve, join, dirname } from 'node:path';
import { readFile, writeFile, rename, stat, mkdir, unlink } from 'node:fs/promises';
import matter from 'gray-matter';
import type {
	VaultNote, VaultConfig, SearchQuery, SearchResult,
	GraphData, VaultStats, VaultHealth, VaultZone, VaultTemplate,
	CreateNoteRequest, CreateNoteOpts, UpdateNoteRequest, UpdateNoteOpts, WriteAssetRequest, WriteResult, WriteError,
	WriteLogEntry, LinkIssue, StubInfo, VaultMeta
} from './types.js';
import { GLOBAL_REQUIRED_FIELDS, MAX_NOTE_SIZE, MAX_ASSET_SIZE } from './types.js';
import { VaultIndexer } from './indexer.js';
import { VaultSearch } from './search.js';
import { VaultGraph } from './graph.js';
import { VaultWatcher } from './watcher.js';
import { GovernanceResolver } from './governance.js';
import { TemplateLoader } from './templates.js';
import { validateLinks } from './link-validator.js';
import { rewriteBody, rewriteMeta, stripMd } from './relocate.js';
import type { MoveSpec, RelocateResult } from './relocate.js';
import { VaultCommitter } from './committer.js';
import { emitReindex } from './events.js';

let engine: VaultEngine | null = null;

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** projects-graph ADR-001 — match the project ROOT `index.md` (e.g.
 *  `projects/soul-hub/index.md`). Nested `index.md` files (design/,
 *  content-bank/, docs/) sit deeper and don't own `project_shape`. */
function isProjectRootIndex(path: string): boolean {
	return /^projects\/[^/]+\/index\.md$/.test(path);
}

/** projects-graph ADR-001 — validate `project_shape:` frontmatter value
 *  against the zone's `allowedProjectShapes` enum. Non-enum values are
 *  always refused. Missing field handling depends on `mode`:
 *    - `'create'` (Day 8+ cutover, flipped 2026-05-19 at 100% labelling
 *      coverage): REFUSE missing field on new project-root index.md.
 *    - `'update'`: still permissive — pre-cutover index.md files without a
 *      shape can be edited normally; backfill via `soul project label-shape`.
 *  Returns null on pass. */
function validateProjectShape(
	notePath: string,
	meta: VaultMeta,
	zone: VaultZone,
	mode: 'create' | 'update' = 'update',
): string | null {
	if (!isProjectRootIndex(notePath)) return null;
	if (zone.allowedProjectShapes.length === 0) return null;
	// Typed ProjectShape, but sourced from untyped YAML — can be '' at runtime.
	const raw: unknown = meta.project_shape;
	if (raw === undefined || raw === null || raw === '') {
		if (mode === 'create') {
			return `Missing project_shape on project-root index.md (projects-graph ADR-001 Day 8+ cutover — allowed: ${zone.allowedProjectShapes.join(', ')})`;
		}
		return null;
	}
	const value = String(raw).toLowerCase();
	if (!zone.allowedProjectShapes.includes(value)) {
		return `project_shape "${raw}" not in canonical set (allowed: ${zone.allowedProjectShapes.join(', ')})`;
	}
	return null;
}

/** projects-graph ADR-002 — validate `status:` against the zone's canonical
 *  set, honoring the `allowedStatusesScope` sentinel.
 *
 *  - `'decisions-only'` (zone default): only `type: decision` notes are checked.
 *    Preserves pre-ADR-002 behaviour and lets every other type free-text status.
 *  - `'all-types'`: every note with a non-empty `status:` field is checked.
 *
 *  Returns null on pass (including absent status, empty allowedStatuses, or
 *  scope mismatch). Returns a refusal message on a non-canonical value.
 *
 *  The sentinel is the cutover lever: operators flip a zone to `all-types`
 *  AFTER its migration runs to canonical-6, and the chokepoint immediately
 *  refuses regressive writes. No code change required — just a CLAUDE.md
 *  edit and a watcher-driven governance re-scan. */
/** projects-graph ADR-006 — validate that every wikilink TARGET in the
 *  zone's `allowedRelationshipFields` resolves to an existing note.
 *  Today's chokepoint only checks wikilink FORMAT (`^\[\[.+\]\]$`);
 *  this check additionally REFUSES when the target slug doesn't resolve.
 *
 *  - Accepts both shapes per ADR-006 — bare wikilink string OR rich-form
 *    object (`{target, destination?, falsifier?, falsifier_date?}`). For
 *    rich-form, the target field carries the wikilink.
 *  - Empty / absent fields skip silently — relationship fields are
 *    optional. Same goes for items lacking a `.target` (the rich form
 *    can also be a pure external destination — `target?: string`).
 *  - link-validator.ts is UNCHANGED — its scope is BODY wikilinks
 *    (3 rules per ADR-047). Frontmatter relationship-field targets ride
 *    the governance path. See ADR-006 § Assumption cleared #2 for the
 *    extension-point rationale.
 *
 *  Returns null on pass; a refusal message on the first miss. */
function validateRelationshipFields(
	meta: VaultMeta,
	zone: VaultZone,
	sourcePath: string,
	resolveLink: (raw: string, src: string) => string | null,
	hasNote: (path: string) => boolean,
): string | null {
	if (zone.allowedRelationshipFields.length === 0) return null;
	for (const field of zone.allowedRelationshipFields) {
		if (!(field in meta)) continue;
		const value = meta[field];
		const items: unknown[] = Array.isArray(value) ? value : [value];
		for (const item of items) {
			if (item === null || item === undefined || item === '') continue;
			// Rich-form object: pull `.target`. No target = pure-external
			// edge (allowed by ADR-006 § Negative consequences) — skip.
			let raw: string;
			if (typeof item === 'string') {
				raw = item.trim();
			} else if (typeof item === 'object' && item !== null && 'target' in item) {
				const target = (item as { target?: unknown }).target;
				if (typeof target !== 'string' || target.trim() === '') continue;
				raw = target.trim();
			} else {
				continue;
			}
			// Parse wikilink: extract the TARGET (group 1) — same regex
			// shape used in parser.ts WIKILINK_RE. The resolver expects
			// the inner content (`social-media-launch`), NOT the wrapped
			// form (`[[social-media-launch|alias]]`).
			const m = /^\[\[([^\]|#^]+?)(?:#[^\]|]+?)?(?:\^[^\]|]+?)?(?:\|[^\]]+?)?\]\]$/.exec(raw);
			if (!m) {
				return `Relationship field "${field}" must be wikilink format [[slug]] (got: ${raw.length > 60 ? raw.slice(0, 57) + '…' : raw})`;
			}
			const target = m[1].trim();
			// Resolve the wikilink target; null = doesn't resolve to any
			// known note. `'external'` would mean URL/asset embed, which
			// is meaningless for a project relationship — refuse it too.
			const resolved = resolveLink(target, sourcePath);
			if (resolved === 'external') {
				return `Relationship field "${field}" cannot point to external URL/asset: ${raw}.`;
			}
			// Project-index fallback. The resolver's bare-basename tier
			// only finds files literally named `<slug>.md`; project root
			// `index.md` notes are addressed by folder name in
			// relationship-field convention (`parent_project: "[[soul-hub]]"`
			// or `produces_for: ["[[social-media-launch|x]]"]`). Honor that
			// convention here without changing the global resolver — try
			// `projects/<bare-slug>/index.md` before declaring failure.
			let finalPath: string | null =
				typeof resolved === 'string' ? resolved : null;
			if (finalPath === null && !target.includes('/')) {
				const projectIndex = `projects/${target.replace(/\.md$/i, '')}/index.md`;
				if (hasNote(projectIndex)) finalPath = projectIndex;
			}
			if (finalPath === null) {
				return `Relationship field "${field}" target does not resolve: ${raw}. Create the target project first OR fix the slug.`;
			}
			if (!hasNote(finalPath)) {
				return `Relationship field "${field}" target resolved but missing: ${raw} → ${finalPath}.`;
			}
		}
	}
	return null;
}

function validateStatusScope(meta: VaultMeta, zone: VaultZone): string | null {
	if (zone.allowedStatuses.length === 0) return null;
	const raw = meta.status;
	if (raw === undefined || raw === null || raw === '') return null;
	const scopeMatches =
		zone.allowedStatusesScope === 'all-types' ||
		meta.type === 'decision';
	if (!scopeMatches) return null;
	const value = String(raw).toLowerCase();
	if (!zone.allowedStatuses.includes(value)) {
		return `status "${raw}" not in canonical set (allowed: ${zone.allowedStatuses.join(', ')})`;
	}
	return null;
}

export class VaultEngine {
	private indexer: VaultIndexer;
	private searcher: VaultSearch;
	private graph: VaultGraph;
	private watcher: VaultWatcher;
	private governance: GovernanceResolver;
	private templates: TemplateLoader;
	private committer: VaultCommitter;
	private config: VaultConfig;
	private pruneInterval: ReturnType<typeof setInterval> | null = null;
	private writeLog: WriteLogEntry[] = [];
	private static readonly MAX_LOG_ENTRIES = 500;
	private agentWriteCounts = new Map<string, { count: number; windowStart: number }>();
	private static readonly RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
	/** Default per-agent ceiling. Bursty human-driven agents (whatsapp-brain
	 *  in particular — a person typing `/save` rapidly in a chat) override
	 *  this via `RATE_LIMIT_OVERRIDES` so they don't trip the limiter on
	 *  ordinary use. Background agents stay at the conservative default. */
	private static readonly RATE_LIMIT_MAX_WRITES = 50;
	private static readonly RATE_LIMIT_OVERRIDES: Record<string, number> = {
		// Slice 0 risk-table entry: human typing in WhatsApp is bursty —
		// 50/hr cuts off a power user mid-sentence. 200/hr leaves headroom
		// without removing the floor entirely.
		'whatsapp-brain': 200,
		// L3 S4 inbox auto-route worker. perTickCap=10 with a 60s tick
		// gives a natural design ceiling of 600/hr; we set the limiter
		// halfway down so a first-time replay batch (88 candidates over
		// 9 ticks) clears without tripping, but a runaway loop still
		// trips. Background-only — only the worker writes under this ID.
		'inbox-auto-route': 200,
		// projects-graph ADR-002 — one-shot status canonical-6 migration.
		// ~192 notes touched in projects/ + knowledge/. Cap at 1000/hr so
		// the whole run finishes in a single window without burning a
		// 4-hour wall-clock against the default 50/hr limiter. Remove the
		// override after the migration completes (single executor; the
		// agent name is not reused for ongoing operations).
		'status-migration': 1000,
	};

	private static rateLimitFor(agent: string): number {
		return VaultEngine.RATE_LIMIT_OVERRIDES[agent] ?? VaultEngine.RATE_LIMIT_MAX_WRITES;
	}

	constructor(config: VaultConfig) {
		this.config = config;
		this.indexer = new VaultIndexer(config.rootDir);
		this.searcher = new VaultSearch();
		this.graph = new VaultGraph();
		this.watcher = new VaultWatcher();
		this.governance = new GovernanceResolver();
		this.templates = new TemplateLoader();
		this.committer = new VaultCommitter(config.rootDir);
	}

	/** Absolute path to the vault root directory — exposed for renderer/media link resolution. */
	get vaultDir(): string {
		return this.config.rootDir;
	}

	async init(): Promise<void> {
		await this.governance.scan(this.config.rootDir);
		await this.templates.load(this.config.templateDir);
		await this.indexer.scan();
		this.searcher.rebuild(this.indexer.all());

		this.watcher.start(this.config.rootDir, async (event) => {
			if (event.type === 'governance-change') {
				// CLAUDE.md edit/create/delete: re-parse all zone configs so
				// allowedTypes/requiredFields/namingPattern etc. reflect the
				// new schema immediately (no PM2 reload required). Note: the
				// existing note index doesn't change — only the validation
				// rules applied to subsequent governance checks.
				await this.governance.scan(this.config.rootDir);
			} else if (event.type === 'add' || event.type === 'change') {
				await this.indexer.reindex(event.path);
				const note = this.indexer.get(event.path);
				if (note) this.searcher.upsert(note);
			} else if (event.type === 'unlink') {
				this.indexer.remove(event.path);
				this.searcher.remove(event.path);
			}
			emitReindex({ reason: 'watcher', path: event.path });
		});

		// Prune ephemeral zones on startup, then every 24 hours
		const runPrune = async () => {
			await this.pruneZone('sessions', 7).catch(() => {});
			await this.pruneZone('operations', 7, 'session-log').catch(() => {});
			await this.archiveOldNotes('inbox', 30).catch(() => {});
			await this.pruneZone('archive', 90).catch(() => {});
		};
		runPrune();
		this.pruneInterval = setInterval(runPrune, 24 * 60 * 60 * 1000);

		console.log(`[vault] Initialized: ${this.indexer.all().length} notes indexed`);
	}

	shutdown(): void {
		this.watcher.stop();
		if (this.pruneInterval) clearInterval(this.pruneInterval);
	}

	// ── Read Operations ──

	/** All indexed notes. Used by hygiene scanners that need to walk the
	 *  full vault (orphan-style detectors, misplacement detector). For
	 *  search use `getNotes(query)` instead. */
	getAllNotes(): VaultNote[] {
		return this.indexer.all();
	}

	getNote(path: string): VaultNote | undefined {
		return this.indexer.get(path);
	}

	/** Thin pass-through to the indexer's wikilink resolver. Reuses the
	 *  same alias / sibling / cross-project rules the parser uses when
	 *  computing `VaultNote.links[*].resolved`. Returns the vault-relative
	 *  target path on hit or `null` on miss. */
	resolveLink(raw: string, sourcePath: string): string | null {
		return this.indexer.resolveLink(raw, sourcePath);
	}

	getNotes(query: SearchQuery): SearchResult[] {
		return this.searcher.search(query);
	}

	getGraph(opts?: { zone?: string; project?: string }): GraphData {
		const notes = opts ? this.indexer.filter(opts) : this.indexer.all();
		return this.graph.build(notes);
	}

	getLocalGraph(path: string, depth?: number): GraphData {
		return this.graph.local(this.indexer.all(), path, depth);
	}

	getBacklinks(path: string): VaultNote[] {
		const note = this.indexer.get(path);
		if (!note) return [];
		return note.backlinks
			.map((bl) => this.indexer.get(bl))
			.filter((n): n is VaultNote => n !== undefined);
	}

	getTags(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const note of this.indexer.all()) {
			for (const tag of note.meta.tags ?? []) {
				counts[tag] = (counts[tag] || 0) + 1;
			}
		}
		return counts;
	}

	getRecent(limit = 20): VaultNote[] {
		return this.indexer
			.all()
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, limit);
	}

	getOrphans(): VaultNote[] {
		return this.indexer
			.all()
			.filter((n) => n.links.length === 0 && n.backlinks.length === 0);
	}

	getUnresolved(): { source: string; raw: string }[] {
		const results: { source: string; raw: string }[] = [];
		for (const note of this.indexer.all()) {
			for (const link of note.links) {
				if (link.resolved === null) {
					results.push({ source: note.path, raw: link.raw });
				}
			}
		}
		return results;
	}

	getStats(): VaultStats {
		return this.indexer.stats();
	}

	getHealth(): VaultHealth {
		return this.indexer.health();
	}

	getGovernanceViolations(): { path: string; violations: string[] }[] {
		const results: { path: string; violations: string[] }[] = [];
		for (const note of this.indexer.all()) {
			const violations: string[] = [];
			const zone = this.governance.resolve(note.path.split('/').slice(0, -1).join('/'));

			// Check type allowed
			if (zone.allowedTypes.length > 0 && note.meta.type && !zone.allowedTypes.includes(note.meta.type)) {
				violations.push(`Type "${note.meta.type}" not allowed (allowed: ${zone.allowedTypes.join(', ')})`);
			}

			// Check required fields
			for (const field of zone.requiredFields) {
				if (!(field in note.meta) || note.meta[field] === undefined || note.meta[field] === '') {
					violations.push(`Missing required field: ${field}`);
				}
			}

			// projects-graph ADR-001 — project_shape hygiene flag on project
			// root index.md. Day 1 cutover: missing values escalate via the
			// keeper digest (no chokepoint REFUSE yet). Non-enum values are
			// caught here too (defence in depth — the chokepoint refuses on
			// write, but a pre-ADR file written before this rule shipped will
			// only surface via the hygiene scan).
			if (isProjectRootIndex(note.path) && zone.allowedProjectShapes.length > 0) {
				const raw: unknown = note.meta.project_shape;
				if (raw === undefined || raw === null || raw === '') {
					violations.push(
						`Missing project_shape (projects-graph ADR-001 — allowed: ${zone.allowedProjectShapes.join(', ')})`,
					);
				} else {
					const value = String(raw).toLowerCase();
					if (!zone.allowedProjectShapes.includes(value)) {
						violations.push(
							`project_shape "${raw}" not in canonical set (allowed: ${zone.allowedProjectShapes.join(', ')})`,
						);
					}
				}
			}

			// Canonical status check. Scope sentinel decides which note types
			// participate (projects-graph ADR-002):
			//   - 'decisions-only' (default): only `type: decision` notes
			//   - 'all-types': every note with a `status:` field
			// Empty allowedStatuses = no rule for this zone (skip entirely).
			if (
				zone.allowedStatuses.length > 0 &&
				note.meta.status !== undefined &&
				note.meta.status !== null &&
				note.meta.status !== ''
			) {
				const scopeMatches =
					zone.allowedStatusesScope === 'all-types' ||
					note.meta.type === 'decision';
				if (scopeMatches) {
					const status = String(note.meta.status).toLowerCase();
					if (!zone.allowedStatuses.includes(status)) {
						violations.push(
							`Status "${note.meta.status}" not in canonical set (allowed: ${zone.allowedStatuses.join(', ')})`,
						);
					}
				}
			}

			// Relationship field format check. For any allowed relationship
			// field that's present on the note, every value must be wikilink
			// format `[[slug]]` — string OR rich-form object (ADR-006:
			// `produces_for[]` may be `{target, destination?, falsifier?,
			// falsifier_date?}`; the wikilink target rides on `.target`).
			if (zone.allowedRelationshipFields.length > 0) {
				for (const field of zone.allowedRelationshipFields) {
					if (!(field in note.meta)) continue;
					const value = note.meta[field];
					const items: unknown[] = Array.isArray(value) ? value : [value];
					for (const item of items) {
						if (item === null || item === undefined || item === '') continue;
						let raw: string;
						if (typeof item === 'string') {
							raw = item.trim();
						} else if (typeof item === 'object' && item !== null && 'target' in item) {
							const t = (item as { target?: unknown }).target;
							if (typeof t !== 'string' || t.trim() === '') continue;
							raw = t.trim();
						} else {
							continue;
						}
						if (!/^\[\[.+\]\]$/.test(raw)) {
							violations.push(
								`Relationship field "${field}" must be wikilink format [[slug]] (got: ${truncate(raw, 60)})`,
							);
							break; // one message per field is enough
						}
					}
				}
			}

			// ADR-039 R3 — scope discipline. Flag oversized ADRs so the
			// operator can decide whether to split the next phase into a
			// new ADR (via `extends:`). Soft warning, not a block.
			//
			// Recalibrated 2026-05-22 (soul-hub-governance health review):
			//   1. Dropped the `> 5 shipped markers` trigger — a many-phased
			//      ADR is a *healthy completed* decision, not scope creep. Size
			//      is the only meaningful scope signal; markers false-flagged
			//      well-run multi-phase ADRs (e.g. heartbeat adr-001).
			//   2. Bumped the grandfather cutoff to 2026-05-23 so every ADR that
			//      already exists is grandfathered (splitting historical ADRs is
			//      busywork); only NEW oversized ADRs are flagged going forward.
			if (note.meta.type === 'decision') {
				const createdRaw = note.meta.created;
				const created = createdRaw ? new Date(String(createdRaw)) : null;
				const grandfathered =
					created !== null &&
					!Number.isNaN(created.getTime()) &&
					created.getTime() < Date.UTC(2026, 4, 23);
				if (!grandfathered) {
					const bodyBytes = Buffer.byteLength(note.content, 'utf8');
					if (bodyBytes > 15000) {
						violations.push(
							`ADR scope (ADR-039): body ${bodyBytes} bytes — consider splitting the next phase into a new ADR with \`extends:\``,
						);
					}
				}
			}

			if (violations.length > 0) {
				results.push({ path: note.path, violations });
			}
		}

		// Check for orphan notes (no incoming or outgoing links) — skip inbox and archive
		const orphanExemptZones = ['inbox', 'archive'];
		for (const note of this.indexer.all()) {
			const zone = note.path.split('/')[0];
			if (orphanExemptZones.includes(zone)) continue;
			if (note.links.length === 0 && note.backlinks.length === 0) {
				const existing = results.find(r => r.path === note.path);
				if (existing) {
					existing.violations.push('No wikilinks (orphan note — add at least one [[link]])');
				} else {
					results.push({ path: note.path, violations: ['No wikilinks (orphan note — add at least one [[link]])'] });
				}
			}
		}

		return results;
	}

	getZones(): VaultZone[] {
		return this.governance.getZones();
	}

	/** Resolve governance for a single zone path — walks parent hierarchy, falls back
	 * to the empty default if nothing matches. Exposed so callers can validate a
	 * proposed write *before* constructing it (used by Katib's --strict-governance).
	 */
	resolveZone(zonePath: string): VaultZone {
		return this.governance.resolve(zonePath);
	}

	getTemplates(): VaultTemplate[] {
		return this.templates.list();
	}

	async saveTemplate(name: string, raw: string): Promise<VaultTemplate> {
		return this.templates.save(name, raw);
	}

	async deleteTemplate(name: string): Promise<boolean> {
		return this.templates.remove(name);
	}

	// ── Write Audit Log ──

	private logWrite(entry: Omit<WriteLogEntry, 'timestamp'>): void {
		this.writeLog.unshift({ ...entry, timestamp: new Date().toISOString() });
		if (this.writeLog.length > VaultEngine.MAX_LOG_ENTRIES) {
			this.writeLog.length = VaultEngine.MAX_LOG_ENTRIES;
		}
	}

	getWriteLog(opts?: { agent?: string; zone?: string; limit?: number }): WriteLogEntry[] {
		let log = this.writeLog;
		if (opts?.agent) log = log.filter(e => e.agent === opts.agent);
		if (opts?.zone) log = log.filter(e => e.zone === opts.zone);
		return log.slice(0, opts?.limit ?? 50);
	}

	private checkRateLimit(agent: string): { allowed: boolean; remaining: number; resetAt: string; ceiling: number } {
		const now = Date.now();
		const entry = this.agentWriteCounts.get(agent);
		const ceiling = VaultEngine.rateLimitFor(agent);

		if (!entry || (now - entry.windowStart) > VaultEngine.RATE_LIMIT_WINDOW_MS) {
			this.agentWriteCounts.set(agent, { count: 1, windowStart: now });
			return { allowed: true, remaining: ceiling - 1, resetAt: new Date(now + VaultEngine.RATE_LIMIT_WINDOW_MS).toISOString(), ceiling };
		}

		if (entry.count >= ceiling) {
			const resetAt = new Date(entry.windowStart + VaultEngine.RATE_LIMIT_WINDOW_MS).toISOString();
			return { allowed: false, remaining: 0, resetAt, ceiling };
		}

		entry.count++;
		return { allowed: true, remaining: ceiling - entry.count, resetAt: new Date(entry.windowStart + VaultEngine.RATE_LIMIT_WINDOW_MS).toISOString(), ceiling };
	}

	private checkDuplicate(zone: string, content: string, title: string): { isDuplicate: boolean; similarPath?: string } {
		const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
		const normalizedContent = normalize(content);
		const normalizedTitle = normalize(title);

		const zoneNotes = this.indexer.filter({ zone: zone.split('/')[0] });

		for (const note of zoneNotes) {
			if (normalize(note.title) === normalizedTitle) {
				return { isDuplicate: true, similarPath: note.path };
			}

			const existingNorm = normalize(note.content.slice(0, 500));
			const newNorm = normalizedContent.slice(0, 500);

			if (existingNorm.length > 50 && newNorm.length > 50) {
				const existingWords = new Set(existingNorm.split(' '));
				const newWords = new Set(newNorm.split(' '));
				const intersection = [...newWords].filter(w => existingWords.has(w)).length;
				const union = new Set([...existingWords, ...newWords]).size;
				const similarity = union > 0 ? intersection / union : 0;

				if (similarity > 0.9) {
					return { isDuplicate: true, similarPath: note.path };
				}
			}
		}

		return { isDuplicate: false };
	}

	// ── Write Operations ──

	async createNote(
		req: CreateNoteRequest,
		opts?: CreateNoteOpts,
	): Promise<WriteResult | WriteError> {
		// Validate global required fields
		for (const field of GLOBAL_REQUIRED_FIELDS) {
			if (!(field in req.meta) || req.meta[field] === undefined || req.meta[field] === '') {
				return { success: false, error: `Missing required field: ${field}`, field };
			}
		}

		// ADR-005 S0 — prefer the per-call actor over the new note's
		// `meta.source_agent` when stamping audit log + git commit, so
		// server-side tools (proposeAdr, proposeSlice, suggestAdrEdit,
		// recipe steps) leave a traceable footprint distinct from the
		// note's declared author. Mirror of the updateNote pattern from
		// ADR-003 S4. When omitted, falls back to meta.source_agent —
		// existing callers stay correct without changes.
		const auditAgent = opts?.actor ?? (req.meta.source_agent as string | undefined);
		const auditContext =
			opts?.actorContext ?? (req.meta.source_context as string | undefined);

		// Validate against zone governance
		const zone = this.governance.resolve(req.zone);
		if (zone.allowedTypes.length > 0 && req.meta.type && !zone.allowedTypes.includes(req.meta.type)) {
			return { success: false, error: `Type "${req.meta.type}" not allowed in zone "${req.zone}". Allowed: ${zone.allowedTypes.join(', ')}` };
		}
		for (const field of zone.requiredFields) {
			if (!(field in req.meta) || req.meta[field] === undefined || req.meta[field] === '') {
				return { success: false, error: `Zone "${req.zone}" requires field: ${field}`, field };
			}
		}

		// projects-graph ADR-001 — project_shape enum check on the project
		// root index.md. Day 8+ cutover (flipped 2026-05-19): refuse missing
		// AND non-enum values on CREATE. Update path stays permissive.
		const createShapeErr = validateProjectShape(join(req.zone, req.filename), req.meta, zone, 'create');
		if (createShapeErr) {
			return { success: false, error: createShapeErr, field: 'project_shape' };
		}

		// projects-graph ADR-002 — canonical-set status enforcement. Scope
		// sentinel (`allowedStatusesScope`) decides whether this fires for
		// every note or only `type: decision`. Operators flip a zone to
		// `all-types` in CLAUDE.md after migration completes.
		const createStatusErr = validateStatusScope(req.meta, zone);
		if (createStatusErr) {
			return { success: false, error: createStatusErr, field: 'status' };
		}

		// projects-graph ADR-006 — relationship-field wikilink resolution.
		// Today's L347 hygiene reporter only checks format; this REFUSES
		// at write-time when the target slug doesn't resolve. Closes
		// ADR-006 F5 (refuse `produces_for: ['[[nonexistent-slug]]']`).
		const createRelErr = validateRelationshipFields(
			req.meta,
			zone,
			join(req.zone, req.filename),
			(raw, src) => this.indexer.resolveLink(raw, src),
			(p) => this.indexer.hasNote(p),
		);
		if (createRelErr) {
			return { success: false, error: createRelErr };
		}

		// Validate naming pattern
		if (zone.namingPattern) {
			const re = new RegExp(zone.namingPattern);
			if (!re.test(req.filename)) {
				return { success: false, error: `Filename "${req.filename}" doesn't match zone naming pattern: ${zone.namingPattern}` };
			}
		}

		// Validate against template if required
		if (zone.requireTemplate && req.meta.type) {
			const validation = this.templates.validate(req.meta.type, req.content, true);
			if (!validation.valid) {
				return { success: false, error: `Missing template sections: ${validation.missing.join(', ')}` };
			}
		}

		// Validate file size
		// Auto-tag agent-generated notes
		if (req.meta.source_agent && !req.meta.tags?.includes('auto-generated')) {
			req.meta.tags = [...(req.meta.tags ?? []), 'auto-generated'];
		}

		// Rate limit agent writes. Gate keyed on meta.source_agent (the
		// underlying author identity — rate limits should apply to the
		// declared agent regardless of which TOOL triggered the call),
		// but audit-log entry uses auditAgent so the trace shows the
		// actor when one is supplied.
		if (req.meta.source_agent) {
			const rateCheck = this.checkRateLimit(req.meta.source_agent);
			if (!rateCheck.allowed) {
				this.logWrite({
					action: 'create',
					path: join(req.zone, req.filename),
					agent: auditAgent,
					context: auditContext,
					zone: req.zone.split('/')[0],
					type: req.meta.type as string | undefined,
					success: false,
					error: `Rate limit exceeded (${rateCheck.ceiling}/hour). Resets at ${rateCheck.resetAt}`,
				});
				return { success: false, error: `Rate limit exceeded for agent "${req.meta.source_agent}". Max ${rateCheck.ceiling} writes per hour. Resets at ${rateCheck.resetAt}` };
			}
		}

		// Content dedup check (agent writes only). Same gate semantics as
		// rate-limit — keyed on source_agent, but the audit-log entry
		// uses auditAgent for actor traceability.
		if (req.meta.source_agent) {
			const titleFromContent = req.content.split('\n').find(l => l.startsWith('# '))?.replace('# ', '') || req.filename.replace('.md', '');
			const dupCheck = this.checkDuplicate(req.zone, req.content, titleFromContent);
			if (dupCheck.isDuplicate) {
				this.logWrite({
					action: 'create',
					path: join(req.zone, req.filename),
					agent: auditAgent,
					context: auditContext,
					zone: req.zone.split('/')[0],
					type: req.meta.type as string | undefined,
					success: false,
					error: `Duplicate content detected (similar to ${dupCheck.similarPath})`,
				});
				return { success: false, error: `Duplicate content detected. Similar note exists at: ${dupCheck.similarPath}` };
			}
		}

		// ADR-047 — wikilink validation. Runs before stringify so refusals
		// don't pay the serialization cost. REFUSE on auto-memory and
		// bare-project-slug; WARN (auto-tag `has-link-warnings`) on
		// unresolved targets unless `meta.strict_links === true`.
		const relPath = join(req.zone, req.filename);
		let linkResult = validateLinks(req.content, {
			sourcePath: relPath,
			strict: req.meta.strict_links === true,
			hasNote: (p) => this.indexer.hasNote(p),
			resolver: { resolve: (raw, src) => this.indexer.resolveLink(raw, src ?? relPath) },
		});
		if (linkResult.errors.length > 0) {
			const first = linkResult.errors[0];
			return {
				success: false,
				error: `Wikilink validation failed: ${first.suggestion}`,
				field: 'content',
				linkErrors: linkResult.errors,
			};
		}

		// ADR-049 — opt-in stub scaffolding for legitimate index-then-children
		// workflows. When set, every `unresolved-target` warning becomes an
		// empty stub note so the index ships internally consistent and the
		// hygiene dashboard stops surfacing forward refs as warnings.
		let stubsCreated: StubInfo[] = [];
		if (linkResult.warnings.length > 0 && req.meta.scaffold_stubs === true) {
			stubsCreated = await this.scaffoldStubsForWarnings(
				linkResult.warnings,
				relPath,
				req.meta,
			);
			if (stubsCreated.length > 0) {
				// Re-validate now that stubs exist — warnings should clear.
				linkResult = validateLinks(req.content, {
					sourcePath: relPath,
					strict: req.meta.strict_links === true,
					hasNote: (p) => this.indexer.hasNote(p),
					resolver: { resolve: (raw, src) => this.indexer.resolveLink(raw, src ?? relPath) },
				});
			}
		}

		if (linkResult.warnings.length > 0) {
			const tags = Array.isArray(req.meta.tags) ? [...req.meta.tags] : [];
			if (!tags.includes('has-link-warnings')) tags.push('has-link-warnings');
			req.meta.tags = tags;
		}

		const content = matter.stringify(req.content, req.meta);
		if (Buffer.byteLength(content) > MAX_NOTE_SIZE) {
			return { success: false, error: `Note exceeds maximum size of ${MAX_NOTE_SIZE} bytes` };
		}

		const absPath = resolve(this.config.rootDir, relPath);

		// Check file doesn't already exist
		try {
			await stat(absPath);
			return { success: false, error: `File already exists: ${relPath}` };
		} catch {
			// good — file doesn't exist
		}

		// Suppress watcher for this path (we'll reindex explicitly)
		this.watcher.suppress(relPath);

		// Atomic write: write to tmp, then rename
		try {
			await mkdir(dirname(absPath), { recursive: true });
			const tmpPath = absPath + '.tmp';
			await writeFile(tmpPath, content, 'utf-8');
			await rename(tmpPath, absPath);
		} catch (err) {
			this.logWrite({
				action: 'create',
				path: relPath,
				agent: auditAgent,
				context: auditContext,
				zone: req.zone.split('/')[0],
				type: req.meta.type as string | undefined,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return { success: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		await this.indexer.reindex(relPath);
		const note = this.indexer.get(relPath);
		if (note) this.searcher.upsert(note);

		this.logWrite({
			action: 'create',
			path: relPath,
			agent: auditAgent,
			context: auditContext,
			zone: req.zone.split('/')[0],
			type: req.meta.type as string | undefined,
			success: true,
		});

		this.committer.enqueue({
			action: 'create',
			path: relPath,
			zone: req.zone.split('/')[0],
			type: req.meta.type as string | undefined,
			agent: auditAgent,
			context: auditContext,
		});

		const result: WriteResult = { success: true, path: relPath };
		if (linkResult.warnings.length > 0) result.warnings = linkResult.warnings;
		if (stubsCreated.length > 0) result.stubs_created = stubsCreated;
		return result;
	}

	/** Slice 0 — write a binary asset (image, voice, video, document) into
	 *  a vault zone. Mirrors `createNote` discipline (zone resolution, rate
	 *  limit, atomic write, write-log entry) but skips the markdown-only
	 *  steps (frontmatter, template, dedup). Path traversal is blocked by
	 *  asserting the resolved absolute path stays inside `rootDir`. */
	async writeAsset(req: WriteAssetRequest): Promise<WriteResult | WriteError> {
		// Filename hygiene — no slashes, no leading dots, has an extension.
		// (Subdirectories are expressed via `zone`, not embedded in filename.)
		if (!req.filename || req.filename.includes('/') || req.filename.includes('\\')) {
			return { success: false, error: 'Filename must not contain path separators.' };
		}
		if (req.filename.startsWith('.')) {
			return { success: false, error: 'Filename must not start with a dot.' };
		}
		if (!/\.[A-Za-z0-9]+$/.test(req.filename)) {
			return { success: false, error: 'Filename must have an extension.' };
		}

		// Size cap — keeps WhatsApp media + general user uploads safe.
		if (req.buffer.byteLength === 0) {
			return { success: false, error: 'Asset buffer is empty.' };
		}
		if (req.buffer.byteLength > MAX_ASSET_SIZE) {
			return {
				success: false,
				error: `Asset exceeds maximum size of ${MAX_ASSET_SIZE} bytes (was ${req.buffer.byteLength}).`,
			};
		}

		// Rate limit agent writes (binaries count too — vision/voice ops
		// can fan out fast).
		if (req.agent) {
			const rateCheck = this.checkRateLimit(req.agent);
			if (!rateCheck.allowed) {
				this.logWrite({
					action: 'create-asset',
					path: join(req.zone, req.filename),
					agent: req.agent,
					context: req.context,
					zone: req.zone.split('/')[0],
					success: false,
					error: `Rate limit exceeded (${rateCheck.ceiling}/hour). Resets at ${rateCheck.resetAt}`,
				});
				return {
					success: false,
					error: `Rate limit exceeded for agent "${req.agent}". Max ${rateCheck.ceiling} writes per hour. Resets at ${rateCheck.resetAt}`,
				};
			}
		}

		const relPath = join(req.zone, req.filename);
		const absPath = resolve(this.config.rootDir, relPath);

		// Path traversal guard — `join('inbox', '../../etc')` resolves above
		// rootDir, so we explicitly assert the absolute path stays inside.
		// `+ sep` on rootDir prevents a sibling directory from passing
		// (`/vault-evil` shouldn't match `startsWith('/vault')`).
		const rootWithSep = this.config.rootDir.endsWith('/')
			? this.config.rootDir
			: this.config.rootDir + '/';
		if (!absPath.startsWith(rootWithSep)) {
			return { success: false, error: 'Resolved path escapes the vault root.' };
		}

		// File existence check — never overwrite an existing asset (callers
		// should disambiguate with a date+slug filename).
		try {
			await stat(absPath);
			return { success: false, error: `Asset already exists: ${relPath}` };
		} catch {
			// good — file doesn't exist
		}

		// Atomic write: tmp + rename. No watcher reindex (binaries aren't
		// in the note index — they're referenced from notes' frontmatter).
		try {
			await mkdir(dirname(absPath), { recursive: true });
			const tmpPath = absPath + '.tmp';
			await writeFile(tmpPath, req.buffer);
			await rename(tmpPath, absPath);
		} catch (err) {
			this.logWrite({
				action: 'create-asset',
				path: relPath,
				agent: req.agent,
				context: req.context,
				zone: req.zone.split('/')[0],
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				success: false,
				error: `Asset write failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		this.logWrite({
			action: 'create-asset',
			path: relPath,
			agent: req.agent,
			context: req.context,
			zone: req.zone.split('/')[0],
			type: req.mimetype,
			success: true,
		});

		this.committer.enqueue({
			action: 'create-asset',
			path: relPath,
			zone: req.zone.split('/')[0],
			type: req.mimetype,
			agent: req.agent,
			context: req.context,
		});

		// Binary assets carry no wikilinks, so there is no link-validation
		// result to surface here. The `linkResult` reference was a copy-paste
		// leftover from createNote — it is undefined in writeAsset and would
		// throw ReferenceError if this path returned with it.
		return { success: true, path: relPath };
	}

	async updateNote(
		path: string,
		req: UpdateNoteRequest,
		opts?: UpdateNoteOpts,
	): Promise<WriteResult | WriteError> {
		const existing = this.indexer.get(path);
		if (!existing) {
			return { success: false, error: `Note not found: ${path}` };
		}

		// ADR-003 S4 — prefer the per-call actor over the note's original
		// `source_agent` when stamping audit log + git commit, so server-side
		// tools (projectShipSlice, recipe steps) leave a traceable footprint
		// distinct from the note's author.
		const auditAgent = opts?.actor ?? (existing.meta.source_agent as string | undefined);
		const auditContext =
			opts?.actorContext ?? (existing.meta.source_context as string | undefined);

		const mergedMeta = { ...existing.meta, ...(req.meta ?? {}) };
		const newContent = req.content ?? existing.content;

		// Re-validate
		for (const field of GLOBAL_REQUIRED_FIELDS) {
			if (!(field in mergedMeta) || mergedMeta[field] === undefined || mergedMeta[field] === '') {
				return { success: false, error: `Missing required field: ${field}`, field };
			}
		}

		// projects-graph ADR-001 — project_shape enum check on update too.
		// Validates against the post-merge meta; a caller sending only `content`
		// inherits the existing meta and passes through unchanged.
		const updateZone = this.governance.resolve(dirname(path));
		const updateShapeErr = validateProjectShape(path, mergedMeta, updateZone);
		if (updateShapeErr) {
			return { success: false, error: updateShapeErr, field: 'project_shape' };
		}

		// projects-graph ADR-002 — canonical-set status check on update too.
		// Post-merge meta means a caller sending only content inherits the
		// existing status: a legacy note with `status: active` is not touched
		// by a body-only update if the zone is still 'decisions-only' OR the
		// note isn't a decision. Once the zone flips to 'all-types', a
		// body-only update on a legacy non-canonical note WILL refuse —
		// forcing a one-time migration of any straggler before further edits.
		const updateStatusErr = validateStatusScope(mergedMeta, updateZone);
		if (updateStatusErr) {
			return { success: false, error: updateStatusErr, field: 'status' };
		}

		// projects-graph ADR-006 — relationship-field wikilink resolution
		// on update too. Catches the case where someone updates a project's
		// `produces_for` to point at a slug that was later deleted, or
		// adds a typo via PUT.
		const updateRelErr = validateRelationshipFields(
			mergedMeta,
			updateZone,
			path,
			(raw, src) => this.indexer.resolveLink(raw, src),
			(p) => this.indexer.hasNote(p),
		);
		if (updateRelErr) {
			return { success: false, error: updateRelErr };
		}

		// ADR-047 — same wikilink validation as createNote. Always re-validates
		// against the post-merge body, even when the caller only sent meta —
		// frontmatter changes (aliases, strict_links) can shift link semantics.
		let linkResult = validateLinks(newContent, {
			sourcePath: path,
			strict: mergedMeta.strict_links === true,
			hasNote: (p) => this.indexer.hasNote(p),
			resolver: { resolve: (raw, src) => this.indexer.resolveLink(raw, src ?? path) },
		});
		if (linkResult.errors.length > 0) {
			const first = linkResult.errors[0];
			return {
				success: false,
				error: `Wikilink validation failed: ${first.suggestion}`,
				field: 'content',
				linkErrors: linkResult.errors,
			};
		}

		// ADR-049 — opt-in stub scaffolding on update too. Useful when an
		// operator edits an existing index to add new sections of children
		// that don't exist yet. The persisted `scaffold_stubs` flag on the
		// note's frontmatter means subsequent updates honour the same intent
		// without the caller needing to re-set it each time.
		let stubsCreated: StubInfo[] = [];
		if (linkResult.warnings.length > 0 && mergedMeta.scaffold_stubs === true) {
			stubsCreated = await this.scaffoldStubsForWarnings(
				linkResult.warnings,
				path,
				mergedMeta,
			);
			if (stubsCreated.length > 0) {
				linkResult = validateLinks(newContent, {
					sourcePath: path,
					strict: mergedMeta.strict_links === true,
					hasNote: (p) => this.indexer.hasNote(p),
					resolver: { resolve: (raw, src) => this.indexer.resolveLink(raw, src ?? path) },
				});
			}
		}

		if (linkResult.warnings.length > 0) {
			const tags = Array.isArray(mergedMeta.tags) ? [...mergedMeta.tags] : [];
			if (!tags.includes('has-link-warnings')) tags.push('has-link-warnings');
			mergedMeta.tags = tags;
		} else if (Array.isArray(mergedMeta.tags) && mergedMeta.tags.includes('has-link-warnings')) {
			// Warnings cleared on this update — drop the tag so the hygiene
			// bucket reflects current state.
			mergedMeta.tags = mergedMeta.tags.filter((t: string) => t !== 'has-link-warnings');
		}

		const content = matter.stringify(newContent, mergedMeta);
		if (Buffer.byteLength(content) > MAX_NOTE_SIZE) {
			return { success: false, error: `Note exceeds maximum size of ${MAX_NOTE_SIZE} bytes` };
		}

		this.watcher.suppress(path);

		const absPath = resolve(this.config.rootDir, path);
		try {
			const tmpPath = absPath + '.tmp';
			await writeFile(tmpPath, content, 'utf-8');
			await rename(tmpPath, absPath);
		} catch (err) {
			this.logWrite({
				action: 'update',
				path,
				agent: auditAgent,
				context: auditContext,
				zone: path.split('/')[0],
				type: existing.meta.type as string | undefined,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return { success: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		await this.indexer.reindex(path);
		const note = this.indexer.get(path);
		if (note) this.searcher.upsert(note);

		this.logWrite({
			action: 'update',
			path,
			agent: auditAgent,
			context: auditContext,
			zone: path.split('/')[0],
			type: existing.meta.type as string | undefined,
			success: true,
		});

		this.committer.enqueue({
			action: 'update',
			path,
			zone: path.split('/')[0],
			type: existing.meta.type as string | undefined,
			agent: auditAgent,
			context: auditContext,
		});

		const updateResult: WriteResult = { success: true, path };
		if (linkResult.warnings.length > 0) updateResult.warnings = linkResult.warnings;
		if (stubsCreated.length > 0) updateResult.stubs_created = stubsCreated;
		return updateResult;
	}

	/** Append a wikilink for `notePath` to `<zone>/index.md` under an
	 *  "## Auto-linked" section. No-op cases:
	 *    - Zone index doesn't exist (operator-bootstrapped only — we
	 *      don't auto-create indexes for zones that haven't opted in).
	 *    - Link target already present in the index (idempotent — repeat
	 *      calls during retries don't duplicate the line).
	 *  Used by the inbox L3 S4 auto-route worker (per ADR-044 Phase C)
	 *  so security/ + finance/ notes don't accumulate as orphans the
	 *  moment they land in the vault. The Telegram inline-action Save
	 *  path (saveInboxToVault) is a future caller. */
	async appendToZoneIndex(
		zone: string,
		notePath: string,
		noteTitle: string,
	): Promise<WriteResult | WriteError> {
		const indexPath = `${zone}/index.md`;
		const index = this.indexer.get(indexPath);
		if (!index) {
			return { success: false, error: `Zone index not found: ${indexPath}` };
		}

		const linkTarget = notePath.replace(/\.md$/, '');
		if (index.content.includes(linkTarget)) {
			return { success: true, path: indexPath };
		}

		const bullet = `- [[${linkTarget}|${noteTitle}]]`;
		const SECTION = '## Auto-linked';
		const existingContent = index.content.trimEnd();
		const newContent = existingContent.includes(SECTION)
			? `${existingContent}\n${bullet}\n`
			: `${existingContent}\n\n${SECTION}\n\n${bullet}\n`;

		return this.updateNote(indexPath, { content: newContent });
	}

	async archiveNote(path: string): Promise<WriteResult | WriteError> {
		const existing = this.indexer.get(path);
		if (!existing) {
			return { success: false, error: `Note not found: ${path}` };
		}

		// ADR-012 — defensive guard: refuse to archive paths already under
		// `archive/`. Pre-fix, `archive/foo.md` would map to `archive/foo.md`
		// (collision with itself) or, under the new path-preserving rule,
		// `archive/archive/foo.md` (nonsense). Single-source-of-truth: any
		// archive op must originate from a non-archive zone.
		if (path === 'archive' || path.startsWith('archive/')) {
			return { success: false, error: `Path already in archive zone: ${path}` };
		}

		// ADR-012 — preserve source path under `archive/` so two notes with
		// the same filename in different source paths don't collide.
		// `projects/A/index.md` → `archive/projects/A/index.md`. Mirrors the
		// `moveAssetToArchive` convention earlier in this file.
		const segments = path.split('/').filter(Boolean);
		const archivePath =
			segments.length > 1
				? join('archive', ...segments.slice(1))
				: join('archive', segments[0] ?? path);
		const absSource = resolve(this.config.rootDir, path);
		const absTarget = resolve(this.config.rootDir, archivePath);

		// ADR-012 — `stat()`-before-`rename` collision guard. `rename()` is a
		// clobbering atomic move on the same filesystem; without this check,
		// a second archive op on the same target SILENTLY OVERWRITES. Refuse
		// rather than skip (operator-initiated; loud failure is correct).
		try {
			await stat(absTarget);
			return {
				success: false,
				error: `Archive target already exists: ${archivePath}`,
			};
		} catch {
			// Good — destination is free.
		}

		try {
			await mkdir(dirname(absTarget), { recursive: true });
			await rename(absSource, absTarget);
		} catch (err) {
			this.logWrite({
				action: 'archive',
				path: archivePath,
				previousPath: path,
				agent: existing.meta.source_agent as string | undefined,
				context: existing.meta.source_context as string | undefined,
				zone: 'archive',
				type: existing.meta.type as string | undefined,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return { success: false, error: `Archive failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		this.indexer.remove(path);
		this.searcher.remove(path);
		await this.indexer.reindex(archivePath);
		const note = this.indexer.get(archivePath);
		if (note) this.searcher.upsert(note);

		this.logWrite({
			action: 'archive',
			path: archivePath,
			previousPath: path,
			agent: existing.meta.source_agent as string | undefined,
			context: existing.meta.source_context as string | undefined,
			zone: 'archive',
			type: existing.meta.type as string | undefined,
			success: true,
		});

		this.committer.enqueue({
			action: 'archive',
			path: archivePath,
			previousPath: path,
			zone: 'archive',
			type: existing.meta.type as string | undefined,
			agent: existing.meta.source_agent as string | undefined,
			context: existing.meta.source_context as string | undefined,
		});

		return { success: true, path: archivePath };
	}

	async moveNote(path: string, targetZone: string): Promise<WriteResult | WriteError> {
		const existing = this.indexer.get(path);
		if (!existing) {
			return { success: false, error: `Note not found: ${path}` };
		}

		// Validate against target zone governance
		const zone = this.governance.resolve(targetZone);
		if (zone.allowedTypes.length > 0 && existing.meta.type && !zone.allowedTypes.includes(existing.meta.type)) {
			return { success: false, error: `Type "${existing.meta.type}" not allowed in zone "${targetZone}"` };
		}

		const filename = path.split('/').pop()!;
		const newPath = join(targetZone, filename);
		const absSource = resolve(this.config.rootDir, path);
		const absTarget = resolve(this.config.rootDir, newPath);

		if (newPath === path) {
			return { success: false, error: `Target zone equals source zone: ${path}` };
		}

		// Collision guard — `rename()` silently clobbers on POSIX. Refuse loud
		// so the caller knows the target is occupied (mirrors ADR-012 archive
		// guard).
		try {
			await stat(absTarget);
			return { success: false, error: `Move target already exists: ${newPath}` };
		} catch {
			// Good — destination free.
		}

		try {
			await mkdir(dirname(absTarget), { recursive: true });
			await rename(absSource, absTarget);
		} catch (err) {
			this.logWrite({
				action: 'move',
				path: newPath,
				previousPath: path,
				agent: existing.meta.source_agent as string | undefined,
				context: existing.meta.source_context as string | undefined,
				zone: targetZone.split('/')[0],
				type: existing.meta.type as string | undefined,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
			return { success: false, error: `Move failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		this.indexer.remove(path);
		this.searcher.remove(path);
		await this.indexer.reindex(newPath);
		const note = this.indexer.get(newPath);
		if (note) this.searcher.upsert(note);

		this.logWrite({
			action: 'move',
			path: newPath,
			previousPath: path,
			agent: existing.meta.source_agent as string | undefined,
			context: existing.meta.source_context as string | undefined,
			zone: targetZone.split('/')[0],
			type: existing.meta.type as string | undefined,
			success: true,
		});

		this.committer.enqueue({
			action: 'move',
			path: newPath,
			previousPath: path,
			zone: targetZone.split('/')[0],
			type: existing.meta.type as string | undefined,
			agent: existing.meta.source_agent as string | undefined,
			context: existing.meta.source_context as string | undefined,
		});

		return { success: true, path: newPath };
	}

	/** ADR-004 (soul-hub-cli) — link-safe relocation. Moves one note (optionally
	 *  renaming it) to a new zone, then rewrites every inbound wikilink across the
	 *  vault — body AND frontmatter relationship fields — so nothing dangles. A
	 *  thin wrapper over `relocateNotes` (single-element batch). */
	async relocateNote(
		spec: MoveSpec,
		opts?: { dryRun?: boolean; actor?: string; actorContext?: string },
	): Promise<RelocateResult> {
		return this.relocateNotes([spec], opts);
	}

	/** ADR-004 — batch link-safe relocation. Moves a SET of notes in one pass.
	 *  Because all files are moved BEFORE any inbound link is rewritten, every
	 *  destination already exists when a rewritten relationship field is
	 *  re-validated — so mutually-referencing notes move with no forward-
	 *  reference failure and no two-pass workaround (the ADR-004 motivation).
	 *  The committer's debounce coalesces the move + rewrites into one commit. */
	async relocateNotes(
		specs: MoveSpec[],
		opts?: { dryRun?: boolean; actor?: string; actorContext?: string },
	): Promise<RelocateResult> {
		// 1. Resolve + validate every move; build the src→dst map.
		const moveMap = new Map<string, string>();
		const moves: { src: string; dst: string }[] = [];
		const movingSrc = new Set(specs.map((s) => s.src));
		for (const spec of specs) {
			const existing = this.indexer.get(spec.src);
			if (!existing) return { success: false, error: `Note not found: ${spec.src}`, moves: [], rewrites: [] };
			const srcZone = dirname(spec.src);
			const srcFilename = spec.src.split('/').pop()!;
			const targetZone = spec.targetZone ?? srcZone;
			const filename = spec.newFilename ?? srcFilename;
			const dst = join(targetZone, filename);
			if (dst === spec.src) return { success: false, error: `Destination equals source: ${spec.src}`, moves: [], rewrites: [] };
			if (this.indexer.get(dst) && !movingSrc.has(dst)) {
				return { success: false, error: `Destination already exists: ${dst}`, moves: [], rewrites: [] };
			}
			const zone = this.governance.resolve(targetZone);
			if (zone.allowedTypes.length > 0 && existing.meta.type && !zone.allowedTypes.includes(existing.meta.type)) {
				return { success: false, error: `Type "${existing.meta.type}" not allowed in zone "${targetZone}"`, moves: [], rewrites: [] };
			}
			moveMap.set(spec.src, dst);
			moves.push({ src: spec.src, dst });
		}

		// A bare new slug is safe to keep bare only if no OTHER (non-moving) note
		// owns that basename — the moved note will then be its sole holder.
		const dstSlugs = new Set([...moveMap.values()].map((p) => stripMd(p).split('/').pop()!));
		const bareSlugIsUnique = (slug: string): boolean => {
			if (!dstSlugs.has(slug)) {
				// Not one of our destinations — fall back to path form to be safe.
				return false;
			}
			return !this.indexer.all().some((n) => !movingSrc.has(n.path) && stripMd(n.path.split('/').pop()!) === slug);
		};

		// 2. Capture phase (BEFORE moving): the resolver still maps old targets to
		//    their current paths, so we can detect which links point into the move
		//    set and precompute the rewritten body/meta for every affected note.
		const rewrites: { path: string; newContent?: string; newMeta?: VaultMeta; bodyCount: number; metaCount: number }[] = [];
		for (const note of this.indexer.all()) {
			const resolveTarget = (raw: string) => this.indexer.resolveLink(raw, note.path);
			const body = rewriteBody(note.content, resolveTarget, moveMap, bareSlugIsUnique);
			const relFields = this.governance.resolve(dirname(note.path)).allowedRelationshipFields;
			const meta = rewriteMeta(note.meta, relFields, resolveTarget, moveMap, bareSlugIsUnique);
			if (body.count > 0 || meta.count > 0) {
				rewrites.push({
					path: note.path,
					newContent: body.count > 0 ? body.content : undefined,
					newMeta: meta.count > 0 ? meta.meta : undefined,
					bodyCount: body.count,
					metaCount: meta.count,
				});
			}
		}

		if (opts?.dryRun) {
			return {
				success: true,
				dryRun: true,
				moves,
				rewrites: rewrites.map((r) => ({ path: r.path, bodyCount: r.bodyCount, metaCount: r.metaCount })),
			};
		}

		// 3. Move every file first (low-level rename, no validation), so all
		//    destinations exist before any inbound link is rewritten.
		for (const { src, dst } of moves) {
			const moved = await this._relocateFile(src, dst, opts);
			if (!moved.success) return { success: false, error: moved.error, moves: [], rewrites: [] };
		}

		// 4. Apply the precomputed rewrites. A rewritten note that was itself moved
		//    now lives at its destination — apply there.
		for (const r of rewrites) {
			const targetPath = moveMap.get(r.path) ?? r.path;
			const req: UpdateNoteRequest = {};
			if (r.newContent !== undefined) req.content = r.newContent;
			if (r.newMeta !== undefined) req.meta = r.newMeta;
			const res = await this.updateNote(targetPath, req, {
				actor: opts?.actor ?? 'relocateNote',
				actorContext: opts?.actorContext ?? `link-rewrite (${r.bodyCount} body, ${r.metaCount} meta)`,
			});
			if (!res.success) {
				return { success: false, error: `Link rewrite failed at ${targetPath}: ${res.error}`, moves, rewrites: [] };
			}
		}

		return {
			success: true,
			moves,
			rewrites: rewrites.map((r) => ({ path: r.path, bodyCount: r.bodyCount, metaCount: r.metaCount })),
		};
	}

	/** Internal: relocate a single file on disk to an arbitrary destination path
	 *  (zone AND/OR filename change), updating the index. Mirrors `moveNote`'s
	 *  collision-guard + reindex + commit, but allows a filename change. Does NOT
	 *  rewrite links — the caller (`relocateNotes`) owns that. */
	private async _relocateFile(
		path: string,
		newPath: string,
		opts?: { actor?: string; actorContext?: string },
	): Promise<WriteResult | WriteError> {
		const existing = this.indexer.get(path);
		if (!existing) return { success: false, error: `Note not found: ${path}` };
		const absSource = resolve(this.config.rootDir, path);
		const absTarget = resolve(this.config.rootDir, newPath);
		try {
			await stat(absTarget);
			return { success: false, error: `Move target already exists: ${newPath}` };
		} catch {
			// destination free
		}
		try {
			await mkdir(dirname(absTarget), { recursive: true });
			await rename(absSource, absTarget);
		} catch (err) {
			return { success: false, error: `Move failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		this.indexer.remove(path);
		this.searcher.remove(path);
		await this.indexer.reindex(newPath);
		const note = this.indexer.get(newPath);
		if (note) this.searcher.upsert(note);
		const agent = opts?.actor ?? (existing.meta.source_agent as string | undefined);
		const context = opts?.actorContext ?? (existing.meta.source_context as string | undefined);
		this.logWrite({
			action: 'move',
			path: newPath,
			previousPath: path,
			agent,
			context,
			zone: dirname(newPath).split('/')[0],
			type: existing.meta.type as string | undefined,
			success: true,
		});
		this.committer.enqueue({
			action: 'move',
			path: newPath,
			previousPath: path,
			zone: dirname(newPath).split('/')[0],
			type: existing.meta.type as string | undefined,
			agent,
			context,
		});
		return { success: true, path: newPath };
	}

	async reindex(): Promise<VaultStats> {
		await this.indexer.scan();
		this.searcher.rebuild(this.indexer.all());
		emitReindex({ reason: 'manual' });
		return this.indexer.stats();
	}

	/**
	 * Delete notes in a zone older than maxAgeDays.
	 * Used for ephemeral zones like sessions/ that auto-cleanup.
	 */
	async pruneZone(zone: string, maxAgeDays: number, typeFilter?: string): Promise<{ pruned: string[] }> {
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const pruned: string[] = [];

		const notes = this.indexer.filter({ zone });
		for (const note of notes) {
			if (note.mtime < cutoff) {
				// If typeFilter specified, only prune notes of that type
				if (typeFilter && note.meta.type !== typeFilter) continue;

				const absPath = resolve(this.config.rootDir, note.path);
				try {
					await unlink(absPath);
					this.indexer.remove(note.path);
					this.searcher.remove(note.path);
					pruned.push(note.path);
					this.logWrite({
						action: 'delete',
						path: note.path,
						agent: note.meta.source_agent as string | undefined,
						context: note.meta.source_context as string | undefined,
						zone,
						type: note.meta.type as string | undefined,
						success: true,
					});
					this.committer.enqueue({
						action: 'delete',
						path: note.path,
						zone,
						type: note.meta.type as string | undefined,
						agent: note.meta.source_agent as string | undefined,
						context: note.meta.source_context as string | undefined,
					});
				} catch {
					// file may already be gone
				}
			}
		}

		if (pruned.length > 0) {
			console.log(`[vault] Pruned ${pruned.length} notes from ${zone}/ (older than ${maxAgeDays} days)`);
		}

		return { pruned };
	}

	async archiveOldNotes(zone: string, maxAgeDays: number): Promise<{ archived: string[]; assetsArchived: number }> {
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const archived: string[] = [];
		let assetsArchived = 0;

		const notes = this.indexer.filter({ zone });
		for (const note of notes) {
			if (note.mtime < cutoff) {
				// Slice 0 — collect referenced asset paths from the frontmatter
				// `attachments[].path` array before archiving the note. We move
				// the note first, then chase the assets so that even if asset
				// moves fail the note still ends up in archive (its content is
				// the source of truth).
				const attachmentPaths = collectAttachmentPaths(note.meta);

				const result = await this.moveNote(note.path, 'archive');
				if (!result.success) continue;
				archived.push(note.path);

				for (const assetPath of attachmentPaths) {
					const moved = await this.moveAssetToArchive(assetPath);
					if (moved) assetsArchived++;
				}
			}
		}

		if (archived.length > 0) {
			console.log(
				`[vault] Archived ${archived.length} notes from ${zone}/ ` +
					`(older than ${maxAgeDays} days)` +
					(assetsArchived > 0 ? ` + ${assetsArchived} referenced asset(s)` : ''),
			);
		}

		return { archived, assetsArchived };
	}

	/** Move a binary asset to the archive zone, mirroring its source path
	 *  under `archive/`. Skips with a warning if the destination already
	 *  exists (we never overwrite). Returns true on success. */
	private async moveAssetToArchive(relPath: string): Promise<boolean> {
		const absSource = resolve(this.config.rootDir, relPath);
		try {
			await stat(absSource);
		} catch {
			// Note referenced an asset that's already missing — nothing to do.
			return false;
		}

		// Strip the leading zone and prefix with `archive/`. `inbox/assets/foo.jpg`
		// → `archive/assets/foo.jpg`. Single-segment paths fall back to placing
		// the file directly under `archive/`.
		const segments = relPath.split('/').filter(Boolean);
		const archiveRel =
			segments.length > 1 ? join('archive', ...segments.slice(1)) : join('archive', segments[0] ?? relPath);
		const absDest = resolve(this.config.rootDir, archiveRel);

		try {
			await stat(absDest);
			console.warn(`[vault] Asset already exists in archive — skipping: ${archiveRel}`);
			return false;
		} catch {
			// Good — destination is free.
		}

		try {
			await mkdir(dirname(absDest), { recursive: true });
			await rename(absSource, absDest);
			return true;
		} catch (err) {
			console.warn(`[vault] Failed to archive asset ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	/** ADR-049 — materialise empty stub notes for every `unresolved-target`
	 *  warning. Caller already gates on `meta.scaffold_stubs === true`.
	 *
	 *  Target path rules:
	 *    - `[[multi/segment]]` → vault-relative `multi/segment.md`
	 *    - `[[single]]`        → sibling of source: `<dirname(source)>/single.md`
	 *
	 *  Wikilinks with embedded headings/aliases (`[[foo#heading|Display]]`)
	 *  are already normalised at the validator — we only see the bare target
	 *  in the warning's `.link` field.
	 *
	 *  Stub frontmatter inherits project + source_agent from the parent for
	 *  audit continuity, and stamps `stub_for` so future cleanup can find
	 *  them. Body is intentionally minimal — these are placeholders, not
	 *  real notes.
	 *
	 *  Skipped silently:
	 *    - `auto-memory-wikilink` / `bare-project-slug` rules (those are
	 *      REFUSE-only and never reach this method anyway, but defensive).
	 *    - Target path that already exists (race / partial scaffolding from
	 *      a prior write).
	 *    - Invalid link shapes (path traversal, absolute paths).
	 *
	 *  Writes bypass `createNote` to avoid recursive validation / rate
	 *  limiting / dedup overhead — stubs are sub-writes of the parent and
	 *  share its provenance.
	 */
	private async scaffoldStubsForWarnings(
		warnings: LinkIssue[],
		sourcePath: string,
		parentMeta: VaultMeta,
	): Promise<StubInfo[]> {
		const today = new Date().toISOString().slice(0, 10);
		const sourceDir = dirname(sourcePath);
		const created: StubInfo[] = [];
		const seen = new Set<string>();

		for (const w of warnings) {
			if (w.rule !== 'unresolved-target') continue;
			const raw = w.link.trim();
			if (!raw || raw.includes('..') || raw.startsWith('/')) continue;

			const target = raw.endsWith('.md') ? raw : `${raw}.md`;
			const stubPath = target.includes('/')
				? target
				: (sourceDir === '.' ? target : `${sourceDir}/${target}`);

			if (seen.has(stubPath)) continue;
			seen.add(stubPath);

			const absPath = resolve(this.config.rootDir, stubPath);
			try {
				await stat(absPath);
				continue; // already exists — skip silently
			} catch {
				// good, file doesn't exist
			}

			const title = this.stubTitle(raw);
			const stubMeta: VaultMeta = {
				type: 'stub',
				created: today,
				tags: ['auto-generated', 'stub'],
				stub_for: `[[${raw}]]`,
				source_agent: parentMeta.source_agent as string | undefined,
				source_context: `Scaffolded from ${sourcePath}`,
			};
			if (parentMeta.project) stubMeta.project = parentMeta.project as string;

			const body = `# ${title}\n\n> Stub placeholder. Created via \`scaffold_stubs\` from [[${sourcePath.replace(/\.md$/, '')}]].\n> Fill in when ready, or delete if the parent link no longer needs a target.\n`;
			const content = matter.stringify(body, stubMeta);

			this.watcher.suppress(stubPath);
			try {
				await mkdir(dirname(absPath), { recursive: true });
				const tmpPath = absPath + '.tmp';
				await writeFile(tmpPath, content, 'utf-8');
				await rename(tmpPath, absPath);
			} catch {
				continue; // skip this stub on write failure; parent write proceeds
			}

			await this.indexer.reindex(stubPath);
			const note = this.indexer.get(stubPath);
			if (note) this.searcher.upsert(note);

			this.logWrite({
				action: 'create',
				path: stubPath,
				agent: parentMeta.source_agent as string | undefined,
				context: `stub for [[${raw}]] from ${sourcePath}`,
				zone: stubPath.split('/')[0],
				type: 'stub',
				success: true,
			});

			this.committer.enqueue({
				action: 'create',
				path: stubPath,
				zone: stubPath.split('/')[0],
				type: 'stub',
				agent: parentMeta.source_agent as string | undefined,
				context: `stub for [[${raw}]] from ${sourcePath}`,
			});

			created.push({ path: stubPath, for_link: raw, source: sourcePath });
		}

		return created;
	}

	/** Convert a wikilink target ("research/early-draft" or "early-draft") into
	 *  a human-readable title for the stub heading. */
	private stubTitle(raw: string): string {
		const last = raw.split('/').pop() ?? raw;
		return last
			.replace(/\.md$/i, '')
			.split('-')
			.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
			.join(' ')
			.trim() || raw;
	}

	async scaffoldProject(projectName: string): Promise<{ created: string[]; existed: string[] }> {
		const created: string[] = [];
		const existed: string[] = [];
		const projectZone = `projects/${projectName}`;
		const absBase = resolve(this.config.rootDir, projectZone);

		// Create subfolders
		const subfolders = ['decisions', 'learnings', 'debugging', 'outputs'];
		for (const sub of subfolders) {
			const dir = resolve(absBase, sub);
			try {
				await stat(dir);
				existed.push(`${projectZone}/${sub}/`);
			} catch {
				await mkdir(dir, { recursive: true });
				created.push(`${projectZone}/${sub}/`);
			}
		}

		// Create CLAUDE.md if not exists
		const claudePath = resolve(absBase, 'CLAUDE.md');
		try {
			await stat(claudePath);
			existed.push(`${projectZone}/CLAUDE.md`);
		} catch {
			const governance = `# ${projectName} — Vault Governance

## Allowed Types
learning, decision, debugging, output, index

## Required Fields
type, created, tags, project

## Quality Rules
- Decisions must have: Status, Context, Decision, Consequences sections
- Learnings must reference source (commit, conversation, pipeline)
- Debugging notes must have: Symptom, Root Cause, Fix, Prevention sections
- All notes must include project: ${projectName} in frontmatter

## AI Write Rules
- Agent outputs go to outputs/ subfolder
- Never overwrite existing notes — create new

## Before You Build
Search the vault for relevant knowledge before starting work:
\`\`\`bash
curl -s "http://localhost:2400/api/vault/notes?project=${projectName}&limit=10"
curl -s "http://localhost:2400/api/vault/notes?q=<your-topic>&limit=5"
\`\`\`
Check: decisions (why things are the way they are), debugging (known pitfalls), learnings (reusable solutions).

## After You Build
Save valuable knowledge:
- **Reusable pattern** → POST to /api/vault/notes with zone "projects/${projectName}/learnings"
- **Design decision** → POST with zone "projects/${projectName}/decisions"
- **Surprising learning** → POST with zone "projects/${projectName}/learnings"
- **Bug investigation** → POST with zone "projects/${projectName}/debugging"
`;
			await writeFile(claudePath, governance, 'utf-8');
			created.push(`${projectZone}/CLAUDE.md`);
		}

		// Create index.md if not exists
		const indexPath = resolve(absBase, 'index.md');
		try {
			await stat(indexPath);
			existed.push(`${projectZone}/index.md`);
		} catch {
			const today = new Date().toISOString().slice(0, 10);
			const index = `---
type: index
created: ${today}
tags: [${projectName}]
project: ${projectName}
---

# ${projectName}

## Decisions

## Learnings

## Debugging

## Outputs
`;
			await writeFile(indexPath, index, 'utf-8');
			created.push(`${projectZone}/index.md`);
			// Reindex to pick up the new note
			await this.indexer.reindex(`${projectZone}/index.md`);
			const note = this.indexer.get(`${projectZone}/index.md`);
			if (note) this.searcher.upsert(note);
		}

		// Re-scan governance to pick up new CLAUDE.md
		await this.governance.scan(this.config.rootDir);

		return { created, existed };
	}
}

/** Slice 0 helper — pull asset paths out of a note's frontmatter. The
 *  brain frontmatter contract uses `attachments: [{path, kind, ...}]`.
 *  Tolerant by design: silently ignores entries without a string `path`,
 *  or stray non-array shapes. Skips paths that contain `..` so a malformed
 *  note can't trick the archiver into moving files outside the vault. */
function collectAttachmentPaths(meta: Record<string, unknown>): string[] {
	const raw = meta?.attachments;
	if (!Array.isArray(raw)) return [];
	const paths: string[] = [];
	for (const entry of raw) {
		if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
			const p = (entry as { path: string }).path;
			if (p && !p.includes('..')) paths.push(p);
		}
	}
	return paths;
}

export function getVaultEngine(): VaultEngine | null {
	return engine;
}

export async function initVault(vaultDir: string): Promise<VaultEngine> {
	if (engine) return engine;
	// Ensure vault root exists — fresh installs won't have it
	await mkdir(vaultDir, { recursive: true });
	const config: VaultConfig = {
		rootDir: vaultDir,
		templateDir: resolve(vaultDir, '.vault', 'templates'),
		indexPath: resolve(vaultDir, '.vault', 'index.json'),
		zones: [],
	};
	const instance = new VaultEngine(config);
	await instance.init();
	engine = instance; // Only expose after init completes
	return engine;
}
