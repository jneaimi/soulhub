/** GET /api/vault/projects — list every folder under <vault>/projects/ with
 *  a frontmatter rollup (ADR count by status, last activity, open count,
 *  upcoming falsifier dates).
 *
 *  Per ADR-037 Phase 1.5. Read-only; the matching `/projects` UI uses this
 *  as its primary data source. The vault engine indexes notes (frontmatter,
 *  content, links) but does not natively enumerate project folders, so this
 *  endpoint scans the directory then calls `engine.getNotes({ project })`
 *  per slug to build the rollup. */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getVaultEngine } from '$lib/vault/index.js';
import { parsePhases, type Phase } from '$lib/vault/phase-parser.js';
import type { ProducerEdge, ProjectShape, VaultMeta } from '$lib/vault/types.js';
import { PROJECT_SHAPES } from '$lib/vault/types.js';
import { getDescendants } from '$lib/vault/descendants.js';
import { computeCriticalPath } from '$lib/projects/critical-path.js';
import { computeNetworkLayout } from '$lib/projects/dagre-layout.js';

const PROJECT_ZONE = 'projects';

/** Canonical status set per ~/vault/projects/CLAUDE.md governance.
 *  See ~/vault/knowledge/learnings/2026-05-14-adr-status-canonical-set.md.
 *  `other` should always be 0 — non-zero means a non-canonical status
 *  has crept back in and the migration script needs to be re-run. */
type StatusCounts = {
	proposed: number;
	accepted: number;
	shipped: number;
	rejected: number;
	parked: number;
	superseded: number;
	other: number;
};

interface DecisionRow {
	path: string;
	title: string;
	status: string;
	created: string | null;
	acceptedOn: string | null;
	shippedOn: string | null;
	targetDate: string | null;
	dateInferred: boolean;
	falsifierDate: string | null;
	falsifierDaysAway: number | null;
	tags: string[];
	blockedBy: string[];
	/** ADR-LEVEL phase milestones — only `source: 'adr-body'` phases
	 *  (in-body markers like `**Phase 1 SHIPPED**`). Project-level roadmap
	 *  phases were retired by project-phases ADR-013 (2026-05-18): the
	 *  `## Roadmap` table in `projects/<slug>/index.md` is now operator-curated
	 *  narrative only, no parser consumes it for dynamic rendering. ADR
	 *  frontmatter is the canonical lifecycle state.
	 *  Empty on parse failure — never breaks the list view. */
	phases?: Phase[];
}

