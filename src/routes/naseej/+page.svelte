<script lang="ts">
	import { onMount } from 'svelte';

	interface NaseejComponent {
		id: string;
		name: string;
		version: string;
		type?: string;
		category?: string;
		runtime?: string;
		description?: string;
		author?: string;
		project?: string;
		manifest_path: string;
	}

	interface ApiResponse {
		results: NaseejComponent[];
		total: number;
		facets: { categories: string[]; runtimes: string[] };
	}

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let components = $state<NaseejComponent[]>([]);
	let total = $state(0);
	let facets = $state<{ categories: string[]; runtimes: string[] }>({ categories: [], runtimes: [] });
	let category = $state<string>('');
	let runtime = $state<string>('');
	let q = $state<string>('');

	async function load() {
		loading = true;
		try {
			const params = new URLSearchParams();
			if (category) params.set('category', category);
			if (runtime) params.set('runtime', runtime);
			if (q) params.set('q', q);
			const qs = params.toString();
			const res = await fetch(`/api/components${qs ? `?${qs}` : ''}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as ApiResponse;
			components = data.results;
			total = data.total;
			// Facets are catalog-wide, not filter-dependent — only update them
			// on the unfiltered fetch so the dropdowns stay populated.
			if (!qs) facets = data.facets;
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	// Debounce search input so we don't refetch on every keystroke.
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	function scheduleLoad() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(load, 200);
	}

	onMount(load);

	function runtimeBadge(rt?: string): string {
		if (rt === 'python') return 'bg-blue-500/10 text-blue-300 border-blue-500/20';
		if (rt === 'node') return 'bg-green-500/10 text-green-300 border-green-500/20';
		if (rt === 'typescript') return 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20';
		return 'bg-hub-card text-hub-muted border-hub-border';
	}

	function categoryBadge(_cat?: string): string {
		return 'bg-hub-card text-hub-muted border-hub-border';
	}
</script>

<svelte:head>
	<title>Naseej — Soul Hub</title>
</svelte:head>

<main class="h-full overflow-y-auto">
	<div class="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6">
	<header class="mb-6 flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight text-hub-text">Naseej</h1>
			<p class="mt-1 text-sm text-hub-muted max-w-2xl">
				Composition engine for repeatable workflows. Components are typed, versioned, single-purpose
				capabilities. Recipes compose them.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<a
				href="/naseej/documents"
				class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors"
			>
				Documents
			</a>
			<a
				href="/naseej/brands"
				class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors"
			>
				Brands
			</a>
			<a
				href="/naseej/audit"
				class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors"
			>
				Audit
			</a>
			<button
				class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors"
				onclick={load}
				disabled={loading}
			>
				{loading ? 'Loading…' : 'Reload'}
			</button>
		</div>
	</header>

	{#if loadError}
		<div
			class="mb-4 px-4 py-3 border border-red-500/30 bg-red-500/10 text-red-300 text-sm rounded-md"
			role="alert"
		>
			Failed to load components: {loadError}
		</div>
	{/if}

	<!-- Filters -->
	<div class="mb-4 flex items-center gap-2 flex-wrap text-xs">
		<input
			type="text"
			placeholder="Search name or description…"
			bind:value={q}
			oninput={scheduleLoad}
			class="flex-1 min-w-[200px] px-3 py-1.5 bg-hub-card border border-hub-border rounded-md text-hub-text placeholder:text-hub-muted/50 focus:outline-none focus:border-hub-info"
		/>
		<select
			bind:value={category}
			onchange={load}
			class="px-3 py-1.5 bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:border-hub-info"
		>
			<option value="">All categories</option>
			{#each facets.categories as cat}
				<option value={cat}>{cat}</option>
			{/each}
		</select>
		<select
			bind:value={runtime}
			onchange={load}
			class="px-3 py-1.5 bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:border-hub-info"
		>
			<option value="">All runtimes</option>
			{#each facets.runtimes as rt}
				<option value={rt}>{rt}</option>
			{/each}
		</select>
		<span class="text-hub-muted ml-2">{components.length} shown</span>
	</div>

	<!-- Component cards -->
	{#if loading && components.length === 0}
		<div class="text-sm text-hub-muted py-12 text-center">Loading components…</div>
	{:else if components.length === 0 && (category || runtime || q)}
		<div class="border border-dashed border-hub-border rounded-md py-12 text-center">
			<p class="text-sm text-hub-muted">No components match the current filter.</p>
		</div>
		{:else if components.length === 0}
		<div class="border border-dashed border-hub-border rounded-md py-12 text-center">
			<p class="text-sm text-hub-muted">
				No components published yet. Drop a <code class="text-xs bg-hub-card px-1 rounded">BLOCK.md</code>
				under <code class="text-xs bg-hub-card px-1 rounded">catalog/components/&lt;name&gt;/</code> and reload.
			</p>
		</div>
	{:else}
		<ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
			{#each components as comp}
				<li
					class="border border-hub-border rounded-md p-4 bg-hub-card/30 hover:bg-hub-card/60 transition-colors"
				>
					<div class="flex items-start justify-between gap-2 mb-2">
						<h2 class="text-sm font-semibold text-hub-text tracking-tight">
							{comp.name}
						</h2>
						<span class="text-[10px] font-mono text-hub-muted">v{comp.version}</span>
					</div>
					{#if comp.description}
						<p class="text-xs text-hub-muted mb-3 line-clamp-3">{comp.description}</p>
					{/if}
					<div class="flex items-center gap-1.5 flex-wrap text-[10px]">
						{#if comp.category}
							<span class="px-1.5 py-0.5 rounded border {categoryBadge(comp.category)}">
								{comp.category}
							</span>
						{/if}
						{#if comp.runtime}
							<span class="px-1.5 py-0.5 rounded border {runtimeBadge(comp.runtime)}">
								{comp.runtime}
							</span>
						{/if}
						{#if comp.project}
							<span class="px-1.5 py-0.5 rounded border bg-hub-card text-hub-muted border-hub-border">
								{comp.project}
							</span>
						{/if}
					</div>
					<div class="mt-3 pt-3 border-t border-hub-border/50 text-[10px] font-mono text-hub-muted/70">
						{comp.manifest_path}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
	</div>
</main>
