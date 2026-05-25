<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import RenderedMarkdown from '$lib/components/RenderedMarkdown.svelte';
	import DecisionActions from '$lib/components/projects/DecisionActions.svelte';
	import AdrDrawer from '$lib/components/projects/AdrDrawer.svelte';
	import ProjectTreeGantt from '$lib/components/projects/ProjectTreeGantt.svelte';
	import WorkbenchLanes from '$lib/components/projects/WorkbenchLanes.svelte';
	import AssumptionAuditPanel from '$lib/components/projects/AssumptionAuditPanel.svelte';
	import ProposalsPanel from '$lib/components/projects/ProposalsPanel.svelte';

	type PhaseStatus = 'proposed' | 'accepted' | 'shipped' | 'parked' | 'superseded' | 'rejected' | 'unknown';

	interface Phase {
		id: string;
		ordinal: number;
		label: string;
		status: PhaseStatus;
		shipped_at?: string;
		target_date?: string;
		falsifier_date?: string;
		commit?: string;
		source: 'adr-body' | 'project-index' | 'frontmatter';
		scope?: string;
		raw_marker: string;
		qualifiers: string[];
	}

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
		phases?: Phase[];
	}

	/** ADR-level "next action" item — the shape returned by
	 *  /api/vault/projects/:slug/next-actions per project-phases ADR-013.
	 *  Replaced the prior phase-keyed shape; slug uniqueness (ADR-046)
	 *  guarantees no duplicate keys. */
	interface NextActionItem {
		id: string;
		slug: string;
		label: string;
		status: PhaseStatus;
		created: string | null;
		accepted_on: string | null;
		shipped_on: string | null;
		target_date: string | null;
		falsifier_date: string | null;
		scope: string | null;
		source: 'adr';
	}

	interface NextActionsResponse {
		project: string;
		generated_at: string;
		open: NextActionItem[];
		blocked: NextActionItem[];
		recent_shipped: NextActionItem[];
		next: NextActionItem | null;
		hint: 'no_adrs' | null;
	}

	/** projects-graph ADR-001 — declared shape (5 primary + 2 meta). */
	type ProjectShape =
		| 'coding-spine'
		| 'producer-pipeline'
		| 'publishing-outlet'
		| 'strategy-initiative'
		| 'time-boxed-bet'
		| 'maintained-system'
		| 'parent';

	type StatusCounts = { proposed: number; accepted: number; shipped: number; rejected: number; parked: number; superseded: number; other: number };

	interface ProjectDetail {
		slug: string;
		adrCount: number;
		noteCount: number;
		statusCounts: StatusCounts;
		/** projects-graph ADR-003 — per-type artifact rollup. Keys are
		 *  frontmatter `type:` values; each value is a canonical-6 bucket.
		 *  Always includes `decision` (mirrors `statusCounts`); additional
		 *  keys appear lazily for any other type that has at least one note
		 *  in this project (`task`, `output`, `research`, `proposal`, ...). */
		artifactCounts: Record<string, StatusCounts>;
		openCount: number;
		lastActivity: number | null;
		upcomingFalsifiers: { path: string; date: string; daysAway: number; source?: 'project' }[];
		hasIndex: boolean;
		indexPath: string | null;
		/** projects-graph ADR-001 — null when un-labelled. */
		shape: ProjectShape | null;
		projectFalsifier: string | null;
		projectFalsifierDate: string | null;
		/** projects-graph ADR-011 — parent project slug (null for roots). */
		parentProject: string | null;
		/** projects-graph ADR-013 — root index.md tag list, drives cluster pill. */
		tags: string[];
		decisions?: DecisionRow[];
		/** projects-graph ADR-004 — descendant slugs reachable via parent_project. */
		descendantSlugs?: string[];
		/** projects-graph ADR-004 — statusCounts summed across self + descendants. */
		aggregateStatusCounts?: StatusCounts;
		/** projects-graph ADR-004 — per-type artifact buckets summed similarly. */
		aggregateArtifactCounts?: Record<string, StatusCounts>;
		/** projects-graph ADR-004 — child falsifiers tagged with source slug. */
		descendantFalsifiers?: {
			path: string;
			date: string;
			daysAway: number;
			source?: 'project';
			fromProject: string;
		}[];
		/** projects-graph ADR-004 — true when walker hit a cycle. */
		cycleDetected?: boolean;
		/** projects-graph ADR-004 — descendant rollups inlined when
		 *  ?includeChildren=true. Each carries its own decisions[]. */
		descendantRollups?: Array<{
			slug: string;
			decisions?: DecisionRow[];
		}>;
	}

	/** projects-graph ADR-003 — sum of every status bucket (including `other`).
	 *  Used to decide whether to render the type section at all. */
	// projects-graph ADR-017 P1 — status pill color for an individual artifact
	// row. Mirrors the aggregate pill palette used in the "Other artifacts"
	// rollup so a row reads the same as its type's summary.
	function artifactStatusClass(status: string | undefined): string {
		switch ((status ?? '').toLowerCase()) {
			case 'proposed':   return 'bg-hub-warning/15 text-hub-warning';
			case 'accepted':   return 'bg-hub-info/15 text-hub-info';
			case 'shipped':    return 'bg-hub-cta/15 text-hub-cta';
			case 'parked':     return 'bg-hub-dim/15 text-hub-dim';
			case 'superseded': return 'bg-hub-muted/15 text-hub-muted';
			case 'rejected':   return 'bg-hub-danger/15 text-hub-danger';
			default:           return 'bg-hub-dim/10 text-hub-dim border border-hub-warning/30';
		}
	}

	function totalForType(counts: StatusCounts | undefined): number {
		if (!counts) return 0;
		return counts.proposed + counts.accepted + counts.shipped + counts.rejected + counts.parked + counts.superseded + counts.other;
	}

	/** Render order for per-type sections. Decisions already render via the
	 *  primary grid + lists; this list controls only the secondary "Other
	 *  artifacts" surface, so `decision` is intentionally excluded. */
	const ARTIFACT_TYPE_ORDER = ['task', 'output', 'research', 'proposal', 'risk', 'metric', 'post', 'draft'] as const;

	/** Compact, neutral pill colour for each shape. Same hub-* tokens used
	 *  elsewhere; no new design tokens introduced. */
	function shapeClass(s: ProjectShape | null): string {
		switch (s) {
			case 'coding-spine':         return 'bg-hub-info/15 text-hub-info';
			case 'producer-pipeline':    return 'bg-hub-cta/15 text-hub-cta';
			case 'publishing-outlet':    return 'bg-hub-warning/15 text-hub-warning';
			case 'strategy-initiative':  return 'bg-hub-info/15 text-hub-info';
			case 'time-boxed-bet':       return 'bg-hub-danger/15 text-hub-danger';
			case 'maintained-system':    return 'bg-hub-muted/15 text-hub-muted';
			case 'parent':               return 'bg-hub-dim/15 text-hub-dim';
			default:                     return 'bg-hub-dim/15 text-hub-dim';
		}
	}

	let detail = $state<ProjectDetail | null>(null);
	let loading = $state(true);
	let error = $state('');
	let drawerPath = $state<string | null>(null);

	// projects-graph ADR-011 — breadcrumb + sibling switcher.
	// The full project list is fetched once on mount and used to derive the
	// sibling set client-side (32 projects ≈ sub-ms filter; no new endpoint).
	// projects-graph ADR-011 (sibling switcher) + ADR-023 (child panel) — the
	// shared row carried for both. The extra fields (shape/counts/falsifier)
	// power the ADR-023 child-projects cards; siblings ignore them.
	type SiblingRow = {
		slug: string;
		adrCount: number;
		parentProject: string | null;
		shape?: ProjectShape | null;
		openCount?: number;
		shippedCount?: number;
		falsifierDate?: string | null;
	};
	let allProjects = $state<SiblingRow[]>([]);
	let siblingsOpen = $state(false);

	let planExpanded = $state(false);
	let planHtml = $state('');
	let planLoaded = $state(false);
	let planLoading = $state(false);
	let planError = $state('');
	// projects-graph ADR-013 — once the operator manually collapses an
	// auto-expanded plan, persist it in localStorage so the auto-expand
	// effect doesn't re-fire on subsequent navigations to the same project.
	// The key is per-slug so different small projects each get their own
	// "I touched this" memory.
	let operatorTouched = $state(false);

	let timelineExpanded = $state(true);

	// project-phases P3: phase tree expansion state + next-actions cache.
	// Expanded decisions show their phase[] inline. The next-actions endpoint
	// is fetched separately so the "Next up" strip + phase counts work even
	// when individual decision rows are collapsed.
	let expandedDecisions = $state<Set<string>>(new Set());
	let nextActions = $state<NextActionsResponse | null>(null);

	// projects-graph ADR-017 P1 — artifact drill-in. "Other artifacts" cards
	// expand into a clickable list of the individual notes of that type,
	// lazy-fetched on first expand via /api/vault/notes?project=&type=.
	// Each row opens the existing AdrDrawer (type-agnostic read path), so
	// tasks / risks / metrics become readable, not just counted.
	type ArtifactRow = { path: string; title: string; status?: string };
	let expandedArtifactTypes = $state<Set<string>>(new Set());
	let artifactRows = $state<Record<string, ArtifactRow[]>>({});
	let artifactLoading = $state<Set<string>>(new Set());
	let artifactError = $state<Record<string, string>>({});

	// projects-graph ADR-018 S1 — Handoff Workbench. Lazily fetch the worklist
	// (five readiness lanes) the first time the ?view=work surface is shown.
	type WorklistLanes = Record<string, unknown[]>;
	let worklist = $state<WorklistLanes | null>(null);
	let worklistLoading = $state(false);
	let worklistError = $state('');
	let worklistLoaded = $state(false);

	async function loadWorklist() {
		if (worklistLoaded || worklistLoading) return;
		worklistLoading = true;
		worklistError = '';
		try {
			const res = await fetch(`/api/vault/projects/${encodeURIComponent(slug)}/worklist`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			worklist = data.lanes ?? null;
			worklistLoaded = true;
		} catch (e) {
			worklistError = e instanceof Error ? e.message : 'Failed to load worklist';
		} finally {
			worklistLoading = false;
		}
	}

	// Fetch the worklist the first time the operator switches to the Work view.
	$effect(() => {
		if (view === 'work') loadWorklist();
	});

	// `[slug]` route — params.slug is always present at runtime; SvelteKit
	// types it as string | undefined, so default to '' to keep it `string`.
	const slug = $derived($page.params.slug ?? '');
	const decisions = $derived(detail?.decisions ?? []);
	/** projects-graph ADR-016 — per-project ADR view mode. Network is the
	 *  default (vault-faithful Sugiyama DAG via dagre); `?view=gantt`
	 *  falls back to the legacy time-axis chart. The parent-rollup
	 *  table (one bar per project on a shared time axis) is unaffected —
	 *  it always renders as Gantt. */
	const view = $derived<'work' | 'network' | 'gantt'>(
		$page.url.searchParams.get('view') === 'gantt'
			? 'gantt'
			: $page.url.searchParams.get('view') === 'work'
				? 'work'
				: 'network',
	);
	const proposed = $derived(decisions.filter((d) => d.status === 'proposed'));
	const others = $derived(decisions.filter((d) => d.status !== 'proposed'));

	// projects-graph ADR-011 — sibling computation.
	// Siblings = other projects sharing the same parentProject. Sort by adrCount
	// desc so the operator sees the most-active siblings first.
	const siblings = $derived.by(() => {
		const parent = detail?.parentProject;
		if (!parent || allProjects.length === 0) return [];
		return allProjects
			.filter((p) => p.parentProject === parent && p.slug !== slug)
			.sort((a, b) => b.adrCount - a.adrCount);
	});

	// projects-graph ADR-023 — direct children of THIS project (the "down"
	// navigation ADR-011 never added). Reuses the allProjects fetch already
	// made for the sibling switcher — no extra request. Direct children only
	// (parent_project === this slug); grandchildren are reached by descending
	// one level at a time, mirroring how the breadcrumb walks one level up.
	const childProjects = $derived.by(() => {
		if (allProjects.length === 0) return [];
		return allProjects
			.filter((p) => p.parentProject === slug)
			.sort((a, b) => (b.adrCount ?? 0) - (a.adrCount ?? 0));
	});

	// projects-graph ADR-023 — an umbrella/parent reads its emptiness as a
	// feature, not a defect: suppress the "no ADRs yet — propose your first"
	// nudge and the "no decisions yet" placeholder for it.
	const isUmbrella = $derived(
		!!detail && (detail.shape === 'parent' || (detail.adrCount === 0 && childProjects.length > 0))
	);

	// projects-graph ADR-013 — cluster tag derivation.
	// Convention: `cluster:<slug>` tag on the project root index.md, set
	// during the soul-hub cluster backfill (ADR-038 Phase 1). The pill links
	// to `/projects?cluster=<slug>` which ADR-012 will respect; until then,
	// the unrecognized query param is harmless (list shows all).
	const clusterTag = $derived.by(() => {
		const tags = detail?.tags ?? [];
		const found = tags.find((t) => t.startsWith('cluster:'));
		return found ? found.slice('cluster:'.length) : null;
	});

	// projects-graph ADR-013 — last-shipped derivation from decision rows.
	// Picks the newest `shippedOn` across all decisions. Date-string sort works
	// because shippedOn is ISO YYYY-MM-DD. Returns null when no shipped ADRs.
	// Label is derived from path's basename (DecisionRow exposes path, not slug).
	const lastShipped = $derived.by(() => {
		const rows = detail?.decisions ?? [];
		let best: { date: string; label: string } | null = null;
		for (const d of rows) {
			if (!d.shippedOn) continue;
			if (!best || d.shippedOn > best.date) {
				const label = d.path.split('/').pop()?.replace(/\.md$/, '') ?? d.path;
				best = { date: d.shippedOn, label };
			}
		}
		return best;
	});

	// projects-graph ADR-013 — relative date helper for the last-shipped pill.
	// Caps at "yesterday" → "Nd ago" → "Nw ago" → "Nmo ago" → "Ny ago".
	function relativeDate(iso: string): string {
		const then = new Date(iso + 'T00:00:00').getTime();
		if (Number.isNaN(then)) return iso;
		const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
		if (days <= 0) return 'today';
		if (days === 1) return 'yesterday';
		if (days < 7) return `${days}d ago`;
		if (days < 30) return `${Math.floor(days / 7)}w ago`;
		if (days < 365) return `${Math.floor(days / 30)}mo ago`;
		return `${Math.floor(days / 365)}y ago`;
	}

	// Phase rollup across ADR-level (`adr-body`) phases only.
	// Project-roadmap phases were retired by project-phases ADR-013
	// (2026-05-18) — slug uniqueness on ADRs replaces the ordinal-keyed
	// roadmap channel that crashed Svelte hydration. Counts here drive
	// the small "shipped / open / blocked" strip; the canonical
	// per-status totals live in `detail.statusCounts` above.
	const phaseRollup = $derived.by(() => {
		const seen = new Set<string>();
		let shipped = 0;
		let open = 0;
		let blocked = 0;
		const blockedAdrPaths = new Set(
			(nextActions?.blocked ?? []).map((it) => it.id)
		);
		const tally = (p: Phase, adrPath: string) => {
			if (seen.has(p.id)) return;
			seen.add(p.id);
			if (p.status === 'shipped') shipped++;
			else if (p.status === 'proposed' || p.status === 'accepted') {
				if (blockedAdrPaths.has(adrPath)) blocked++;
				else open++;
			}
		};
		for (const d of decisions) {
			for (const p of d.phases ?? []) tally(p, d.path);
		}
		return { shipped, open, blocked, total: seen.size };
	});

	async function load() {
		error = '';
		loading = true;
		try {
			// projects-graph ADR-004 — request aggregate fields + descendant
			// rollups (with their own decisions) so the page can render the
			// rolled-up statusCounts + falsifiers AND the tree-Gantt when the
			// project has children. Pure additive — endpoint omits the
			// nested fields for leaves so no extra payload on solo projects.
			const res = await fetch(`/api/vault/projects?slug=${encodeURIComponent(slug)}&descendants=true&includeChildren=true`);
			if (!res.ok) throw new Error(`Project load: ${res.status}`);
			const data = await res.json();
			detail = (data.projects ?? [])[0] ?? null;
			// Reset plan preview state when slug changes
			planExpanded = false;
			planLoaded = false;
			planHtml = '';
			planError = '';
			expandedDecisions = new Set();
			// projects-graph ADR-013 — restore per-slug touched flag from
			// localStorage so a manual collapse persists across reloads.
			try {
				operatorTouched =
					typeof localStorage !== 'undefined' &&
					localStorage.getItem(`vault-projects-plan-touched-${slug}`) === '1';
			} catch {
				operatorTouched = false;
			}
			// Fire-and-forget next-actions fetch (separate state path so the
			// main page renders even if this endpoint is slow/fails).
			loadNextActions();
			// projects-graph ADR-011 — fire-and-forget full project list for
			// the sibling switcher. Reuses the same endpoint, no filter.
			loadAllProjects();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Load failed';
		} finally {
			loading = false;
		}
	}

	async function loadNextActions() {
		if (!slug) return;
		try {
			const res = await fetch(`/api/vault/projects/${encodeURIComponent(slug)}/next-actions`);
			if (!res.ok) {
				nextActions = null;
				return;
			}
			nextActions = await res.json();
		} catch {
			nextActions = null;
		}
	}

	function toggleDecisionExpand(path: string) {
		const next = new Set(expandedDecisions);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		expandedDecisions = next;
	}

	// projects-graph ADR-011 — sibling switcher data.
	async function loadAllProjects() {
		try {
			const res = await fetch('/api/vault/projects');
			if (!res.ok) return;
			const data = await res.json();
			allProjects = (data.projects ?? []).map(
				(p: {
					slug: string;
					adrCount: number;
					parentProject: string | null;
					shape?: ProjectShape | null;
					openCount?: number;
					statusCounts?: { shipped?: number };
					projectFalsifierDate?: string | null;
				}) => ({
					slug: p.slug,
					adrCount: p.adrCount,
					parentProject: p.parentProject,
					// projects-graph ADR-023 — child-card fields (unused by siblings).
					shape: p.shape ?? null,
					openCount: p.openCount ?? 0,
					shippedCount: p.statusCounts?.shipped ?? 0,
					falsifierDate: p.projectFalsifierDate ?? null
				})
			);
		} catch {
			// Sibling switcher is a nice-to-have; failing silently is acceptable.
			allProjects = [];
		}
	}

	// projects-graph ADR-011 — alt + ←/→ cycles through siblings by adrCount-desc order.
	// Falls back to no-op when there's no parent or no siblings. Browser default nav
	// keeps working when modifier isn't held.
	function onSiblingKey(e: KeyboardEvent) {
		if (!e.altKey) return;
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		if (siblings.length === 0) return;
		// Build the full cycle: [current, ...siblings]. Find current, step ±1, wrap.
		const cycle = [slug, ...siblings.map((s) => s.slug)];
		const idx = cycle.indexOf(slug);
		if (idx < 0) return;
		const step = e.key === 'ArrowRight' ? 1 : -1;
		const next = cycle[(idx + step + cycle.length) % cycle.length];
		if (next && next !== slug) {
			e.preventDefault();
			goto(`/projects/${encodeURIComponent(next)}`);
		}
	}

	function phaseStatusClass(status: PhaseStatus): string {
		if (status === 'shipped') return 'bg-hub-cta/15 text-hub-cta';
		if (status === 'accepted') return 'bg-hub-info/15 text-hub-info';
		if (status === 'proposed') return 'bg-hub-warning/15 text-hub-warning';
		if (status === 'parked') return 'bg-hub-dim/15 text-hub-dim';
		if (status === 'superseded') return 'bg-hub-muted/15 text-hub-muted line-through';
		if (status === 'rejected') return 'bg-hub-danger/15 text-hub-danger';
		return 'bg-hub-card text-hub-dim';
	}

	async function loadPlan() {
		if (!detail?.indexPath || planLoaded || planLoading) return;
		planLoading = true;
		planError = '';
		try {
			const res = await fetch(`/api/vault/notes/${detail.indexPath}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			planHtml = data.rendered ?? '';
			planLoaded = true;
		} catch (e) {
			planError = e instanceof Error ? e.message : 'Failed to load plan';
		} finally {
			planLoading = false;
		}
	}

	// projects-graph ADR-017 P1 — toggle a type's artifact list, lazy-fetching
	// the rows the first time it opens. Reassign the Set so Svelte 5 picks up
	// the change (mutation alone doesn't trigger $state).
	async function toggleArtifactType(type: string) {
		const next = new Set(expandedArtifactTypes);
		if (next.has(type)) {
			next.delete(type);
			expandedArtifactTypes = next;
			return;
		}
		next.add(type);
		expandedArtifactTypes = next;
		if (artifactRows[type] || artifactLoading.has(type)) return;
		const loading = new Set(artifactLoading);
		loading.add(type);
		artifactLoading = loading;
		try {
			const res = await fetch(
				`/api/vault/notes?project=${encodeURIComponent(slug)}&type=${encodeURIComponent(type)}&limit=100`,
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			const rows: ArtifactRow[] = (data.results ?? [])
				.filter((r: { path: string }) => !r.path.startsWith('archive/'))
				.map((r: { path: string; title?: string; status?: string }) => ({
					path: r.path,
					title: r.title || r.path.split('/').pop()?.replace(/\.md$/, '') || r.path,
					status: r.status,
				}));
			artifactRows = { ...artifactRows, [type]: rows };
		} catch (e) {
			artifactError = {
				...artifactError,
				[type]: e instanceof Error ? e.message : 'Failed to load',
			};
		} finally {
			const done = new Set(artifactLoading);
			done.delete(type);
			artifactLoading = done;
		}
	}

	function togglePlan() {
		planExpanded = !planExpanded;
		if (planExpanded && !planLoaded) loadPlan();
		// projects-graph ADR-013 — mark touched so auto-expand doesn't fight
		// the operator on subsequent visits. Persisted per-slug.
		operatorTouched = true;
		try {
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem(`vault-projects-plan-touched-${slug}`, '1');
			}
		} catch {
			// localStorage unavailable (SSR, private mode) — touched flag
			// stays in-memory only, which is fine for the current session.
		}
	}

	function handleTransition(info: { path: string; action: 'accept' | 'reject' | 'park' | 'ship'; newStatus: string }) {
		// Reload to refresh both the per-decision row AND the rollup counts.
		// Cheap on a single-project endpoint.
		load();
	}

	function timeAgoMs(ms: number | null): string {
		if (!ms) return '—';
		const diff = Date.now() - ms;
		const mins = Math.floor(diff / 60_000);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		return `${months}mo ago`;
	}

	function statusClass(status: string): string {
		if (status === 'proposed') return 'bg-hub-warning/15 text-hub-warning';
		if (status === 'accepted') return 'bg-hub-info/15 text-hub-info';
		if (status === 'shipped') return 'bg-hub-cta/15 text-hub-cta';
		if (status === 'rejected') return 'bg-hub-danger/15 text-hub-danger';
		if (status === 'parked') return 'bg-hub-dim/15 text-hub-dim';
		if (status === 'superseded') return 'bg-hub-muted/15 text-hub-muted line-through';
		return 'bg-hub-card text-hub-dim';
	}

	function falsifierClass(daysAway: number | null): string {
		if (daysAway === null) return 'text-hub-dim';
		if (daysAway <= 7) return 'text-hub-danger';
		if (daysAway <= 30) return 'text-hub-warning';
		return 'text-hub-dim';
	}

	/** Human-readable explanation of why a date is coloured the way it is.
	 *  Surfaces as a `title` attribute on falsifier badges + dates so the
	 *  reader can hover to learn the threshold without us having to print
	 *  the legend everywhere. Same buckets as `falsifierClass` and the
	 *  Gantt's `falsifierFill` — single source of truth in spec, even
	 *  though the function lives in three places (one per consumer). */
	function falsifierMeaning(daysAway: number | null): string {
		if (daysAway === null) return 'No falsifier date set';
		if (daysAway < 0) return `Overdue by ${Math.abs(daysAway)}d — review past due`;
		if (daysAway <= 7) return `Due within 7 days — urgent review`;
		if (daysAway <= 30) return `Due within 30 days — review soon`;
		return `>30 days away — on track`;
	}

	$effect(() => { if (slug) load(); });

	// projects-graph ADR-013 — auto-expand Plan widget when the project is
	// small (< 5 ADRs) and the operator hasn't manually collapsed it before.
	// $effect runs whenever its dependencies change; we guard so the expand
	// fires once per slug-load, not on every state tick. `loadPlan()` is
	// idempotent (early-returns when already loaded/loading).
	$effect(() => {
		if (!detail) return;
		if (planExpanded) return;
		if (operatorTouched) return;
		if (detail.adrCount >= 5) return;
		planExpanded = true;
		loadPlan();
	});
</script>

<svelte:head>
	<title>{slug} | Projects | Soul Hub</title>
</svelte:head>

<!-- projects-graph ADR-011 — Alt + ←/→ cycles to prev/next sibling. -->
<svelte:window onkeydown={onSiblingKey} />

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto">
			<div class="flex items-center gap-3 mb-2">
				<!-- projects-graph ADR-011 — breadcrumb when project has a parent;
				     otherwise the existing back-arrow icon. -->
				{#if detail?.parentProject}
					<nav class="flex items-center gap-1.5 text-sm text-hub-muted min-w-0" aria-label="Breadcrumb">
						<a href="/projects" class="hover:text-hub-text transition-colors" title="All projects">
							<svg class="w-4 h-4 inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
							</svg>
						</a>
						<span class="text-hub-dim" aria-hidden="true">/</span>
						<a
							href="/projects/{detail.parentProject}"
							class="hover:text-hub-text transition-colors truncate"
							title="Parent project: {detail.parentProject}"
						>
							{detail.parentProject}
						</a>
						<span class="text-hub-dim" aria-hidden="true">/</span>
					</nav>
				{:else}
					<a href="/projects" class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text" aria-label="Back to projects">
						<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
						</svg>
					</a>
				{/if}
				<h1 class="text-lg font-semibold text-hub-text truncate">{slug}</h1>
				{#if detail?.shape}
					<span
						class="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 {shapeClass(detail.shape)}"
						title="Project shape (projects-graph ADR-001)"
					>
						{detail.shape}
					</span>
				{:else if detail}
					<span
						class="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-hub-warning/10 text-hub-warning border border-hub-warning/30"
						title={"No project_shape set — add via `soul project label-shape " + slug + " <shape>` (projects-graph ADR-001)"}
					>
						no shape
					</span>
				{/if}
				{#if detail}
					<span class="text-hub-dim text-sm flex-shrink-0">{detail.adrCount} ADR{detail.adrCount === 1 ? '' : 's'} · {detail.noteCount} note{detail.noteCount === 1 ? '' : 's'}</span>
				{/if}

				<!-- projects-graph ADR-013 — cluster pill (links to /projects?cluster=<x>
				     which ADR-012's list-page filter will respect). Hidden when project's
				     root index.md doesn't carry a `cluster:` tag. -->
				{#if clusterTag}
					<a
						href="/projects?cluster={encodeURIComponent(clusterTag)}"
						class="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-hub-card text-hub-muted hover:bg-hub-bg hover:text-hub-text transition-colors border border-hub-border"
						title="Filter /projects to cluster:{clusterTag}"
					>
						cluster:{clusterTag}
					</a>
				{/if}

				<!-- projects-graph ADR-013 — last-shipped slot. Computed from
				     detail.decisions[]; hidden when no shipped ADRs. -->
				{#if lastShipped}
					<span
						class="text-hub-dim text-xs flex-shrink-0"
						title="{lastShipped.label} on {lastShipped.date}"
					>
						last shipped {relativeDate(lastShipped.date)}
					</span>
				{/if}

				<!-- projects-graph ADR-011 — sibling switcher.
				     Renders only when the project has ≥1 sibling under the same parent.
				     Uses <details> for built-in keyboard accessibility (Enter/Space toggles,
				     focus traps follow native semantics). Alt+←/→ global cycle is wired
				     separately via onSiblingKey on the window. -->
				{#if siblings.length > 0}
					<details
						class="ml-auto relative flex-shrink-0"
						bind:open={siblingsOpen}
					>
						<summary
							class="cursor-pointer list-none px-2 py-1 rounded text-xs text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors"
							title="Alt + ←/→ cycles siblings"
						>
							{siblings.length} sibling{siblings.length === 1 ? '' : 's'} ▾
						</summary>
						<ul
							class="absolute right-0 top-full mt-1 z-20 w-64 max-h-80 overflow-y-auto bg-hub-card border border-hub-border rounded-lg shadow-lg py-1 text-sm"
						>
							{#each siblings as sib (sib.slug)}
								<li>
									<a
										href="/projects/{sib.slug}"
										class="flex items-center justify-between gap-3 px-3 py-1.5 hover:bg-hub-bg transition-colors"
										onclick={() => (siblingsOpen = false)}
									>
										<span class="text-hub-text truncate">{sib.slug}</span>
										<span class="text-hub-dim text-xs flex-shrink-0">{sib.adrCount} ADR{sib.adrCount === 1 ? '' : 's'}</span>
									</a>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</div>
		</div>
	</header>

	<!-- Main -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading…</div>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger">
					{error}
				</div>
			{:else if !detail}
				<div class="flex flex-col items-center justify-center py-20">
					<p class="text-hub-muted text-sm mb-1">Project not found in vault</p>
					<p class="text-hub-dim text-xs">No folder at <code class="font-mono">~/vault/projects/{slug}/</code>.</p>
				</div>
			{:else}
				<!-- Stat cards. Superseded + Rejected only render when non-zero
				     to keep the row tight for the common case. -->
				<div class="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-6 gap-2 mb-6">
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Proposed</div>
						<div class="text-lg font-semibold text-hub-warning">{detail.statusCounts.proposed}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Accepted</div>
						<div class="text-lg font-semibold text-hub-info">{detail.statusCounts.accepted}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Shipped</div>
						<div class="text-lg font-semibold text-hub-cta">{detail.statusCounts.shipped}</div>
					</div>
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Parked</div>
						<div class="text-lg font-semibold text-hub-dim">{detail.statusCounts.parked}</div>
					</div>
					{#if detail.statusCounts.superseded > 0}
						<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
							<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Superseded</div>
							<div class="text-lg font-semibold text-hub-muted">{detail.statusCounts.superseded}</div>
						</div>
					{/if}
					{#if detail.statusCounts.rejected > 0}
						<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
							<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Rejected</div>
							<div class="text-lg font-semibold text-hub-danger">{detail.statusCounts.rejected}</div>
						</div>
					{/if}
					{#if phaseRollup.total > 0}
						<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border" title="From phase-parser across all ADRs in this project (project-phases ADR-001)">
							<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Phases</div>
							<div class="text-sm font-medium text-hub-text">
								<span class="text-hub-cta">{phaseRollup.shipped}</span>
								<span class="text-hub-dim">/</span>
								<span class="text-hub-warning">{phaseRollup.open}</span>
								{#if phaseRollup.blocked > 0}<span class="text-hub-dim">/</span><span class="text-hub-danger">{phaseRollup.blocked}</span>{/if}
							</div>
							<div class="text-[10px] text-hub-dim mt-0.5">
								shipped / open{phaseRollup.blocked > 0 ? ' / blocked' : ''}
							</div>
						</div>
					{/if}
					<div class="p-3 rounded-lg bg-hub-card/40 border border-hub-border">
						<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Last activity</div>
						<div class="text-sm font-medium text-hub-text">{timeAgoMs(detail.lastActivity)}</div>
					</div>
				</div>

				<!-- projects-graph ADR-004 — parent-rollup aggregate grid.
				     Renders only when the project has descendants. Mirrors the
				     per-project grid above but sums across self + all
				     parent_project descendants. Shipped count uses hub-cta
				     accent so the rolled-up scope reads at a glance. -->
				{#if detail.descendantSlugs && detail.descendantSlugs.length > 0 && detail.aggregateStatusCounts}
					{@const agg = detail.aggregateStatusCounts}
					{@const aggTotal = agg.proposed + agg.accepted + agg.shipped + agg.parked + agg.rejected + agg.superseded}
					<div class="mb-6">
						<div class="flex items-center gap-2 mb-2">
							<span class="text-[10px] uppercase tracking-wider text-hub-info font-semibold">Aggregate</span>
							<span class="text-[11px] text-hub-dim">across {detail.descendantSlugs.length} descendant{detail.descendantSlugs.length === 1 ? '' : 's'} · {aggTotal} total</span>
							{#if detail.cycleDetected}
								<span
									class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-warning/15 text-hub-warning border border-hub-warning/30"
									title="A parent_project cycle was hit during the walk — partial result"
								>
									cycle hit
								</span>
							{/if}
						</div>
						<div class="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-6 gap-2">
							<div class="p-3 rounded-lg bg-hub-info/5 border border-hub-info/30">
								<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Proposed</div>
								<div class="text-lg font-semibold text-hub-warning">{agg.proposed}</div>
							</div>
							<div class="p-3 rounded-lg bg-hub-info/5 border border-hub-info/30">
								<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Accepted</div>
								<div class="text-lg font-semibold text-hub-info">{agg.accepted}</div>
							</div>
							<div class="p-3 rounded-lg bg-hub-info/5 border border-hub-info/30">
								<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Shipped</div>
								<div class="text-lg font-semibold text-hub-cta">{agg.shipped}</div>
							</div>
							<div class="p-3 rounded-lg bg-hub-info/5 border border-hub-info/30">
								<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Parked</div>
								<div class="text-lg font-semibold text-hub-dim">{agg.parked}</div>
							</div>
							{#if agg.superseded > 0}
								<div class="p-3 rounded-lg bg-hub-info/5 border border-hub-info/30">
									<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Superseded</div>
									<div class="text-lg font-semibold text-hub-muted">{agg.superseded}</div>
								</div>
							{/if}
							{#if agg.rejected > 0}
								<div class="p-3 rounded-lg bg-hub-info/5 border border-hub-info/30">
									<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Rejected</div>
									<div class="text-lg font-semibold text-hub-danger">{agg.rejected}</div>
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- projects-graph ADR-023 — child-projects navigation panel.
				     Renders the direct children as clickable cards so a parent/
				     umbrella can be navigated DOWN, completing ADR-011's up
				     (breadcrumb) + sideways (sibling switcher) navigation. Gated
				     on having children, so leaf projects are unaffected. -->
				{#if childProjects.length > 0}
					<div class="mb-6">
						<div class="flex items-center gap-2 mb-2">
							<span class="text-[10px] uppercase tracking-wider text-hub-info font-semibold">Child projects</span>
							<span class="text-[11px] text-hub-dim">{childProjects.length}</span>
						</div>
						<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
							{#each childProjects as child (child.slug)}
								<a
									href="/projects/{child.slug}"
									class="p-3 rounded-lg border border-hub-border bg-hub-card/40 hover:bg-hub-card hover:border-hub-info/40 transition-colors flex flex-col gap-1.5"
								>
									<div class="flex items-center gap-2">
										<span class="text-sm font-medium text-hub-text truncate flex-1 min-w-0">{child.slug}</span>
										{#if child.shape}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 {shapeClass(child.shape)}">{child.shape}</span>
										{/if}
									</div>
									<div class="flex items-center gap-2 text-[11px] text-hub-dim">
										<span>{child.openCount ?? 0} open</span>
										<span class="text-hub-cta">{child.shippedCount ?? 0} shipped</span>
										{#if child.falsifierDate}
											<span class="text-hub-warning ml-auto" title="project falsifier">⏱ {child.falsifierDate}</span>
										{/if}
									</div>
								</a>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Next up strip — surfaces the highest-priority open ADR
				     (proposed, then accepted, oldest first; demotes ADRs whose
				     blocked_by deps aren't all shipped). Per project-phases
				     ADR-013 (2026-05-18): ranks ADRs directly rather than
				     phase ordinals. Clicking jumps into the ADR drawer. -->
				{#if nextActions?.next}
					<button
						onclick={() => drawerPath = nextActions!.next!.id}
						class="w-full mb-6 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5 hover:bg-hub-info/10 transition-colors flex items-center gap-3 flex-wrap text-left cursor-pointer"
					>
						<span class="text-[10px] uppercase tracking-wider text-hub-info font-semibold">Next up</span>
						<span class="text-[10px] px-1.5 py-0.5 rounded {phaseStatusClass(nextActions.next.status)} flex-shrink-0">
							{nextActions.next.status}
						</span>
						<span class="text-[11px] font-mono text-hub-dim flex-shrink-0">{nextActions.next.slug}</span>
						<span class="text-sm font-medium text-hub-text truncate flex-1 min-w-0">{nextActions.next.label}</span>
						{#if nextActions.next.target_date}
							<span class="text-[11px] text-hub-info flex-shrink-0" title="target ship date">→ {nextActions.next.target_date}</span>
						{/if}
						{#if nextActions.next.falsifier_date}
							<span class="text-[11px] text-hub-warning flex-shrink-0" title="falsifier date">⏱ {nextActions.next.falsifier_date}</span>
						{/if}
					</button>
				{:else if nextActions?.hint === 'no_adrs'}
					<!-- projects-graph ADR-023 — shape-aware empty state. An umbrella
					     having no own ADRs is expected (its value is the rollup), so
					     it shouldn't read like a broken/abandoned leaf. -->
					{#if isUmbrella}
						<div class="mb-6 p-3 rounded-lg border border-hub-border bg-hub-card/40 text-xs text-hub-dim">
							<span class="font-semibold text-hub-text">Umbrella project.</span>
							Progress rolls up from its children — this node isn't meant to hold its own ADRs.
						</div>
					{:else}
						<div class="mb-6 p-3 rounded-lg border border-hub-border bg-hub-card/40 text-xs text-hub-dim">
							<span class="font-semibold text-hub-text">No ADRs yet.</span>
							Propose your first via <code class="font-mono text-hub-info">soul adr propose</code>.
						</div>
					{/if}
				{/if}

				<!-- Plan / index.md preview -->
				{#if detail.indexPath}
					<section class="mb-6 border border-hub-border rounded-lg bg-hub-card/40 overflow-hidden">
						<div class="w-full flex items-center justify-between px-4 py-3 hover:bg-hub-card/60 transition-colors">
							<button
								onclick={togglePlan}
								class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer text-left"
								aria-expanded={planExpanded}
							>
								<svg class="w-4 h-4 text-hub-dim transition-transform" style:transform={planExpanded ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="9 18 15 12 9 6"/>
								</svg>
								<span class="text-sm font-medium text-hub-text">Plan</span>
								<span class="text-[11px] font-mono text-hub-dim truncate">{detail.indexPath}</span>
							</button>
							<button
								onclick={() => drawerPath = detail!.indexPath}
								class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer px-2 py-1 rounded hover:bg-hub-card flex-shrink-0 ml-2"
							>
								Open viewer →
							</button>
						</div>
						{#if planExpanded}
							<div class="px-4 pb-4 border-t border-hub-border">
								{#if planLoading}
									<p class="text-xs text-hub-muted py-3">Loading plan…</p>
								{:else if planError}
									<p class="text-xs text-hub-danger py-3">{planError}</p>
								{:else if planHtml}
									<div class="pt-3">
										<RenderedMarkdown html={planHtml} />
									</div>
								{:else}
									<p class="text-xs text-hub-dim py-3">Plan is empty.</p>
								{/if}
							</div>
						{/if}
					</section>
				{/if}

				<!-- Decision view — ADR-004 parent-rollup + ADR-016 per-project
				     view-mode toggle. The section title flips with the active
				     view ("Network" by default, "Timeline" when `?view=gantt`)
				     so the operator can read the URL state from the heading. -->
				{#if decisions.length > 0}
					<section class="mb-6 border border-hub-border rounded-lg bg-hub-card/40 overflow-hidden">
						<div class="w-full flex items-center gap-2 px-4 py-3">
							<button
								onclick={() => (timelineExpanded = !timelineExpanded)}
								class="flex items-center gap-2 hover:opacity-80 transition-opacity text-left cursor-pointer flex-1"
								aria-expanded={timelineExpanded}
							>
								<svg class="w-4 h-4 text-hub-dim transition-transform" style:transform={timelineExpanded ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="9 18 15 12 9 6"/>
								</svg>
								<span class="text-sm font-medium text-hub-text">
									{view === 'gantt' ? 'Timeline' : view === 'work' ? 'Workbench' : 'Network'}
								</span>
								<span class="text-[11px] text-hub-dim">{decisions.length} ADR{decisions.length === 1 ? '' : 's'}</span>
							</button>
							<!-- ADR-016 view toggle + ADR-018 Work view. Anchor-driven so
							     operators can bookmark or share any view. Default = network. -->
							<nav class="flex items-center gap-0.5 text-[11px] rounded-md border border-hub-border bg-hub-bg/40 p-0.5" aria-label="View mode">
								<a
									href="?view=work"
									class="px-2 py-0.5 rounded transition-colors {view === 'work' ? 'bg-hub-card text-hub-text' : 'text-hub-dim hover:text-hub-text'}"
									aria-current={view === 'work' ? 'page' : undefined}
								>Work</a>
								<a
									href="?view=network"
									class="px-2 py-0.5 rounded transition-colors {view === 'network' ? 'bg-hub-card text-hub-text' : 'text-hub-dim hover:text-hub-text'}"
									aria-current={view === 'network' ? 'page' : undefined}
								>Network</a>
								<a
									href="?view=gantt"
									class="px-2 py-0.5 rounded transition-colors {view === 'gantt' ? 'bg-hub-card text-hub-text' : 'text-hub-dim hover:text-hub-text'}"
									aria-current={view === 'gantt' ? 'page' : undefined}
								>Timeline</a>
							</nav>
						</div>
						{#if timelineExpanded}
							<div class="px-4 pb-4 border-t border-hub-border">
								<div class="pt-3">
									{#if view === 'work'}
										<WorkbenchLanes
											lanes={worklist}
											loading={worklistLoading}
											error={worklistError}
											onSelect={(p) => (drawerPath = p)}
										/>
									{:else}
										<ProjectTreeGantt
											rootSlug={slug}
											rootDecisions={decisions}
											descendants={detail.descendantRollups ?? []}
											onSelect={(p) => (drawerPath = p)}
											{view}
										/>
									{/if}
								</div>
							</div>
						{/if}
					</section>
				{/if}

				<!-- Project roadmap widget removed per project-phases ADR-013
				     (2026-05-18). Operators read the `## Roadmap` narrative via
				     the Plan section above, which renders index.md as markdown.
				     Dynamic phase status now sources from ADR frontmatter
				     (statusCounts grid + AdrGantt + Next up). -->

				<!-- Falsifier alerts -->
				{#if detail.upcomingFalsifiers.length > 0}
					<div class="mb-6 p-3 rounded-lg border border-hub-warning/30 bg-hub-warning/5">
						<div class="flex items-center justify-between gap-3 mb-2 flex-wrap">
							<div class="text-xs font-medium text-hub-warning">Upcoming falsifier dates</div>
							<!-- Urgency legend. Same thresholds as falsifierClass() and
							     AdrGantt.falsifierFill(). Hover any date row for the
							     exact meaning. -->
							<div class="flex items-center gap-3 text-[10px] text-hub-dim">
								<span class="inline-flex items-center gap-1" title="≤7 days — urgent review">
									<span class="w-1.5 h-1.5 rounded-full bg-hub-danger"></span>≤7d
								</span>
								<span class="inline-flex items-center gap-1" title="≤30 days — review soon">
									<span class="w-1.5 h-1.5 rounded-full bg-hub-warning"></span>≤30d
								</span>
								<span class="inline-flex items-center gap-1" title=">30 days — on track">
									<span class="w-1.5 h-1.5 rounded-full bg-hub-dim/60"></span>&gt;30d
								</span>
							</div>
						</div>
						<div class="space-y-1">
							{#each detail.upcomingFalsifiers as f}
								{#if f.source === 'project'}
									<!-- projects-graph ADR-001 — project-level falsifier
									     row. Renders the prose claim from project_falsifier
									     alongside the date instead of a filename, so the
									     operator sees WHAT failed without drilling in. -->
									<div
										class="flex items-center justify-between text-xs px-1 py-0.5 rounded border border-hub-warning/30 bg-hub-warning/5"
										title={falsifierMeaning(f.daysAway)}
									>
										<div class="flex items-center gap-2 min-w-0">
											<span class="px-1 py-0 rounded text-[9px] uppercase tracking-wider bg-hub-warning/15 text-hub-warning flex-shrink-0">project</span>
											<span class="text-hub-text truncate" title={detail.projectFalsifier ?? ''}>
												{detail.projectFalsifier ?? '(project-level falsifier)'}
											</span>
										</div>
										<span class="{falsifierClass(f.daysAway)} ml-2 flex-shrink-0">⏱ {f.daysAway}d ({f.date})</span>
									</div>
								{:else}
									<button
										onclick={() => drawerPath = f.path}
										class="w-full flex items-center justify-between text-xs hover:bg-hub-card/60 px-1 py-0.5 rounded transition-colors cursor-pointer text-left"
										title={falsifierMeaning(f.daysAway)}
									>
										<span class="font-mono text-hub-text truncate">{f.path.split('/').pop()}</span>
										<span class="{falsifierClass(f.daysAway)} ml-2 flex-shrink-0">⏱ {f.daysAway}d ({f.date})</span>
									</button>
								{/if}
							{/each}
						</div>
					</div>
				{/if}

				<!-- projects-graph ADR-004 — descendant falsifier rollup.
				     Rendered only when the project has at least one descendant
				     with an upcoming falsifier. Each row tags its source slug
				     so the operator can navigate without losing context. -->
				{#if detail.descendantFalsifiers && detail.descendantFalsifiers.length > 0}
					<div class="mb-6 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5">
						<div class="flex items-center justify-between gap-3 mb-2 flex-wrap">
							<div class="text-xs font-medium text-hub-info">
								Descendant falsifiers
								<span class="text-hub-dim font-normal ml-1">({detail.descendantFalsifiers.length} across descendants)</span>
							</div>
						</div>
						<div class="space-y-1">
							{#each detail.descendantFalsifiers as f}
								<button
									onclick={() => drawerPath = f.path}
									class="w-full flex items-center justify-between text-xs hover:bg-hub-card/60 px-1 py-0.5 rounded transition-colors cursor-pointer text-left"
									title={falsifierMeaning(f.daysAway)}
								>
									<div class="flex items-center gap-2 min-w-0">
										<span class="px-1 py-0 rounded text-[9px] uppercase tracking-wider bg-hub-info/15 text-hub-info flex-shrink-0">{f.fromProject}</span>
										<span class="font-mono text-hub-text truncate">{f.path.split('/').pop()}</span>
									</div>
									<span class="{falsifierClass(f.daysAway)} ml-2 flex-shrink-0">⏱ {f.daysAway}d ({f.date})</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Assumption-rate audits (project-phases ADR-008 S4) — silent on empty corpus.
				     projects-graph ADR-004 — pass descendant slugs so parent pages
				     surface high-severity claims from any child. -->
				<AssumptionAuditPanel {slug} descendantSlugs={detail.descendantSlugs ?? []} />

				<!-- AI proposals (project-phases ADR-005 S3) — silent on empty corpus -->
				<ProposalsPanel {slug} />

				<!-- Awaiting decision (proposed) -->
				{#if proposed.length > 0}
					<section class="mb-6">
						<div class="mb-3 flex items-center justify-between">
							<h2 class="text-sm font-semibold text-hub-warning">
								Awaiting decision ({proposed.length})
							</h2>
							<a href="/projects/queue" class="text-xs text-hub-info hover:text-hub-text transition-colors cursor-pointer">View full queue →</a>
						</div>
						<div class="space-y-3">
							{#each proposed as d (d.path)}
								<div class="border border-hub-warning/25 rounded-lg bg-hub-warning/5 p-4">
									<div class="flex items-start justify-between gap-3 mb-2">
										{#if d.phases && d.phases.length > 0}
											<button
												onclick={() => toggleDecisionExpand(d.path)}
												class="flex-shrink-0 self-start p-1 -ml-1 rounded hover:bg-hub-card/60 cursor-pointer"
												aria-label="Toggle phases"
												aria-expanded={expandedDecisions.has(d.path)}
											>
												<svg class="w-3.5 h-3.5 text-hub-dim transition-transform" style:transform={expandedDecisions.has(d.path) ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<polyline points="9 18 15 12 9 6"/>
												</svg>
											</button>
										{/if}
										<button
											onclick={() => drawerPath = d.path}
											class="min-w-0 flex-1 text-left cursor-pointer group"
										>
											<div class="flex items-center gap-2 text-[11px] text-hub-dim mb-1">
												{#if d.created}<span>{d.created}</span>{/if}
												{#if d.falsifierDate && d.falsifierDaysAway !== null}
													<span>·</span>
													<span class={falsifierClass(d.falsifierDaysAway)}>
														⏱ {d.falsifierDaysAway}d → {d.falsifierDate}
													</span>
												{/if}
												{#if d.blockedBy.length > 0}
													<span>·</span>
													<span class="text-hub-warning">blocked by {d.blockedBy.length}</span>
												{/if}
											</div>
											<h3 class="text-sm font-semibold text-hub-text group-hover:text-hub-info transition-colors">
												{d.title}
											</h3>
											<p class="text-[11px] text-hub-dim font-mono truncate mt-1">{d.path}</p>
										</button>
										<DecisionActions path={d.path} size="md" onTransition={handleTransition} />
									</div>
									{#if d.tags.length > 0}
										<div class="flex flex-wrap items-center gap-1 mt-2">
											{#each d.tags.slice(0, 6) as tag}
												<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim">{tag}</span>
											{/each}
										</div>
									{/if}
									{#if expandedDecisions.has(d.path) && d.phases && d.phases.length > 0}
										<div class="mt-3 pt-3 border-t border-hub-warning/20 space-y-1">
											{#each d.phases as p (p.id)}
												<div class="flex items-center gap-2 text-xs py-0.5" title={p.raw_marker}>
													<span class="text-[10px] px-1.5 py-0.5 rounded {phaseStatusClass(p.status)} flex-shrink-0 min-w-[60px] text-center">{p.status}</span>
													<span class="font-medium text-hub-text flex-shrink-0">{p.label}</span>
													{#if p.scope}<span class="text-hub-dim truncate min-w-0">{p.scope}</span>{/if}
													{#if p.shipped_at}<span class="text-hub-cta text-[10px] flex-shrink-0">✓ {p.shipped_at}</span>{/if}
													{#if p.target_date && !p.shipped_at}<span class="text-hub-info text-[10px] flex-shrink-0">→ {p.target_date}</span>{/if}
													{#if p.commit}<span class="text-hub-dim font-mono text-[10px] flex-shrink-0">{p.commit.slice(0, 7)}</span>{/if}
												</div>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<!-- All other decisions -->
				<section>
					<div class="mb-3 flex items-center justify-between">
						<h2 class="text-sm font-semibold text-hub-text">
							{proposed.length > 0 ? 'Other decisions' : 'Decisions'} ({others.length})
						</h2>
						{#if proposed.length === 0}
							<a href="/projects/queue" class="text-xs text-hub-info hover:text-hub-text transition-colors cursor-pointer">View queue →</a>
						{/if}
					</div>

					{#if others.length === 0 && proposed.length === 0}
						<!-- projects-graph ADR-023 — umbrellas point at their children
						     instead of reading as an empty decision stream. -->
						{#if isUmbrella}
							<p class="text-hub-dim text-xs py-6 text-center">Umbrella project — see the child projects above.</p>
						{:else}
							<p class="text-hub-dim text-xs py-6 text-center">No decisions yet for this project.</p>
						{/if}
					{:else if others.length === 0}
						<p class="text-hub-dim text-xs py-3 text-center">All other decisions cleared.</p>
					{:else}
						<div class="divide-y divide-hub-border/60 border border-hub-border rounded-lg bg-hub-card/40">
							{#each others as d (d.path)}
								<div>
									<div class="flex items-stretch hover:bg-hub-card/60 transition-colors">
										{#if d.phases && d.phases.length > 0}
											<button
												onclick={() => toggleDecisionExpand(d.path)}
												class="flex items-center justify-center px-3 cursor-pointer hover:bg-hub-card/80 transition-colors"
												aria-label="Toggle phases"
												aria-expanded={expandedDecisions.has(d.path)}
											>
												<svg class="w-3.5 h-3.5 text-hub-dim transition-transform" style:transform={expandedDecisions.has(d.path) ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<polyline points="9 18 15 12 9 6"/>
												</svg>
											</button>
										{:else}
											<div class="w-10 flex-shrink-0"></div>
										{/if}
										<button
											onclick={() => drawerPath = d.path}
											class="flex-1 min-w-0 px-4 py-3 text-left cursor-pointer"
										>
											<div class="flex items-center gap-2 min-w-0">
												{#if d.status}
													<span class="text-[10px] px-1.5 py-0.5 rounded {statusClass(d.status)} flex-shrink-0">
														{d.status}
													</span>
												{/if}
												<span class="text-sm font-medium text-hub-text truncate flex-1">
													{d.title}
												</span>
												{#if d.phases && d.phases.length > 0}
													<span class="text-[10px] text-hub-dim flex-shrink-0">{d.phases.filter(p => p.status === 'shipped').length}/{d.phases.length} ph</span>
												{/if}
												{#if d.tags.length > 0}
													<div class="flex items-center gap-1 flex-shrink-0">
														{#each d.tags.slice(0, 3) as tag}
															<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim">{tag}</span>
														{/each}
													</div>
												{/if}
											</div>
											<div class="text-[11px] text-hub-dim font-mono truncate mt-0.5">
												{d.path}
												{#if d.created}<span class="ml-2">· {d.created}</span>{/if}
											</div>
										</button>
									</div>
									{#if expandedDecisions.has(d.path) && d.phases && d.phases.length > 0}
										<div class="px-4 pb-3 pt-1 ml-10 space-y-1 border-t border-hub-border/40">
											{#each d.phases as p (p.id)}
												<div class="flex items-center gap-2 text-xs py-0.5" title={p.raw_marker}>
													<span class="text-[10px] px-1.5 py-0.5 rounded {phaseStatusClass(p.status)} flex-shrink-0 min-w-[60px] text-center">{p.status}</span>
													<span class="font-medium text-hub-text flex-shrink-0">{p.label}</span>
													{#if p.scope}<span class="text-hub-dim truncate min-w-0">{p.scope}</span>{/if}
													{#if p.shipped_at}<span class="text-hub-cta text-[10px] flex-shrink-0">✓ {p.shipped_at}</span>{/if}
													{#if p.target_date && !p.shipped_at}<span class="text-hub-info text-[10px] flex-shrink-0">→ {p.target_date}</span>{/if}
													{#if p.commit}<span class="text-hub-dim font-mono text-[10px] flex-shrink-0">{p.commit.slice(0, 7)}</span>{/if}
												</div>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<!-- projects-graph ADR-003 — per-type artifact rollup. Renders
				     a small status-counts grid per non-decision type with at
				     least one note. Decisions stay in the dedicated section
				     above (they already get a full per-row treatment). The
				     order follows ARTIFACT_TYPE_ORDER; any type the project
				     uses outside that order falls through to a tail block. -->
				{@const otherTypes = Object.entries(detail.artifactCounts ?? {})
					.filter(([t, c]) => t !== 'decision' && t !== 'index' && totalForType(c) > 0)
					.sort(([a], [b]) => {
						const ai = ARTIFACT_TYPE_ORDER.indexOf(a as any);
						const bi = ARTIFACT_TYPE_ORDER.indexOf(b as any);
						const aWeight = ai === -1 ? 100 : ai;
						const bWeight = bi === -1 ? 100 : bi;
						if (aWeight !== bWeight) return aWeight - bWeight;
						return a.localeCompare(b);
					})}
				{#if otherTypes.length > 0}
					<section class="mt-8">
						<div class="mb-3 flex items-center justify-between">
							<h2 class="text-sm font-semibold text-hub-text">
								Other artifacts
								<span class="ml-1 text-[11px] font-normal text-hub-dim">({otherTypes.length} type{otherTypes.length === 1 ? '' : 's'})</span>
							</h2>
							<span class="text-[10px] text-hub-dim" title="projects-graph ADR-003">per-type rollup</span>
						</div>
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
							{#each otherTypes as [type, c] (type)}
								<div class="p-3 rounded-lg border border-hub-border bg-hub-card/40">
									<!-- projects-graph ADR-017 P1 — header toggles a lazy-loaded list of this type's notes. -->
									<button type="button" class="w-full flex items-center justify-between mb-2 cursor-pointer group" onclick={() => toggleArtifactType(type)} aria-expanded={expandedArtifactTypes.has(type)}>
										<span class="flex items-center gap-1.5">
											<svg class="w-3 h-3 text-hub-dim transition-transform {expandedArtifactTypes.has(type) ? 'rotate-90' : ''}" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
											<span class="text-xs font-mono uppercase tracking-wider text-hub-text group-hover:text-hub-cta transition-colors">{type}</span>
										</span>
										<span class="text-[10px] text-hub-dim">{totalForType(c)} total</span>
									</button>
									<div class="flex flex-wrap items-center gap-1">
										{#if c.proposed > 0}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-warning/15 text-hub-warning">{c.proposed} proposed</span>
										{/if}
										{#if c.accepted > 0}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-info/15 text-hub-info">{c.accepted} accepted</span>
										{/if}
										{#if c.shipped > 0}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-cta/15 text-hub-cta">{c.shipped} shipped</span>
										{/if}
										{#if c.parked > 0}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-dim/15 text-hub-dim">{c.parked} parked</span>
										{/if}
										{#if c.superseded > 0}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-muted/15 text-hub-muted">{c.superseded} superseded</span>
										{/if}
										{#if c.rejected > 0}
											<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-danger/15 text-hub-danger">{c.rejected} rejected</span>
										{/if}
										{#if c.other > 0}
											<span
												class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-dim/10 text-hub-dim border border-hub-warning/30"
												title="Non-canonical or missing status (per projects-graph ADR-002)"
											>{c.other} other</span>
										{/if}
									</div>
									{#if expandedArtifactTypes.has(type)}
										<div class="mt-2 pt-2 border-t border-hub-border/60 space-y-0.5">
											{#if artifactLoading.has(type)}
												<p class="text-[11px] text-hub-dim py-1">Loading…</p>
											{:else if artifactError[type]}
												<p class="text-[11px] text-hub-danger py-1">{artifactError[type]}</p>
											{:else if (artifactRows[type] ?? []).length === 0}
												<p class="text-[11px] text-hub-dim py-1">No items.</p>
											{:else}
												{#each artifactRows[type] as row (row.path)}
													<button type="button" class="w-full flex items-center justify-between gap-2 px-1.5 py-1 rounded text-left hover:bg-hub-card/60 transition-colors cursor-pointer group/row" onclick={() => (drawerPath = row.path)}>
														<span class="text-[12px] text-hub-text group-hover/row:text-hub-cta transition-colors truncate">{row.title}</span>
														{#if row.status}<span class="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium {artifactStatusClass(row.status)}">{row.status}</span>{/if}
													</button>
												{/each}
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</section>
				{/if}
			{/if}
		</div>
	</div>
</div>

<AdrDrawer
	path={drawerPath}
	onClose={() => drawerPath = null}
	onTransition={handleTransition}
/>