interface ProjectRollup {
	slug: string;
	adrCount: number;
	noteCount: number;
	/** Decision-only status counts. Retained verbatim so existing consumers
	 *  (list-view tree row, detail-page grid) keep working unchanged.
	 *  Mirrors `artifactCounts.decision` exactly. */
	statusCounts: StatusCounts;
	/** projects-graph ADR-003 — per-note-type status rollup. Keyed by frontmatter
	 *  `type:` (e.g. `decision`, `task`, `output`, `research`, `proposal`).
	 *  Each value is a StatusCounts bucket using the canonical-6 buckets
	 *  enforced by ADR-002. Only types that have at least one note appear
	 *  as keys — empty/sparse projects don't pay the iteration cost. */
	artifactCounts: Record<string, StatusCounts>;
	openCount: number;
	lastActivity: number | null;
	/** Mixed list: ADR-level falsifier dates (existing) plus the project-level
	 *  falsifier date (projects-graph ADR-001) when present. `source: 'project'`
	 *  marks the project-level row so the UI can render it distinctly. */
	upcomingFalsifiers: {
		path: string;
		date: string;
		daysAway: number;
		source?: 'project';
	}[];
	hasIndex: boolean;
	indexPath: string | null;
	/** Slug of parent project, or null for root projects. Per ADR-038
	 *  D2/D3: stored on `index.md` as `parent_project: "[[slug|alias]]"`.
	 *  Inverted client-side to build the tree (child_projects is not stored). */
	parentProject: string | null;
	/** projects-graph ADR-001 — declared shape (`coding-spine`, `producer-pipeline`,
	 *  etc). Drives shape-aware rendering. Null when un-labelled. */
	shape: ProjectShape | null;
	/** projects-graph ADR-001 — free-text project-level falsifier claim. */
	projectFalsifier: string | null;
	/** Companion ISO date for `projectFalsifier`. Shape A (Schmidt/parser-style)
	 *  per project-phases ADR-004. */
	projectFalsifierDate: string | null;
	/** projects-graph ADR-013 — tag list from the project root index.md
	 *  frontmatter. Empty when index.md is absent. Drives the header cluster
	 *  pill (`tags.find(t => t.startsWith('cluster:'))`) and any future
	 *  tag-derived UI. Tags on individual notes within the project are NOT
	 *  aggregated here — too noisy. */
	tags: string[];
	/** projects-graph ADR-006 — outgoing producer→consumer edges declared
	 *  on this project's root `index.md`. Mix of bare wikilink strings and
	 *  rich-form `{target, destination?, falsifier?, falsifier_date?}`
	 *  entries. Operator-authored. Omitted when none. */
	producesFor?: ProducerEdge[];
	/** projects-graph ADR-006 — computed inverse: slugs of every project
	 *  whose `produces_for` includes THIS project. Never stored — derived
	 *  read-time by walking every project's `produces_for` and inverting.
	 *  Mirrors the ADR-038 `child_projects ← parent_project` pattern.
	 *  Omitted when empty. */
	consumesFrom?: string[];
	/** projects-graph ADR-012 — one-line project description for the list
	 *  view. Resolution order: (1) `description:` frontmatter on root
	 *  index.md, (2) first non-heading paragraph of the index body
	 *  truncated to 140 chars. Empty when neither resolves. */
	description: string;
	decisions?: DecisionRow[];
	/** projects-graph ADR-004 — flat list of descendant slugs reachable
	 *  via `parent_project` edges. Only present when the request passed
	 *  `?descendants=true`. Empty for leaf projects. */
	descendantSlugs?: string[];
	/** projects-graph ADR-004 — statusCounts summed across self + all
	 *  descendants. Only present when `?descendants=true`. The grid in
	 *  /projects/[slug] renders this alongside per-project counts. */
	aggregateStatusCounts?: StatusCounts;
	/** projects-graph ADR-004 — per-type artifact buckets summed across
	 *  self + descendants. Same lazy-allocation shape as `artifactCounts`. */
	aggregateArtifactCounts?: Record<string, StatusCounts>;
	/** projects-graph ADR-004 — descendant falsifiers tagged with their
	 *  source project for the rolled-up UpcomingFalsifiers strip. */
	descendantFalsifiers?: {
		path: string;
		date: string;
		daysAway: number;
		source?: 'project';
		fromProject: string;
	}[];
	/** projects-graph ADR-004 — true when the walker hit a cycle
	 *  (defensive; live data is acyclic). Surfaces a hygiene warning in
	 *  the UI when set. */
	cycleDetected?: boolean;
	/** projects-graph ADR-004 — descendant rollups (each with its own
	 *  decisions[] when applicable) inlined for the parent-rollup Gantt.
	 *  Only present when both `?descendants=true` and
	 *  `?includeChildren=true` flags are set on a single-slug request.
	 *  Saves a second round-trip + lets the tree-table render in a
	 *  single component without per-child fetches. */
	descendantRollups?: ProjectRollup[];
	/** projects-graph ADR-016 — dagre Sugiyama layout for the project's
	 *  ADR DAG (per-project network view). Present only when the request
	 *  passed `?layout=network`. The shape mirrors `LayoutResult` from
	 *  `dagre-layout.ts`: `{ nodes: [{slug, x, y, rank}], edges: [{edge,
	 *  points}], bounds, ranks }`. AI consumers (`soul project get …`,
	 *  chat-driven inspection) see `rank: N` per node directly without
	 *  inferring it from the visual layout. */
	networkLayout?: {
		nodes: { slug: string; x: number; y: number; rank: number }[];
		edges: { edge: { blocker: string; dependent: string; external: boolean; blockerStatus: string | null }; points: { x: number; y: number }[] }[];
		bounds: { width: number; height: number };
		ranks: number;
	};
}

/** projects-graph ADR-012 — extract the first non-heading, non-blockquote,
 *  non-list paragraph from a markdown body. Returns trimmed prose up to
 *  140 chars (with ellipsis when truncated), or '' when nothing usable. */
