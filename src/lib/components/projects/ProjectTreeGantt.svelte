<!--
projects-graph ADR-004 + ADR-015 — Parent-rollup Gantt.

Layout (when project has descendants):

  [Project Rollup — shared time axis]
  soul-hub                ▼ [████████████░░░] 85/106  2024-04 ──────── 2026-07
  ├ (own ADRs)              [█████████░░░░░░] 13/13   2024-04 ── 2026-05
  ├ soul-hub-whatsapp       [██████████░░░░░] 47/50   2025-01 ───── 2026-06
  ├ projects-graph          [██░░░░░░░░░░░░░] 4/14    2026-05 ─ 2026-08
  ├ … 11 more rows
  └

  [{slug} — own ADRs] (legacy AdrGantt for ADR-level detail of this project)

Key UX choices (ADR-015):
  - One bar per project — hierarchy via indentation, not section stacking.
  - Shared time axis: min(starts) → max(ends) across self + descendants,
    so every bar reads in proportion.
  - Synthetic "(own ADRs)" row makes the parent's contribution explicit,
    so the parent row's aggregate = sum of (own) + each child.
  - Click a child row → navigate to that project's page. Parent + (own)
    rows are non-interactive (you're already on the parent's page).
  - ADR-level detail for the parent lives BELOW as a regular AdrGantt
    (unchanged from today's per-project view).

For leaf projects (no descendants): skip the rollup entirely and render
plain AdrGantt — preserves today's behaviour bit-for-bit.
-->
<script lang="ts">
	import AdrGantt from './AdrGantt.svelte';
	import AdrNetwork from './AdrNetwork.svelte';

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
		/** projects-graph ADR-016 P2 — propagated for the aggregated
		 *  parent-rollup Network view (`computeCriticalPath` inside
		 *  `AdrNetwork` parses these into the cross-project DAG). */
		blockedBy?: string[];
	}

	interface ProjectNode {
		slug: string;
		decisions?: DecisionRow[];
	}

	let {
		rootSlug,
		rootDecisions,
		descendants,
		onSelect,
		view = 'network',
	}: {
		rootSlug: string;
		rootDecisions: DecisionRow[];
		descendants: ProjectNode[];
		onSelect: (path: string) => void;
		/** projects-graph ADR-016 — per-project ADR rendering. Default is
		 *  `'network'` (dagre Sugiyama DAG, vault-faithful — `blocked_by`
		 *  drives layout). `'gantt'` falls back to the legacy time-axis
		 *  chart for operators who want calendar context. The parent-
		 *  rollup table (one bar per project on a shared time axis) is
		 *  ALWAYS Gantt — that surface lives at a different abstraction
		 *  and is unaffected by this prop. */
		view?: 'network' | 'gantt';
	} = $props();

	const TODAY_ISO = new Date().toISOString().slice(0, 10);
	const EXPANDED_KEY = 'vault-projects-tree-expanded';
	let expanded = $state<Set<string>>(new Set());

	$effect(() => {
		try {
			const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(EXPANDED_KEY) : null;
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) expanded = new Set(parsed.filter((x) => typeof x === 'string'));
			}
		} catch {
			// noop — start collapsed
		}
	});

	function toggle(slug: string) {
		const next = new Set(expanded);
		if (next.has(slug)) next.delete(slug);
		else next.add(slug);
		expanded = next;
		try {
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
			}
		} catch {
			// noop
		}
	}

	/** ADR-015 — per-project span. `start` = earliest `created`; `end` =
	 *  latest `shipped_on || accepted_on || target_date || today`. Counts
	 *  exclude rejected + superseded so the progress fraction matches the
	 *  "active work" framing used in AdrGantt today. */
	type Span = {
		start: string | null;
		end: string | null;
		shipped: number;
		total: number;
		hasAny: boolean;
	};

	function spanFor(rows: DecisionRow[]): Span {
		let start: string | null = null;
		let end: string | null = null;
		let shipped = 0;
		let total = 0;
		for (const d of rows) {
			if (d.status === 'rejected' || d.status === 'superseded') continue;
			total++;
			if (d.status === 'shipped') shipped++;
			const s = d.created;
			const e = d.shippedOn ?? d.acceptedOn ?? d.targetDate ?? TODAY_ISO;
			if (s && (!start || s < start)) start = s;
			if (e && (!end || e > end)) end = e;
		}
		return { start, end, shipped, total, hasAny: total > 0 };
	}

	/** Synthetic "(own ADRs)" row carries the parent's own contribution
	 *  on the same time axis. Click is a no-op — the operator is already
	 *  on this project's page; the row is informational. */
	type Row = {
		key: string;
		label: string;
		slug: string | null;
		span: Span;
		indent: number;
		clickable: boolean;
		isParent: boolean;
	};

	const rows = $derived.by<Row[]>(() => {
		const out: Row[] = [];

		// Parent row: aggregate of self + all descendants.
		const allDecisions: DecisionRow[] = [
			...rootDecisions,
			...descendants.flatMap((d) => d.decisions ?? []),
		];
		out.push({
			key: `__parent__${rootSlug}`,
			label: rootSlug,
			slug: rootSlug,
			span: spanFor(allDecisions),
			indent: 0,
			clickable: false,
			isParent: true,
		});

		// Children only render when the parent row is expanded.
		if (expanded.has(rootSlug)) {
			// Synthetic (own ADRs) row sits ABOVE the descendants so the
			// parent's own contribution is the first thing the operator sees
			// after expand. Skipped when the parent has zero own decisions.
			const ownSpan = spanFor(rootDecisions);
			if (ownSpan.hasAny) {
				out.push({
					key: `__own__${rootSlug}`,
					label: '(own ADRs)',
					slug: null,
					span: ownSpan,
					indent: 1,
					clickable: false,
					isParent: false,
				});
			}
			// One row per descendant, sorted by start date asc so the
			// timeline reads earliest-first within the same indent level.
			const childRows: Row[] = descendants.map((d) => ({
				key: `child:${d.slug}`,
				label: d.slug,
				slug: d.slug,
				span: spanFor(d.decisions ?? []),
				indent: 1,
				clickable: true,
				isParent: false,
			}));
			childRows.sort((a, b) => {
				const sa = a.span.start ?? '9999';
				const sb = b.span.start ?? '9999';
				if (sa !== sb) return sa < sb ? -1 : 1;
				return a.label.localeCompare(b.label);
			});
			out.push(...childRows);
		}

		return out;
	});

	/** Shared time axis: min over every row's `start`, max over every
	 *  row's `end`. Always defined when at least one row has rows; the
	 *  parent row guarantees that for non-leaf projects. */
	const axis = $derived.by<{ min: number; max: number; ok: boolean }>(() => {
		let min: number | null = null;
		let max: number | null = null;
		for (const r of rows) {
			if (r.span.start) {
				const ms = Date.parse(r.span.start);
				if (!Number.isNaN(ms) && (min === null || ms < min)) min = ms;
			}
			if (r.span.end) {
				const ms = Date.parse(r.span.end);
				if (!Number.isNaN(ms) && (max === null || ms > max)) max = ms;
			}
		}
		if (min === null || max === null || max <= min) return { min: 0, max: 0, ok: false };
		return { min, max, ok: true };
	});

	function barPos(span: Span): { left: number; width: number } | null {
		if (!axis.ok || !span.start || !span.end) return null;
		const s = Date.parse(span.start);
		const e = Date.parse(span.end);
		if (Number.isNaN(s) || Number.isNaN(e)) return null;
		const range = axis.max - axis.min;
		const left = ((s - axis.min) / range) * 100;
		const width = Math.max(0.5, ((e - s) / range) * 100);
		return { left, width };
	}

	const isOpen = $derived(expanded.has(rootSlug));

	/** projects-graph ADR-016 P2 — aggregated decisions list for the
	 *  cross-project Network. Concatenates root + every descendant.
	 *  Filtered to ADRs that participate in at least one CROSS-PROJECT
	 *  `blocked_by` edge — isolated ADRs and intra-project chains aren't
	 *  the question this section answers. The vault is the data source:
	 *  cross-project edges live in `blocked_by` frontmatter today; no
	 *  API change required.
	 *
	 *  Filter rationale: soul-hub today has 144 decisions across 18
	 *  projects but only ~6 cross-project edges. Rendering all 144 in
	 *  dagre stacks 130+ unrelated rank-0 nodes vertically — visually
	 *  honest but operationally useless. This filter cuts to the
	 *  signal: which ADRs make this *cluster of projects* connected. */
	const aggregatedDecisions = $derived.by<DecisionRow[]>(() => {
		const all = [...rootDecisions, ...descendants.flatMap((d) => d.decisions ?? [])];
		if (all.length === 0) return [];

		const slugOf = (p: string) => p.split('/').pop()?.replace(/\.md$/i, '') ?? '';
		const projectOf = (p: string) => {
			const m = /^projects\/([^/]+)\//.exec(p);
			return m ? m[1] : '';
		};
		const slugToProject = new Map<string, string>();
		for (const d of all) slugToProject.set(slugOf(d.path), projectOf(d.path));

		const linkRe = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/;
		const crossSlugs = new Set<string>();
		for (const d of all) {
			const srcProject = projectOf(d.path);
			const srcSlug = slugOf(d.path);
			for (const raw of d.blockedBy ?? []) {
				const m = linkRe.exec(raw.trim());
				if (!m) continue;
				const targetLast = m[1].trim().split('/').pop();
				if (!targetLast) continue;
				const targetSlug = targetLast.replace(/\.md$/i, '');
				const targetProject = slugToProject.get(targetSlug);
				if (!targetProject || targetProject === srcProject) continue;
				crossSlugs.add(srcSlug);
				crossSlugs.add(targetSlug);
			}
		}
		if (crossSlugs.size === 0) return [];
		return all.filter((d) => crossSlugs.has(slugOf(d.path)));
	});
