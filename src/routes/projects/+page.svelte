<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import VaultGraph from '$lib/components/vault/VaultGraph.svelte';
	import type { GraphNode, GraphEdge, ProjectGraphData } from '$lib/vault/types';

	interface StatusCounts {
		proposed: number;
		accepted: number;
		shipped: number;
		rejected: number;
		parked: number;
		superseded: number;
		other: number;
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

	const PROJECT_SHAPES_UI: readonly ProjectShape[] = [
		'coding-spine',
		'producer-pipeline',
		'publishing-outlet',
		'strategy-initiative',
		'time-boxed-bet',
		'maintained-system',
		'parent',
	] as const;

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

	interface ProjectRollup {
		slug: string;
		adrCount: number;
		noteCount: number;
		statusCounts: StatusCounts;
		openCount: number;
		lastActivity: number | null;
		upcomingFalsifiers: { path: string; date: string; daysAway: number; source?: 'project' }[];
		hasIndex: boolean;
		parentProject: string | null;
		shape: ProjectShape | null;
		projectFalsifier: string | null;
		projectFalsifierDate: string | null;
		/** projects-graph ADR-013 — root index.md tag list (cluster filter source). */
		tags: string[];
		/** projects-graph ADR-012 — list-view description. */
		description: string;
	}

	interface TreeNode {
		project: ProjectRollup;
		depth: number;
		children: TreeNode[];
	}

	const EXPANDED_KEY = 'vault-projects-tree-expanded';

	interface QueueRow {
		path: string;
		title: string;
		project: string;
		status: string;
		created: string | null;
		falsifierDate: string | null;
		falsifierDaysAway: number | null;
		tags: string[];
		blockedBy: string[];
	}

	let projects = $state<ProjectRollup[]>([]);
	let queueCount = $state(0);
	let loading = $state(true);
	let error = $state('');
	let filter = $state('');
	let statusFilter = $state<'all' | 'open' | 'shipped' | 'archived'>('all');
	/** projects-graph ADR-001 — operator-chosen shape filter. `'all'` shows
	 *  every project; a concrete value scopes the list to that shape. */
	let shapeFilter = $state<ProjectShape | 'all'>('all');
	let expanded = $state<Set<string>>(new Set());

	// projects-graph ADR-012 — cluster filter (sourced from root index tags),
	// sort dropdown (5 options), both persisted in localStorage. The cluster
	// pref defaults to `?cluster=<x>` query param when present so ADR-013's
	// header cluster pill deep-links into the filtered view.
	type SortPref = 'recency' | 'name' | 'adr-count' | 'falsifier' | 'shape';
	let clusterFilter = $state<string>('all');
	let sortPref = $state<SortPref>('recency');

	const CLUSTER_KEY = 'vault-projects-cluster-pref';
	const SORT_KEY = 'vault-projects-sort-pref';
	// projects-graph ADR-005 — opt-in graph view. URL `?view=graph` wins
	// over the persisted pref so deep-links from elsewhere (chat, soul CLI)
	// land predictably; otherwise we restore the operator's last choice.
	const VIEW_KEY = 'vault-projects-view-pref';
	type ProjectView = 'tree' | 'graph';
	let view = $state<ProjectView>('tree');
	let projectGraph = $state<ProjectGraphData | null>(null);
	let graphLoading = $state(false);
	let graphError = $state('');

	/** projects-graph ADR-012 — distinct cluster tags across the loaded
	 *  project list. Sorted alphabetically for stable chip order. */
	const clusters = $derived.by<string[]>(() => {
		const set = new Set<string>();
		for (const p of projects) {
			for (const t of p.tags ?? []) {
				if (t.startsWith('cluster:')) set.add(t.slice('cluster:'.length));
			}
		}
		return Array.from(set).sort();
	});

	/** A project passes the row-level filter (text + status + shape). The
	 *  tree-walk below uses this to decide whether to keep a node OR any of
	 *  its descendants (descendant-aware filtering). */
	function projectMatches(p: ProjectRollup): boolean {
		if (filter && !p.slug.toLowerCase().includes(filter.toLowerCase())) return false;
		if (statusFilter === 'open' && p.statusCounts.proposed === 0) return false;
		if (statusFilter === 'shipped' && p.statusCounts.shipped === 0) return false;
		if (statusFilter === 'archived' && p.adrCount > 0) return false;
		if (shapeFilter !== 'all' && p.shape !== shapeFilter) return false;
		// projects-graph ADR-012 — cluster filter scoped to the explicit
		// `cluster:<slug>` tag on the project root index.md. `ungrouped`
		// matches projects without any cluster tag.
		if (clusterFilter !== 'all') {
			const tagSet = new Set(p.tags ?? []);
			if (clusterFilter === 'ungrouped') {
				if ([...tagSet].some((t) => t.startsWith('cluster:'))) return false;
			} else if (!tagSet.has(`cluster:${clusterFilter}`)) {
				return false;
			}
		}
		return true;
	}

	/** Build a tree from the flat list. Roots = parentProject is null OR
	 *  parent slug isn't in the set (orphan parent — render at top level
	 *  rather than dropping the node). */
	const tree = $derived.by<TreeNode[]>(() => {
		const bySlug = new Map<string, ProjectRollup>();
		for (const p of projects) bySlug.set(p.slug, p);

		const childrenOf = new Map<string, ProjectRollup[]>();
		const roots: ProjectRollup[] = [];
		for (const p of projects) {
			if (p.parentProject && bySlug.has(p.parentProject)) {
				const arr = childrenOf.get(p.parentProject) ?? [];
				arr.push(p);
				childrenOf.set(p.parentProject, arr);
			} else {
				roots.push(p);
			}
		}

		// projects-graph ADR-012 — sort comparator dispatched by sortPref.
		// `recency` matches today's default (preserved verbatim). Other prefs
		// add deterministic secondary sort by slug to stabilise ties.
		const cmp = (a: ProjectRollup, b: ProjectRollup): number => {
			if (sortPref === 'name') return a.slug.localeCompare(b.slug);
			if (sortPref === 'adr-count') {
				if (a.adrCount !== b.adrCount) return b.adrCount - a.adrCount;
				return a.slug.localeCompare(b.slug);
			}
			if (sortPref === 'falsifier') {
				// Soonest first; projects without a falsifier sink to bottom.
				const da = a.upcomingFalsifiers[0]?.daysAway;
				const db = b.upcomingFalsifiers[0]?.daysAway;
				if (da !== undefined && db !== undefined) return da - db;
				if (da !== undefined) return -1;
				if (db !== undefined) return 1;
				return a.slug.localeCompare(b.slug);
			}
			if (sortPref === 'shape') {
				// Order by shape string; unlabelled projects sink.
				const sa = a.shape ?? '￿';
				const sb = b.shape ?? '￿';
				if (sa !== sb) return sa.localeCompare(sb);
				return a.slug.localeCompare(b.slug);
			}
			// Default: recency.
			if (a.lastActivity && b.lastActivity) return b.lastActivity - a.lastActivity;
			if (a.lastActivity) return -1;
			if (b.lastActivity) return 1;
			return a.slug.localeCompare(b.slug);
		};

		const buildNode = (p: ProjectRollup, depth: number): TreeNode => {
			const kids = (childrenOf.get(p.slug) ?? [])
				.slice()
				.sort(cmp)
				.map((c) => buildNode(c, depth + 1));
			return { project: p, depth, children: kids };
		};

		return roots.sort(cmp).map((r) => buildNode(r, 0));
	});

	/** Descendant-aware filter: a node survives if it matches OR any
	 *  descendant survives. Empty parents get dropped. */
	function filterTree(nodes: TreeNode[]): TreeNode[] {
		const out: TreeNode[] = [];
		for (const n of nodes) {
			const filteredChildren = filterTree(n.children);
			if (projectMatches(n.project) || filteredChildren.length > 0) {
				out.push({ ...n, children: filteredChildren });
			}
		}
		return out;
	}

	const filtered = $derived(filterTree(tree));

	/** Slugs that should auto-expand: ancestors of any filter-match.
	 *  Computed only when filter is active so manual expand/collapse wins
	 *  when filters are empty. */
	const autoExpanded = $derived.by(() => {
		if (!filter && statusFilter === 'all' && shapeFilter === 'all' && clusterFilter === 'all') return null;
		const set = new Set<string>();
		const visit = (nodes: TreeNode[], ancestors: string[]) => {
			for (const n of nodes) {
				if (projectMatches(n.project)) {
					for (const a of ancestors) set.add(a);
				}
				visit(n.children, [...ancestors, n.project.slug]);
			}
		};
		visit(tree, []);
		return set;
	});

	function isExpanded(slug: string): boolean {
		if (autoExpanded) return autoExpanded.has(slug);
		return expanded.has(slug);
	}

	function toggle(slug: string) {
		const next = new Set(expanded);
		if (next.has(slug)) next.delete(slug);
		else next.add(slug);
		expanded = next;
		try {
			localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
		} catch {
			// localStorage may be disabled — silently fall back to memory-only state
		}
	}

	/** Count visible cards (used for "no matches" empty state). */
	const visibleCount = $derived.by(() => {
		let n = 0;
		const walk = (nodes: TreeNode[]) => {
			for (const node of nodes) {
				n++;
				walk(node.children);
			}
		};
		walk(filtered);
		return n;
	});

	const totals = $derived.by(() => {
		const t = { adrs: 0, proposed: 0, shipped: 0 };
		for (const p of projects) {
			t.adrs += p.adrCount;
			t.proposed += p.statusCounts.proposed;
			t.shipped += p.statusCounts.shipped;
		}
		return t;
	});

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

	/** projects-graph ADR-005 — lazy fetch of the project-level graph.
	 *  Only fires when the operator flips into `view=graph`; tree-view
	 *  users pay no cost. Re-fetches on retry; otherwise cached for the
	 *  lifetime of the page. */
	async function loadProjectGraph() {
		if (projectGraph || graphLoading) return;
		graphLoading = true;
		graphError = '';
		try {
			const res = await fetch('/api/vault/projects/graph');
			if (!res.ok) throw new Error(`graph ${res.status}`);
			projectGraph = (await res.json()) as ProjectGraphData;
		} catch (e) {
			graphError = e instanceof Error ? e.message : 'Failed to load graph';
		} finally {
			graphLoading = false;
		}
	}

	function setView(next: ProjectView) {
		view = next;
		try {
			localStorage.setItem(VIEW_KEY, next);
		} catch {
			// noop — localStorage unavailable
		}
		if (next === 'graph') loadProjectGraph();
	}

	/** projects-graph ADR-005 — slugs visible after filtering. Drives the
	 *  graph view so the filter bar (text + status + shape + cluster) is
	 *  honoured in both views; an unfiltered page shows the full
	 *  project graph. */
	const visibleSlugs = $derived.by<Set<string>>(() => {
		const set = new Set<string>();
		const walk = (nodes: TreeNode[]) => {
			for (const n of nodes) {
				if (projectMatches(n.project)) set.add(n.project.slug);
				walk(n.children);
			}
		};
		walk(filtered);
		return set;
	});

	const filteredGraphNodes = $derived.by<GraphNode[]>(() => {
		if (!projectGraph) return [];
		return projectGraph.nodes.filter((n) => {
			const slug = n.id.replace(/^projects\//, '').replace(/\/index\.md$/, '');
			return visibleSlugs.has(slug);
		});
	});

	const filteredGraphEdges = $derived.by<GraphEdge[]>(() => {
		if (!projectGraph || filteredGraphNodes.length === 0) return [];
		const visibleIds = new Set(filteredGraphNodes.map((n) => n.id));
		return projectGraph.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
	});

	function onGraphNodeClick(id: string) {
		const slug = id.replace(/^projects\//, '').replace(/\/index\.md$/, '');
		if (slug) {
			window.location.href = `/projects/${slug}`;
		}
	}

	async function loadProjects() {
		error = '';
		try {
			const [projectsRes, queueRes] = await Promise.all([
				fetch('/api/vault/projects'),
				fetch('/api/vault/decisions/queue'),
			]);
			if (!projectsRes.ok) throw new Error(`projects ${projectsRes.status}`);
			if (!queueRes.ok) throw new Error(`queue ${queueRes.status}`);
			const projectsData = await projectsRes.json();
			const queueData = await queueRes.json();
			projects = projectsData.projects ?? [];
			queueCount = (queueData.decisions as QueueRow[] ?? []).length;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load projects';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		try {
			const raw = localStorage.getItem(EXPANDED_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) expanded = new Set(parsed.filter((x) => typeof x === 'string'));
			}
		} catch {
			// localStorage unavailable or malformed value — start collapsed
		}

		// projects-graph ADR-012 — restore sort + cluster prefs from
		// localStorage; URL `?cluster=<x>` query param (deep-link from
		// ADR-013's header cluster pill) wins over the persisted pref.
		try {
			const savedSort = localStorage.getItem(SORT_KEY);
			if (savedSort && ['recency','name','adr-count','falsifier','shape'].includes(savedSort)) {
				sortPref = savedSort as SortPref;
			}
			const savedCluster = localStorage.getItem(CLUSTER_KEY);
			if (savedCluster) clusterFilter = savedCluster;
		} catch {
			// noop — defaults stay
		}
		const urlCluster = $page.url.searchParams.get('cluster');
		if (urlCluster) clusterFilter = urlCluster;

		// projects-graph ADR-005 — view pref order: URL ?view=graph wins
		// over localStorage which wins over the default ('tree'). Falsifier
		// F2 requires the URL form to be bookmarkable, so the URL is
		// authoritative when present.
		const urlView = $page.url.searchParams.get('view');
		if (urlView === 'graph' || urlView === 'tree') {
			view = urlView;
		} else {
			try {
				const savedView = localStorage.getItem(VIEW_KEY);
				if (savedView === 'graph' || savedView === 'tree') view = savedView;
			} catch {
				// noop — defaults stay
			}
		}

		loadProjects();
		if (view === 'graph') loadProjectGraph();
	});

	// projects-graph ADR-012 — persist sort + cluster prefs on change.
	$effect(() => {
		try { localStorage.setItem(SORT_KEY, sortPref); } catch { /* noop */ }
	});
	$effect(() => {
		try { localStorage.setItem(CLUSTER_KEY, clusterFilter); } catch { /* noop */ }
	});
</script>

{#snippet treeRow(node: TreeNode)}
	{@const project = node.project}
	{@const hasChildren = node.children.length > 0}
	{@const open = isExpanded(project.slug)}
	<div style="margin-left: {node.depth * 24}px;">
		<div class="group flex items-stretch rounded-lg border border-hub-border bg-hub-card/40 hover:border-hub-cta/40 hover:bg-hub-card/60 transition-colors">
			<button
				type="button"
				onclick={() => hasChildren && toggle(project.slug)}
				class="flex-shrink-0 w-7 flex items-center justify-center text-hub-dim hover:text-hub-text"
				class:cursor-pointer={hasChildren}
				class:cursor-default={!hasChildren}
				aria-label={hasChildren ? (open ? 'Collapse' : 'Expand') : ''}
				tabindex={hasChildren ? 0 : -1}
			>
				{#if hasChildren}
					<span class="text-[10px] leading-none select-none">{open ? '▼' : '▶'}</span>
				{:else}
					<span class="block w-1 h-1 rounded-full bg-hub-border"></span>
				{/if}
			</button>
			<a href="/projects/{project.slug}" class="flex-1 block p-4 cursor-pointer min-w-0">
				<div class="flex items-start justify-between mb-2 min-w-0 gap-2">
					<div class="min-w-0 flex items-center gap-2 flex-wrap">
						<h3 class="text-sm font-semibold text-hub-text group-hover:text-hub-cta transition-colors truncate">
							{project.slug}
							{#if hasChildren}
								<span class="ml-1 text-[10px] font-normal text-hub-dim">({node.children.length})</span>
							{/if}
						</h3>
						{#if project.shape}
							<span
								class="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 {shapeClass(project.shape)}"
								title="Project shape (projects-graph ADR-001)"
							>
								{project.shape}
							</span>
						{:else}
							<span
								class="px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 bg-hub-warning/10 text-hub-warning border border-hub-warning/30"
								title={"No project_shape — run `soul project label-shape " + project.slug + " <shape>`"}
							>
								no shape
							</span>
						{/if}
					</div>
					{#if project.upcomingFalsifiers.length > 0}
						<span
							class="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium"
							class:bg-hub-danger={project.upcomingFalsifiers[0].daysAway <= 7}
							class:text-white={project.upcomingFalsifiers[0].daysAway <= 7}
							class:bg-hub-warning={project.upcomingFalsifiers[0].daysAway > 7}
							class:text-black={project.upcomingFalsifiers[0].daysAway > 7}
							title={`Falsifier: ${project.upcomingFalsifiers[0].date}`}
						>
							⏱ {project.upcomingFalsifiers[0].daysAway}d
						</span>
					{/if}
				</div>
				<div class="flex items-center gap-2 text-[11px] mb-2 flex-wrap">
					<span class="text-hub-dim">{project.adrCount} ADR{project.adrCount === 1 ? '' : 's'}</span>
					<span class="text-hub-dim">·</span>
					<span class="text-hub-dim">{project.noteCount} note{project.noteCount === 1 ? '' : 's'}</span>
					<span class="text-hub-dim">·</span>
					<span class="text-hub-dim">{timeAgoMs(project.lastActivity)}</span>
				</div>
				<!-- projects-graph ADR-012 — one-line description (frontmatter or
				     body first-paragraph fallback). Hidden when both sources are
				     empty so the card stays compact. -->
				{#if project.description}
					<p class="text-[11px] text-hub-muted mb-2 line-clamp-2">{project.description}</p>
				{/if}
				<div class="flex flex-wrap items-center gap-1">
					{#if project.statusCounts.proposed > 0}
						<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-warning/15 text-hub-warning">
							{project.statusCounts.proposed} proposed
						</span>
					{/if}
					{#if project.statusCounts.accepted > 0}
						<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-info/15 text-hub-info">
							{project.statusCounts.accepted} accepted
						</span>
					{/if}
					{#if project.statusCounts.shipped > 0}
						<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-cta/15 text-hub-cta">
							{project.statusCounts.shipped} shipped
						</span>
					{/if}
					{#if project.statusCounts.parked > 0}
						<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-dim/15 text-hub-dim">
							{project.statusCounts.parked} parked
						</span>
					{/if}
					{#if project.statusCounts.rejected > 0}
						<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-danger/15 text-hub-danger">
							{project.statusCounts.rejected} rejected
						</span>
					{/if}
					{#if project.adrCount === 0}
						<span class="text-[10px] text-hub-dim">no ADRs yet</span>
					{/if}
				</div>
			</a>
		</div>
		{#if hasChildren && open}
			<div class="mt-2 flex flex-col gap-2">
				{#each node.children as child (child.project.slug)}
					{@render treeRow(child)}
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<svelte:head>
	<title>Projects | Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header + sub-nav -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto">
			<div class="flex items-center justify-between mb-3">
				<div class="flex items-center gap-3">
					<h1 class="text-lg font-semibold text-hub-text">Projects</h1>
					{#if projects.length > 0}
						<span class="text-hub-dim font-normal text-sm">({projects.length})</span>
					{/if}
				</div>
				<div class="flex items-center gap-3 text-xs text-hub-dim">
					<span>{totals.adrs} ADRs</span>
					{#if totals.shipped > 0}
						<span class="text-hub-info">{totals.shipped} shipped</span>
					{/if}
					{#if totals.proposed > 0}
						<a href="/projects/queue" class="px-2 py-1 rounded bg-hub-warning/15 text-hub-warning hover:bg-hub-warning/25 transition-colors cursor-pointer">
							{totals.proposed} awaiting decision
						</a>
					{/if}
				</div>
			</div>
			<div class="flex items-center justify-between gap-3">
				<nav class="flex items-center gap-1 text-xs">
					<a href="/projects" class="px-3 py-1.5 rounded-md bg-hub-card text-hub-text">
						All
					</a>
					<a href="/projects/queue" class="px-3 py-1.5 rounded-md text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer flex items-center gap-1.5">
						Decision Queue
						{#if queueCount > 0}
							<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-warning/20 text-hub-warning">{queueCount}</span>
						{/if}
					</a>
				</nav>
				<!-- projects-graph ADR-005 — view toggle (tree | graph).
				     Anchors so middle-click + bookmarks work; localStorage
				     pref tracked via setView so the choice survives reload
				     even without query params. -->
				<nav class="flex items-center gap-0.5 text-[11px] rounded-md border border-hub-border overflow-hidden" aria-label="View mode">
					<a
						href="/projects"
						onclick={(e) => { e.preventDefault(); setView('tree'); }}
						class="px-2.5 py-1.5 transition-colors {view === 'tree' ? 'bg-hub-card text-hub-text' : 'text-hub-muted hover:text-hub-text'}"
					>Tree</a>
					<a
						href="/projects?view=graph"
						onclick={(e) => { e.preventDefault(); setView('graph'); }}
						class="px-2.5 py-1.5 transition-colors {view === 'graph' ? 'bg-hub-card text-hub-text' : 'text-hub-muted hover:text-hub-text'}"
					>Graph</a>
				</nav>
			</div>
		</div>
	</header>

	<!-- Main -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading projects…</div>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger mb-6 flex items-center justify-between">
					<span>{error}</span>
					<button onclick={() => loadProjects()} class="text-xs underline cursor-pointer">Retry</button>
				</div>
			{:else if projects.length === 0}
				<div class="flex flex-col items-center justify-center py-20">
					<p class="text-hub-muted text-sm mb-1">No projects in vault yet</p>
					<p class="text-hub-dim text-xs">Create a folder under <code class="px-1 py-0.5 rounded bg-hub-card text-hub-text font-mono text-[10px]">~/vault/projects/</code> and add an ADR.</p>
				</div>
			{:else}
				<!-- Filter bar -->
				<div class="flex flex-col sm:flex-row gap-2 mb-4">
					<div class="relative flex-1">
						<svg class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
						</svg>
						<input
							bind:value={filter}
							type="text"
							placeholder="Filter by name…"
							class="w-full bg-transparent border border-hub-border rounded-lg pl-9 pr-3 py-2 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors"
						/>
					</div>
					<div class="flex items-center gap-1 text-xs">
						<button
							onclick={() => (statusFilter = 'all')}
							class="px-3 py-2 rounded-lg border transition-colors cursor-pointer"
							class:border-hub-cta={statusFilter === 'all'}
							class:text-hub-cta={statusFilter === 'all'}
							class:border-hub-border={statusFilter !== 'all'}
							class:text-hub-muted={statusFilter !== 'all'}
						>All</button>
						<button
							onclick={() => (statusFilter = 'open')}
							class="px-3 py-2 rounded-lg border transition-colors cursor-pointer"
							class:border-hub-warning={statusFilter === 'open'}
							class:text-hub-warning={statusFilter === 'open'}
							class:border-hub-border={statusFilter !== 'open'}
							class:text-hub-muted={statusFilter !== 'open'}
						>Open</button>
						<button
							onclick={() => (statusFilter = 'shipped')}
							class="px-3 py-2 rounded-lg border transition-colors cursor-pointer"
							class:border-hub-info={statusFilter === 'shipped'}
							class:text-hub-info={statusFilter === 'shipped'}
							class:border-hub-border={statusFilter !== 'shipped'}
							class:text-hub-muted={statusFilter !== 'shipped'}
						>Shipped</button>
						<button
							onclick={() => (statusFilter = 'archived')}
							class="px-3 py-2 rounded-lg border transition-colors cursor-pointer"
							class:border-hub-dim={statusFilter === 'archived'}
							class:text-hub-dim={statusFilter === 'archived'}
							class:border-hub-border={statusFilter !== 'archived'}
							class:text-hub-muted={statusFilter !== 'archived'}
						>Quiet</button>
					</div>
					<!-- projects-graph ADR-001 — scope by declared project_shape. -->
					<select
						bind:value={shapeFilter}
						class="px-2 py-2 rounded-lg border border-hub-border bg-transparent text-xs text-hub-muted hover:text-hub-text focus:outline-none focus:border-hub-cta/50 transition-colors cursor-pointer"
						class:border-hub-cta={shapeFilter !== 'all'}
						class:text-hub-cta={shapeFilter !== 'all'}
						title="Filter by project shape"
					>
						<option value="all">all shapes</option>
						{#each PROJECT_SHAPES_UI as s}
							<option value={s}>{s}</option>
						{/each}
					</select>

					<!-- projects-graph ADR-012 — scope by cluster: tag. Sourced
					     dynamically from the loaded project list so new clusters
					     surface without code changes. -->
					<select
						bind:value={clusterFilter}
						class="px-2 py-2 rounded-lg border border-hub-border bg-transparent text-xs text-hub-muted hover:text-hub-text focus:outline-none focus:border-hub-cta/50 transition-colors cursor-pointer"
						class:border-hub-cta={clusterFilter !== 'all'}
						class:text-hub-cta={clusterFilter !== 'all'}
						title="Filter by cluster: tag on the project root index"
					>
						<option value="all">all clusters</option>
						<option value="ungrouped">ungrouped</option>
						{#each clusters as c}
							<option value={c}>cluster:{c}</option>
						{/each}
					</select>

					<!-- projects-graph ADR-012 — sort dropdown; persisted via
					     vault-projects-sort-pref. Default `recency` matches
					     today's behavior verbatim. -->
					<select
						bind:value={sortPref}
						class="px-2 py-2 rounded-lg border border-hub-border bg-transparent text-xs text-hub-muted hover:text-hub-text focus:outline-none focus:border-hub-cta/50 transition-colors cursor-pointer"
						title="Sort projects"
					>
						<option value="recency">recency</option>
						<option value="name">name (A→Z)</option>
						<option value="adr-count">ADR count</option>
						<option value="falsifier">falsifier urgency</option>
						<option value="shape">shape</option>
					</select>
				</div>

				{#if view === 'graph'}
					<!-- projects-graph ADR-005 — graph view (opt-in). Reuses
					     VaultGraph in hierarchical mode (dagre Sugiyama via
					     ADR-016's computeNetworkLayout). Filter bar above
					     applies to both views; node click navigates to the
					     project detail page. -->
					{#if graphLoading}
						<div class="flex items-center justify-center min-h-[480px]">
							<div class="text-hub-muted text-sm">Loading graph…</div>
						</div>
					{:else if graphError}
						<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger mb-4 flex items-center justify-between">
							<span>{graphError}</span>
							<button onclick={() => { projectGraph = null; loadProjectGraph(); }} class="text-xs underline cursor-pointer">Retry</button>
						</div>
					{:else if !projectGraph || filteredGraphNodes.length === 0}
						<p class="text-hub-dim text-xs py-6 text-center">No projects match the current filter.</p>
					{:else}
						<div class="rounded-lg border border-hub-border bg-hub-card/30 overflow-hidden" style="height: min(75vh, 720px);">
							<VaultGraph
								nodes={filteredGraphNodes}
								edges={filteredGraphEdges}
								layout="hierarchical"
								onNodeClick={onGraphNodeClick}
							/>
						</div>
						<p class="text-[10px] text-hub-dim/60 mt-2">
							Project graph · {filteredGraphNodes.length} projects · {filteredGraphEdges.length} parent_project edges · colors = project_shape · click node → detail
						</p>
					{/if}
				{:else if visibleCount === 0}
					<p class="text-hub-dim text-xs py-6 text-center">No projects match the current filter.</p>
				{:else}
					<div class="flex flex-col gap-2">
						{#each filtered as node (node.project.slug)}
							{@render treeRow(node)}
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
