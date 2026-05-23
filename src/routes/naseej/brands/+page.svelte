<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	interface BrandListEntry {
		slug: string;
		name: string;
		colors: number;
		swatches: string[];
		has_logo: boolean;
		brand_path: string;
	}

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let brands = $state<BrandListEntry[]>([]);

	let newSlug = $state('');
	let createError = $state<string | null>(null);

	const SLUG_RE = /^[a-z][a-z0-9-]*$/;

	async function load() {
		loading = true;
		try {
			const res = await fetch('/api/brands');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { results: BrandListEntry[] };
			brands = data.results;
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function createBrand() {
		const slug = newSlug.trim().toLowerCase();
		if (!SLUG_RE.test(slug)) {
			createError = 'slug must be kebab-case and start with a letter (e.g. acme-corp)';
			return;
		}
		if (brands.some((b) => b.slug === slug)) {
			createError = `a brand "${slug}" already exists`;
			return;
		}
		createError = null;
		goto(`/naseej/brands/${slug}`);
	}

	onMount(load);
</script>

<svelte:head>
	<title>Brands — Naseej — Soul Hub</title>
</svelte:head>

<main class="h-full overflow-y-auto">
	<div class="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6">
		<header class="mb-6 flex items-start justify-between gap-4 flex-wrap">
			<div>
				<h1 class="text-2xl font-semibold tracking-tight text-hub-text">Brands</h1>
				<p class="mt-1 text-sm text-hub-muted max-w-2xl">
					Brand profiles are catalog data. Colors, fonts, identity, and a logo — set once, applied
					to every rendered document by slug.
				</p>
			</div>
			<div class="flex items-center gap-2">
				<a
					href="/naseej"
					class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors"
				>
					Components
				</a>
				<button
					class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
					onclick={load}
					disabled={loading}
				>
					{loading ? 'Loading…' : 'Reload'}
				</button>
			</div>
		</header>

		{#if loadError}
			<div
				class="mb-4 px-4 py-3 border border-hub-danger/30 bg-hub-danger/10 text-hub-danger text-sm rounded-md"
				role="alert"
			>
				Failed to load brands: {loadError}
			</div>
		{/if}

		<!-- New brand -->
		<div class="mb-5 flex items-end gap-2 flex-wrap text-xs">
			<div class="flex flex-col gap-1">
				<label for="new-slug" class="text-hub-muted">New brand slug</label>
				<input
					id="new-slug"
					type="text"
					placeholder="acme-corp"
					bind:value={newSlug}
					onkeydown={(e) => e.key === 'Enter' && createBrand()}
					class="min-w-[220px] px-3 py-1.5 font-mono bg-hub-card border border-hub-border rounded-md text-hub-text placeholder:text-hub-muted/40 focus:outline-none focus:ring-2 focus:ring-hub-info"
				/>
			</div>
			<button
				onclick={createBrand}
				class="px-3 py-1.5 rounded-md bg-hub-cta hover:bg-hub-cta-hover text-hub-bg font-medium transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-hub-info"
			>
				Create →
			</button>
			{#if createError}
				<span class="text-hub-danger self-center" role="alert">{createError}</span>
			{/if}
		</div>

		<!-- Brand cards -->
		{#if loading && brands.length === 0}
			<div class="text-sm text-hub-muted py-12 text-center">Loading brands…</div>
		{:else if brands.length === 0}
			<div class="border border-dashed border-hub-border rounded-md py-12 text-center">
				<p class="text-sm text-hub-muted">
					No brands yet. Create one above, or drop a
					<code class="text-xs bg-hub-card px-1 rounded">brand.yaml</code> under
					<code class="text-xs bg-hub-card px-1 rounded">catalog/brands/&lt;slug&gt;/</code>.
				</p>
			</div>
		{:else}
			<ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{#each brands as brand}
					<li>
						<a
							href={`/naseej/brands/${brand.slug}`}
							class="block border border-hub-border rounded-md p-4 bg-hub-card/30 hover:bg-hub-card/60 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-hub-info"
						>
							<div class="flex items-start justify-between gap-2 mb-3">
								<h2 class="text-sm font-semibold text-hub-text tracking-tight">{brand.name}</h2>
								<span class="text-[10px] font-mono text-hub-muted">{brand.slug}</span>
							</div>
							<!-- swatches -->
							<div class="flex items-center gap-1.5 mb-3" aria-label="brand colors">
								{#each brand.swatches as hex}
									<span
										class="w-5 h-5 rounded border border-hub-border"
										style={`background:${hex}`}
										title={hex}
									></span>
								{/each}
								{#if brand.swatches.length === 0}
									<span class="text-[10px] text-hub-muted">no colors set</span>
								{/if}
							</div>
							<div class="flex items-center gap-1.5 flex-wrap text-[10px]">
								<span class="px-1.5 py-0.5 rounded border bg-hub-card text-hub-muted border-hub-border">
									{brand.colors} color{brand.colors === 1 ? '' : 's'}
								</span>
								<span
									class="px-1.5 py-0.5 rounded border {brand.has_logo
										? 'bg-hub-info/10 text-hub-info border-hub-info/20'
										: 'bg-hub-card text-hub-muted border-hub-border'}"
								>
									{brand.has_logo ? 'logo' : 'no logo'}
								</span>
							</div>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</main>