function firstParagraph(body: string): string {
	const lines = body.split('\n');
	const buf: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) {
			if (buf.length) break;
			continue;
		}
		if (/^#{1,6}\s/.test(line)) continue;
		if (line.startsWith('>')) continue;
		if (/^[-*+]\s/.test(line)) continue;
		if (/^\d+\.\s/.test(line)) continue;
		if (line.startsWith('```')) continue;
		if (line.startsWith('|')) continue;
		if (line.startsWith('<')) continue;
		buf.push(line);
	}
	const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
	if (!joined) return '';
	if (joined.length <= 140) return joined;
	const slice = joined.slice(0, 140);
	const lastSpace = slice.lastIndexOf(' ');
	return (lastSpace > 100 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}

/** Extract the target slug from a parent_project wikilink value.
 *  Accepts `[[slug]]`, `[[slug|alias]]`, `[[path/to/slug]]`, or the
 *  path-to-index form `[[../soul-hub/index|soul-hub]]` operators reach for
 *  when Obsidian's link-completer picks an `index.md`. Trailing `/index`
 *  (or `/index.md`) is stripped before we take the last segment, so both
 *  shapes resolve to the same project slug. */
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

function asStringArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string') as string[];
	if (typeof raw === 'string') return [raw];
	return [];
}

function emptyStatusCounts(): StatusCounts {
	return { proposed: 0, accepted: 0, shipped: 0, rejected: 0, parked: 0, superseded: 0, other: 0 };
}

function bucketStatus(raw: unknown): keyof StatusCounts {
	const s = String(raw ?? '').toLowerCase();
	if (s === 'proposed') return 'proposed';
	if (s === 'accepted') return 'accepted';
	if (s === 'shipped') return 'shipped';
	if (s === 'rejected') return 'rejected';
	if (s === 'parked') return 'parked';
	if (s === 'superseded') return 'superseded';
	return 'other';
}

function daysBetween(iso: string): number | null {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	return Math.round((t - Date.now()) / 86_400_000);
}

/** Coerce a YAML date|string value to ISO YYYY-MM-DD. YAML parses
 *  `falsifier_date: 2026-06-30` as a Date object; we want the string. */
function asIsoDate(raw: unknown): string | null {
	if (typeof raw === 'string') return raw.trim() || null;
	if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
		return raw.toISOString().slice(0, 10);
	}
	return null;
}

