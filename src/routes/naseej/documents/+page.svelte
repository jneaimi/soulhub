<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	interface DocEntry {
		slug: string;
		name: string;
		brand: string;
		lang: string;
		component_count: number;
		document_path: string;
	}

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let docs = $state<DocEntry[]>([]);
	let newSlug = $state('');
	let createError = $state<string | null>(null);
	const SLUG_RE = /^[a-z][a-z0-9-]*$/;

	async function load() {
		loading = true;
		try {
			const res = await fetch('/api/documents');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			docs = ((await res.json()) as { results: DocEntry[] }).results;
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function createDoc() {
		const slug = newSlug.trim().toLowerCase();
		if (!SLUG_RE.test(slug)) {
			createError = 'slug must be kebab-case and start with a letter';
			return;
		}
		if (docs.some((d) => d.slug === slug)) {
			createError = `a document "${slug}" already exists`;
			return;
		}
		createError = null;
		goto(`/naseej/documents/${slug}`);
	}

	onMount(load);
</script>

<svelte:head><title>Documents — Naseej — Soul Hub</title></svelte:head>

<main class="h-full overflow-y-auto">
	<div class="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6">
		<header class="mb-6 flex items-start justify-between gap-4 flex-wrap">
			<div>
				<h1 class="text-2xl font-semibold tracking-tight text-hub-text">Documents</h1>
				<p class="mt-1 text-sm text-hub-muted max-w-2xl">
					Document templates compose presentation components with a brand and per-slot classes —
					<span class="text-hub-text">static</span> set once, <span class="text-hub-text">deterministic</span>
					computed at run, <span class="text-hub-text">judgment</span> drafted by AI.
				</p>
			</div>
			<div class="flex items-center gap-2">
				<a href="/naseej" class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors">Components</a>
				<a href="/naseej/brands" class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors">Brands</a>
				<button onclick={load} disabled={loading} class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer">{loading ? 'Loading…' : 'Reload'}</button>
			</div>
		</header>

		{#if loadError}
			<div class="mb-4 px-4 py-3 border border-hub-danger/30 bg-hub-danger/10 text-hub-danger text-sm rounded-md" role="alert">Failed to load documents: {loadError}</div>
		{/if}

		<div class="mb-5 flex items-end gap-2 flex-wrap text-xs">
			<div class="flex flex-col gap-1">
				<label for="new-slug" class="text-hub-muted">New document slug</label>
				<input id="new-slug" type="text" placeholder="peer-brief" bind:value={newSlug}
					onkeydown={(e) => e.key === 'Enter' && createDoc()}
					class="min-w-[220px] px-3 py-1.5 font-mono bg-hub-card border border-hub-border rounded-md text-hub-text placeholder:text-hub-muted/40 focus:outline-none focus:ring-2 focus:ring-hub-info" />
			</div>
			<button onclick={createDoc} class="px-3 py-1.5 rounded-md bg-hub-cta hover:bg-hub-cta-hover text-hub-bg font-medium transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-hub-info">Create →</button>
			{#if createError}<span class="text-hub-danger self-center" role="alert">{createError}</span>{/if}
		</div>

		{#if loading && docs.length === 0}
			<div class="text-sm text-hub-muted py-12 text-center">Loading documents…</div>
		{:else if docs.length === 0}
			<div class="border border-dashed border-hub-border rounded-md py-12 text-center">
				<p class="text-sm text-hub-muted">No document templates yet. Create one above to compose a branded document.</p>
			</div>
		{:else}
			<ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{#each docs as doc}
					<li>
						<a href={`/naseej/documents/${doc.slug}`} class="block border border-hub-border rounded-md p-4 bg-hub-card/30 hover:bg-hub-card/60 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-hub-info">
							<div class="flex items-start justify-between gap-2 mb-3">
								<h2 class="text-sm font-semibold text-hub-text tracking-tight">{doc.name}</h2>
								<span class="text-[10px] font-mono text-hub-muted">{doc.slug}</span>
							</div>
							<div class="flex items-center gap-1.5 flex-wrap text-[10px]">
								<span class="px-1.5 py-0.5 rounded border bg-hub-info/10 text-hub-info border-hub-info/20">brand: {doc.brand}</span>
								<span class="px-1.5 py-0.5 rounded border bg-hub-card text-hub-muted border-hub-border">{doc.lang}</span>
								<span class="px-1.5 py-0.5 rounded border bg-hub-card text-hub-muted border-hub-border">{doc.component_count} component{doc.component_count === 1 ? '' : 's'}</span>
							</div>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</main>