</script>

{#if descendants.length === 0}
	<!-- Leaf project — per-project view per ADR-016 (network = default,
	     gantt = ?view=gantt fallback). -->
	{#if view === 'gantt'}
		<AdrGantt decisions={rootDecisions} {onSelect} />
	{:else}
		<AdrNetwork decisions={rootDecisions} {onSelect} />
	{/if}
{:else}
	<div class="space-y-4">
		<!-- Project Rollup — shared time axis -->
		<section class="rounded-lg border border-hub-info/30 bg-hub-info/5 overflow-hidden">
			<header class="px-3 py-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-hub-info border-b border-hub-info/20">
				<span>Project rollup</span>
				<span class="text-hub-dim font-normal normal-case tracking-normal">
					{descendants.length} descendant{descendants.length === 1 ? '' : 's'}
					{#if axis.ok}
						· {new Date(axis.min).toISOString().slice(0, 7)} → {new Date(axis.max).toISOString().slice(0, 7)}
					{/if}
				</span>
			</header>

			<div class="divide-y divide-hub-border/40">
				{#each rows as r (r.key)}
					{@const pos = barPos(r.span)}
					{@const pct = r.span.total > 0 ? Math.round((r.span.shipped / r.span.total) * 100) : 0}
					<div
						class="px-3 py-2 flex items-center gap-3 text-xs"
						class:bg-hub-info-soft={r.isParent}
					>
						<!-- Label column: indent + name + (chevron on parent row) -->
						<div class="flex items-center gap-2 w-56 flex-shrink-0 min-w-0" style="padding-left: {r.indent * 16}px;">
							{#if r.isParent}
								<button
									type="button"
									onclick={() => toggle(rootSlug)}
									class="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
									aria-label={isOpen ? 'Collapse children' : 'Expand children'}
									aria-expanded={isOpen}
								>
									<span class="text-[10px] leading-none select-none">{isOpen ? '▼' : '▶'}</span>
								</button>
							{:else}
								<span class="flex-shrink-0 w-5 text-hub-dim text-center text-[10px]">└</span>
							{/if}
							{#if r.clickable && r.slug}
								<a
									href="/projects/{r.slug}"
									class="truncate font-mono text-hub-text hover:text-hub-cta transition-colors"
								>{r.label}</a>
							{:else}
								<span class="truncate font-mono" class:font-semibold={r.isParent} class:text-hub-text={r.isParent} class:text-hub-dim={!r.isParent}>{r.label}</span>
							{/if}
						</div>

						<!-- Bar track -->
						<div class="relative flex-1 h-5 bg-hub-card/30 rounded">
							{#if pos}
								<div
									class="absolute top-0 bottom-0 rounded bg-hub-card border border-hub-border overflow-hidden"
									style="left: {pos.left}%; width: {pos.width}%;"
									title="{r.span.start} → {r.span.end}"
								>
									<div
										class="h-full bg-hub-cta/60"
										style="width: {pct}%;"
									></div>
								</div>
							{:else}
								<div class="absolute inset-0 flex items-center justify-center text-[10px] text-hub-dim italic">
									no ADRs yet
								</div>
							{/if}
						</div>

						<!-- Right column: counts -->
						<div class="flex-shrink-0 w-24 text-right text-[11px]">
							{#if r.span.total > 0}
								<span class="text-hub-cta font-medium">{r.span.shipped}</span><span class="text-hub-dim">/</span><span class="text-hub-text">{r.span.total}</span>
								<span class="text-hub-dim text-[10px] ml-1">({pct}%)</span>
							{:else}
								<span class="text-hub-dim italic">—</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</section>

		<!-- projects-graph ADR-016 P2 — Cross-project ADR Network.
		     Aggregates root + every descendant into one dagre-laid-out DAG.
		     The vault is the source: cross-project blocked_by edges become
		     arrows that visibly span project clusters. Project-stripe on
		     each node makes ownership readable; status fill stays
		     informative. Skipped in `?view=gantt` mode (operator opted out
		     of structural inspection) and when aggregated set < 2 (no
		     graph to render). -->
		{#if view === 'network' && aggregatedDecisions.length >= 2}
			<section class="rounded-lg border border-hub-info/30 bg-hub-info/5 overflow-hidden">
				<header class="px-3 py-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-hub-info border-b border-hub-info/20">
					<span>Cross-project network</span>
					<span class="text-hub-dim font-normal normal-case tracking-normal">
						{aggregatedDecisions.length} ADR{aggregatedDecisions.length === 1 ? '' : 's'} across {descendants.length + 1} project{descendants.length === 0 ? '' : 's'}
					</span>
				</header>
				<div class="px-3 py-3">
					<AdrNetwork decisions={aggregatedDecisions} {onSelect} projectStripe />
				</div>
			</section>
		{/if}

		<!-- Parent's own ADR-level detail. Same component, same data shape
		     as today; only its position changed (below the project rollup
		     rather than the only widget). Skipped when the parent has
		     no own decisions. -->
		{#if rootDecisions.length > 0}
			<section class="rounded-lg border border-hub-border bg-hub-card/30 overflow-hidden">
				<header class="px-3 py-2 text-[10px] uppercase tracking-wider text-hub-dim border-b border-hub-border/40">
					{rootSlug} — own ADRs
				</header>
				<div class="px-3 py-2">
					{#if view === 'gantt'}
						<AdrGantt decisions={rootDecisions} {onSelect} />
					{:else}
						<AdrNetwork decisions={rootDecisions} {onSelect} />
					{/if}
				</div>
			</section>
		{/if}
	</div>
{/if}

<style>
	/* hub-info-soft fallback — keeps the parent row tinted even when the
	   design system doesn't define this token specifically. */
	:global(.bg-hub-info-soft) {
		background-color: rgba(99, 179, 237, 0.06);
	}
</style>