export const GET: RequestHandler = async ({ url }) => {
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

	// Optional ?slug=foo,bar — return only those folders (used by detail view)
	const filterParam = url.searchParams.get('slug');
	const filterSet = filterParam ? new Set(filterParam.split(',').map((s) => s.trim())) : null;

	// projects-graph ADR-004 — `?descendants=true` triggers a parent-rollup
	// pass: aggregate statusCounts / artifactCounts / upcomingFalsifiers
	// across descendants reachable via `parent_project` edges. When set,
	// we MUST build rollups for the whole vault (the walker needs every
	// project's parentProject + counts) and then restrict the response set
	// to the requested filter at the end.
	const wantDescendants = url.searchParams.get('descendants') === 'true';
	// projects-graph ADR-004 — `?includeChildren=true` (only honored
	// alongside `?descendants=true` and a single-slug filter) inlines
	// descendant rollups + their decisions so the tree-Gantt renders
	// without N+1 fetches.
	const wantChildren = wantDescendants && url.searchParams.get('includeChildren') === 'true';
	const internalFilterSet = wantDescendants ? null : filterSet;

	// projects-graph ADR-016 — `?layout=network` attaches a `networkLayout`
	// field to each rollup (dagre Sugiyama positioning of ADR nodes +
	// polyline edges). AI-facing affordance for the `/projects/[slug]`
	// per-project view. Forces decisions to be included even on
	// multi-slug requests so the layout has nodes to lay out.
	const wantNetworkLayout = url.searchParams.get('layout') === 'network';

	// When a single slug is requested, include per-decision rows on the rollup.
	// Skipped on the list view to keep the payload tight. When child-decisions
	// are requested, every project in the loop builds decisions so the
	// post-pass can attach descendant rollups with their own decisions.
	const includeDecisions =
		(filterSet !== null && filterSet.size === 1) || wantChildren || wantNetworkLayout;

	// projects-graph ADR-006 — build the producer→consumer inverse map
	// in a single full-vault sweep BEFORE the rollup loop. Required even
	// when `filterSet` restricts the response so that `consumesFrom` on
	// a filtered project surfaces producers outside the filter set. Each
	// entry: <consumer-slug> → sorted list of <producer-slug>s. Cheap —
	// every index.md is already in the engine's in-memory index.
	const consumesFromMap = new Map<string, Set<string>>();
	for (const producerSlug of entries) {
		if (producerSlug.startsWith('.') || producerSlug.startsWith('_')) continue;
		const idx = engine.getNote(`projects/${producerSlug}/index.md`);
		if (!idx) continue;
		const rawProducesFor = idx.meta.produces_for;
		if (!Array.isArray(rawProducesFor)) continue;
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
			if (!consumerSlug || consumerSlug === producerSlug) continue;
			const set = consumesFromMap.get(consumerSlug) ?? new Set<string>();
			set.add(producerSlug);
			consumesFromMap.set(consumerSlug, set);
		}
	}

	const rollups: ProjectRollup[] = [];

	for (const slug of entries) {
		if (slug.startsWith('.') || slug.startsWith('_')) continue;
		if (internalFilterSet && !internalFilterSet.has(slug)) continue;

		const abs = resolve(projectsDir, slug);
		try {
			const s = await stat(abs);
			if (!s.isDirectory()) continue;
		} catch {
			continue;
		}

		// All notes whose frontmatter `project: <slug>` matches. Falls back to
		// nothing if the project has no notes with that field — most projects
		// in the vault DO use the `project:` frontmatter, but a few legacy
		// folders don't, in which case the rollup will under-report.
		// Archive zone is excluded: per archive/CLAUDE.md, notes there are
		// out of the active lifecycle, so they should not show in project
		// stat counts or the decisions list.
		const notes = engine
			.getNotes({ project: slug, limit: 500 })
			.filter((n) => !n.path.startsWith('archive/'));

		const counts = emptyStatusCounts();
		// projects-graph ADR-003 — per-type accumulator. Lazily-allocated so
		// that a project with only `decision` notes ships `{ decision: {...} }`
		// rather than 6 empty buckets. Keys are lowercased frontmatter `type:`
		// values. `counts` (decision-only) stays as the public back-compat
		// surface and is kept in sync with `artifactCounts.decision`.
		const artifactCounts: Record<string, StatusCounts> = {};
		let adrCount = 0;
		let lastActivity: number | null = null;
		let hasIndex = false;
		let indexPath: string | null = null;
		let parentProject: string | null = null;
		let shape: ProjectShape | null = null;
		let projectFalsifier: string | null = null;
		let projectFalsifierDate: string | null = null;
		// projects-graph ADR-006 — passthrough on the producer rollup.
		// Consumers see this same array verbatim; the reverse view
		// (`consumesFrom`) is computed below across all rollups.
		let producesFor: ProducerEdge[] | undefined;
		// projects-graph ADR-013 — tags from the project root index.md only.
		let projectTags: string[] = [];
		// projects-graph ADR-012 — description for list-view cards.
		let projectDescription = '';
		const upcomingFalsifiers: ProjectRollup['upcomingFalsifiers'] = [];
		const decisions: DecisionRow[] = [];

		// project-phases ADR-001 P2: per-ADR phase extraction needs both the
		// ADR body and the parent project-index body (Pattern A roadmap rows).
		// Capture both during the first pass; attach phases in a second pass
		// once the index body is known.
		let projectIndexContent: string | undefined;
		const phaseTargets: Array<{ row: DecisionRow; body: string; meta: VaultMeta }> = [];

		for (const note of notes) {
			const full = engine.getNote(note.path);
			if (!full) continue;

			// Only the project ROOT index.md owns the rollup metadata. Nested
			// `index.md` files (design/, content-bank/, docs/) would otherwise
			// clobber `parentProject` to null, since they don't carry the
			// parent_project frontmatter.
			if (note.path === `projects/${slug}/index.md`) {
				hasIndex = true;
				indexPath = note.path;
				parentProject = parseParentSlug(full.meta.parent_project);
				projectIndexContent = full.content;
				// projects-graph ADR-013 — capture root index tags for the cluster pill.
				projectTags = asStringArray(full.meta.tags);
				// projects-graph ADR-012 — description: prefer explicit
				// frontmatter, fall back to first body paragraph (140-char cap).
				const rawDesc = full.meta.description;
				if (typeof rawDesc === 'string' && rawDesc.trim()) {
					projectDescription = rawDesc.trim();
				} else if (typeof full.content === 'string') {
					projectDescription = firstParagraph(full.content);
				}

				// projects-graph ADR-001 — surface project_shape + project_falsifier
				// + companion falsifier_date from the project root index.
				const rawShape = full.meta.project_shape;
				if (typeof rawShape === 'string' && rawShape.trim()) {
					const v = rawShape.trim().toLowerCase();
					if ((PROJECT_SHAPES as readonly string[]).includes(v)) {
						shape = v as ProjectShape;
					}
				}

				// projects-graph ADR-006 — passthrough `produces_for[]`. The
				// chokepoint (index.ts) already validated wikilink shape +
				// target resolution at write-time, so we don't re-validate
				// here. Honor both bare-string and rich-form `{target,
				// destination, falsifier?, falsifier_date?}` entries.
				const rawProducesFor = full.meta.produces_for;
				if (Array.isArray(rawProducesFor) && rawProducesFor.length > 0) {
					producesFor = rawProducesFor as ProducerEdge[];
				}
				if (typeof full.meta.project_falsifier === 'string' && full.meta.project_falsifier.trim()) {
					projectFalsifier = full.meta.project_falsifier.trim();
				}
				projectFalsifierDate = asIsoDate(full.meta.falsifier_date) ?? asIsoDate(full.meta.falsifierDate);

				// Emit the project-level falsifier into upcomingFalsifiers
				// alongside ADR-level ones. Same urgency window (-1..60 days).
				// `source: 'project'` lets the UI distinguish.
				if (projectFalsifierDate) {
					const days = daysBetween(projectFalsifierDate);
					if (days !== null && days >= -1 && days <= 60) {
						upcomingFalsifiers.push({
							path: note.path,
							date: projectFalsifierDate,
							daysAway: days,
							source: 'project',
						});
					}
				}
			}

			if (full.mtime && (!lastActivity || full.mtime > lastActivity)) {
				lastActivity = full.mtime;
			}

			// projects-graph ADR-003 — per-type artifact rollup. Counts ANY note
			// with a frontmatter `type:` value, regardless of whether the type
			// is `decision`. Status is bucketed against canonical-6 (ADR-002).
			// Notes without `type:` are skipped — they'd produce a useless
			// `undefined: {...}` bucket. Notes with type but no status (e.g.
			// raw research notes) still count: the status goes into `other`,
			// which the UI can render distinctly.
			const noteType = typeof full.meta.type === 'string' ? full.meta.type.toLowerCase().trim() : '';
			if (noteType) {
				if (!artifactCounts[noteType]) artifactCounts[noteType] = emptyStatusCounts();
				artifactCounts[noteType][bucketStatus(full.meta.status)]++;
			}

			if (full.meta.type === 'decision') {
				adrCount++;
				const status = String(full.meta.status ?? '').toLowerCase();
				const bucket = bucketStatus(full.meta.status);
				counts[bucket]++;

				const falsifier =
					asIsoDate(full.meta.falsifier_date) ?? asIsoDate(full.meta.falsifierDate);
				if (falsifier) {
					const days = daysBetween(falsifier);
					if (days !== null && days >= -1 && days <= 60) {
						upcomingFalsifiers.push({ path: note.path, date: falsifier, daysAway: days });
					}
				}

				if (includeDecisions) {
					const created = asIsoDate(full.meta.created);
					const row: DecisionRow = {
						path: note.path,
						title:
							typeof full.meta.title === 'string' && full.meta.title
								? full.meta.title
								: note.title || note.path.split('/').pop()?.replace(/\.md$/, '') || note.path,
						status,
						created,
						acceptedOn: asIsoDate(full.meta.accepted_on ?? full.meta.acceptedOn),
						shippedOn: asIsoDate(full.meta.shipped_on ?? full.meta.shippedOn),
						targetDate: asIsoDate(full.meta.target_date ?? full.meta.targetDate),
						dateInferred: full.meta.date_inferred === true || full.meta.dateInferred === true,
						falsifierDate: falsifier,
						falsifierDaysAway: falsifier ? daysBetween(falsifier) : null,
						tags: asStringArray(full.meta.tags),
						blockedBy: asStringArray(full.meta.blocked_by ?? full.meta.blockedBy),
					};
					decisions.push(row);
					phaseTargets.push({ row, body: full.content, meta: full.meta });
				}
			}
		}

		// Second pass — attach phases now that the project-index body is known.
		// Per-ADR phases are filtered to ADR-LEVEL only (source: 'adr-body',
		// which includes phases that merged with a project-index ordinal —
		// see phase-parser's mergePhases). Project-level roadmap phases were
		// retired by ADR-013 (2026-05-18).
		// Wrap each call in try/catch so a parser failure on one ADR cannot
		// break the list view (per ADR-001 contract: "never break the list").
		if (includeDecisions && phaseTargets.length > 0) {
			// ADR-002 S4 — rank ADRs by `accepted_on ASC, slug ASC` so the
			// rank-0 ADR is the "primary" for project-index scope folding.
			// Without this, every ADR sharing an ordinal with the project
			// roadmap renders the rank-0 ADR's prose on its own row.
			const rankedTargets = [...phaseTargets].sort((a, b) => {
				const ao = a.row.acceptedOn ?? '9999-12-31';
				const bo = b.row.acceptedOn ?? '9999-12-31';
				if (ao !== bo) return ao.localeCompare(bo);
				return a.row.path.localeCompare(b.row.path);
			});
			const primaryAdrPath = rankedTargets[0]?.row.path;
			for (const target of phaseTargets) {
				try {
					const { phases } = parsePhases({
						adrPath: target.row.path,
						adrBody: target.body,
						adrMeta: target.meta,
						projectIndexBody: projectIndexContent,
						isPrimaryAdr: target.row.path === primaryAdrPath,
					});
					target.row.phases = phases.filter((p) => p.source !== 'project-index');
				} catch {
					target.row.phases = [];
				}
			}
		}

		upcomingFalsifiers.sort((a, b) => a.daysAway - b.daysAway);

		// Decision sort: proposed first (then by created asc — oldest first), then
		// everything else by created desc (newest first). This is what the detail
		// page wants: open decisions on top, recent shipped/accepted right after.
		if (includeDecisions) {
			const statusRank = (s: string) =>
				s === 'proposed' ? 0
				: s === 'accepted' ? 1
				: s === 'shipped' ? 2
				: s === 'superseded' ? 3
				: s === 'parked' ? 4
				: s === 'rejected' ? 5
				: 6;
			decisions.sort((a, b) => {
				const r = statusRank(a.status) - statusRank(b.status);
				if (r !== 0) return r;
				if (a.status === 'proposed' && b.status === 'proposed') {
					return (a.created ?? '').localeCompare(b.created ?? '');
				}
				return (b.created ?? '').localeCompare(a.created ?? '');
			});
		}

		// projects-graph ADR-016 — compute dagre network layout per project
		// when `?layout=network` is set. Filters to non-rejected /
		// non-superseded decisions (mirrors AdrNetwork's default visible
		// set) and feeds the `computeNetworkLayout` utility. Cycle
		// detection inherits from `computeCriticalPath()`; on cycle, we
		// omit the layout — the renderer's cycle-banner branch will fire.
		let networkLayout: ProjectRollup['networkLayout'] | undefined;
		if (wantNetworkLayout) {
			const layoutRows = decisions.filter(
				(d) => d.created && d.status !== 'rejected' && d.status !== 'superseded',
			);
			if (layoutRows.length > 0) {
				const cp = computeCriticalPath(
					layoutRows.map((d) => ({
						path: d.path,
						status: d.status,
						created: d.created,
						acceptedOn: d.acceptedOn,
						shippedOn: d.shippedOn,
						targetDate: d.targetDate,
						blockedBy: d.blockedBy,
					})),
				);
				if (!cp.hasCycle) {
					networkLayout = computeNetworkLayout(layoutRows, cp.edges);
				}
			}
		}

		rollups.push({
			slug,
			adrCount,
			noteCount: notes.length,
			statusCounts: counts,
			artifactCounts,
			openCount: counts.proposed,
			lastActivity,
			upcomingFalsifiers,
			hasIndex,
			indexPath,
			parentProject,
			shape,
			projectFalsifier,
			projectFalsifierDate,
			tags: projectTags,
			description: projectDescription,
			...(producesFor ? { producesFor } : {}),
			...((() => {
				const incoming = consumesFromMap.get(slug);
				return incoming && incoming.size > 0
					? { consumesFrom: [...incoming].sort() }
					: {};
			})()),
			...(includeDecisions ? { decisions } : {}),
			...(networkLayout ? { networkLayout } : {}),
		});
	}

	// Default sort: most recent activity first, projects with no activity last
	rollups.sort((a, b) => {
		if (a.lastActivity && b.lastActivity) return b.lastActivity - a.lastActivity;
		if (a.lastActivity) return -1;
		if (b.lastActivity) return 1;
		return a.slug.localeCompare(b.slug);
	});

	// projects-graph ADR-004 — descendant rollup pass. Walks `parent_project`
	// edges to attach aggregate statusCounts + artifactCounts + falsifiers
	// per requested project. Runs only when `?descendants=true`. The walker
	// is pure + cycle-defensive; per-call cost is O(N+E) over rollups.
	if (wantDescendants) {
		const edges = rollups.map((r) => ({ slug: r.slug, parentProject: r.parentProject }));
		const byslug = new Map<string, ProjectRollup>();
		for (const r of rollups) byslug.set(r.slug, r);

		// Determine which rollups need aggregates. If a filterSet was given,
		// attach only to those; otherwise attach to every project that has
		// at least one child (saves payload bytes for leaves on a LIST call).
		const targets = filterSet
			? rollups.filter((r) => filterSet.has(r.slug))
			: rollups.filter((r) => edges.some((e) => e.parentProject === r.slug));

		for (const r of targets) {
			const walk = getDescendants(r.slug, edges);
			r.descendantSlugs = walk.descendants;
			r.cycleDetected = walk.cycleDetected;

			// Seed aggregates with self, then sum descendants. `aggregate*`
			// always includes the project's own counts so a parent with no
			// children still gets a meaningful value (= same as the
			// per-project counts).
			const aggStatus: StatusCounts = { ...r.statusCounts };
			const aggArtifacts: Record<string, StatusCounts> = {};
			for (const [type, counts] of Object.entries(r.artifactCounts)) {
				aggArtifacts[type] = { ...counts };
			}
			const aggFalsifiers: NonNullable<ProjectRollup['descendantFalsifiers']> = [];

			for (const dslug of walk.descendants) {
				const child = byslug.get(dslug);
				if (!child) continue;
				for (const k of Object.keys(aggStatus) as (keyof StatusCounts)[]) {
					aggStatus[k] += child.statusCounts[k];
				}
				for (const [type, counts] of Object.entries(child.artifactCounts)) {
					if (!aggArtifacts[type]) {
						aggArtifacts[type] = { proposed: 0, accepted: 0, shipped: 0, rejected: 0, parked: 0, superseded: 0, other: 0 };
					}
					for (const k of Object.keys(counts) as (keyof StatusCounts)[]) {
						aggArtifacts[type][k] += counts[k];
					}
				}
				for (const f of child.upcomingFalsifiers) {
					aggFalsifiers.push({ ...f, fromProject: dslug });
				}
			}

			// Sort falsifiers by date ascending (soonest first) so the UI can
			// render them in operator-priority order without re-sorting.
			aggFalsifiers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

			r.aggregateStatusCounts = aggStatus;
			r.aggregateArtifactCounts = aggArtifacts;
			r.descendantFalsifiers = aggFalsifiers;

			// projects-graph ADR-004 — inline descendant rollups (and their
			// decisions, when the loop built them) so the Gantt tree-table
			// renders in one component. Slugs ordered as the walker found
			// them — depth-first via the queue, alphabetically within depth.
			if (wantChildren) {
				const inlined: ProjectRollup[] = [];
				for (const dslug of walk.descendants) {
					const child = byslug.get(dslug);
					if (child) inlined.push(child);
				}
				r.descendantRollups = inlined;
			}
		}

		// Restrict response to the requested filter set (if any) — the
		// internal loop expanded to whole-vault to feed the walker, but the
		// response should still honor the original ?slug filter.
		if (filterSet) {
			const filtered = rollups.filter((r) => filterSet.has(r.slug));
			return json({ projects: filtered, total: filtered.length });
		}
	}

	return json({ projects: rollups, total: rollups.length });
};
