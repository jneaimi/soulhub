<script lang="ts">
	import { onMount } from 'svelte';
	import DecisionActions from '$lib/components/projects/DecisionActions.svelte';
	import AdrDrawer from '$lib/components/projects/AdrDrawer.svelte';

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

	let rows = $state<QueueRow[]>([]);
	let loading = $state(true);
	let error = $state('');
	let drawerPath = $state<string | null>(null);

	async function load() {
		error = '';
		try {
			const res = await fetch('/api/vault/decisions/queue');
			if (!res.ok) throw new Error(`Queue load failed: ${res.status}`);
			const data = await res.json();
			rows = data.decisions ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load queue';
		} finally {
			loading = false;
		}
	}

	function handleTransition(info: { path: string }) {
		// Drop the row optimistically — the server already mutated.
		rows = rows.filter((r) => r.path !== info.path);
	}

	function falsifierClass(daysAway: number | null): string {
		if (daysAway === null) return 'text-hub-dim';
		if (daysAway <= 7) return 'text-hub-danger';
		if (daysAway <= 30) return 'text-hub-warning';
		return 'text-hub-dim';
	}

	function falsifierLabel(daysAway: number | null, date: string | null): string {
		if (daysAway === null || !date) return '';
		if (daysAway < 0) return `expired ${-daysAway}d ago`;
		if (daysAway === 0) return 'expires today';
		return `${daysAway}d → ${date}`;
	}

	onMount(() => { load(); });
</script>

<svelte:head>
	<title>Decision Queue | Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Header + sub-nav -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto">
			<div class="flex items-center justify-between mb-3">
				<div class="flex items-center gap-3">
					<h1 class="text-lg font-semibold text-hub-text">Decision Queue</h1>
					{#if rows.length > 0}
						<span class="text-hub-dim font-normal text-sm">({rows.length} awaiting)</span>
					{/if}
				</div>
				<div class="text-xs text-hub-dim">
					Oldest first · click row to view · accept clears one click · reject requires a reason
				</div>
			</div>
			<nav class="flex items-center gap-1 text-xs">
				<a href="/projects" class="px-3 py-1.5 rounded-md text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer">
					All
				</a>
				<a href="/projects/queue" class="px-3 py-1.5 rounded-md bg-hub-card text-hub-text">
					Decision Queue
				</a>
			</nav>
		</div>
	</header>

	<!-- Main -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto">
			{#if loading}
				<div class="flex items-center justify-center py-20">
					<div class="text-hub-muted text-sm">Loading queue…</div>
				</div>
			{:else if error}
				<div class="bg-hub-danger/10 border border-hub-danger/30 rounded-lg px-4 py-3 text-sm text-hub-danger mb-6 flex items-center justify-between">
					<span>{error}</span>
					<button onclick={() => load()} class="text-xs underline cursor-pointer">Retry</button>
				</div>
			{:else if rows.length === 0}
				<div class="flex flex-col items-center justify-center py-20">
					<p class="text-hub-muted text-sm mb-1">Queue empty.</p>
					<p class="text-hub-dim text-xs">No proposed ADRs across any vault project.</p>
				</div>
			{:else}
				<div class="space-y-3">
					{#each rows as row (row.path)}
						<div class="border border-hub-border rounded-lg bg-hub-card/40 p-4">
							<div class="flex items-start justify-between gap-3 mb-2">
								<button
									onclick={() => drawerPath = row.path}
									class="min-w-0 flex-1 text-left cursor-pointer group"
								>
									<div class="flex items-center gap-2 text-[11px] text-hub-dim mb-1">
										<span class="text-hub-info">{row.project || '—'}</span>
										{#if row.created}
											<span>·</span>
											<span>{row.created}</span>
										{/if}
										{#if row.falsifierDate && row.falsifierDaysAway !== null}
											<span>·</span>
											<span class={falsifierClass(row.falsifierDaysAway)}>
												⏱ {falsifierLabel(row.falsifierDaysAway, row.falsifierDate)}
											</span>
										{/if}
										{#if row.blockedBy.length > 0}
											<span>·</span>
											<span class="text-hub-warning">blocked by {row.blockedBy.length}</span>
										{/if}
									</div>
									<h3 class="text-sm font-semibold text-hub-text group-hover:text-hub-info transition-colors">
										{row.title}
									</h3>
									<p class="text-[11px] text-hub-dim font-mono truncate mt-1">{row.path}</p>
								</button>
								<DecisionActions path={row.path} size="md" onTransition={handleTransition} />
							</div>

							{#if row.tags.length > 0}
								<div class="flex flex-wrap items-center gap-1 mt-2">
									{#each row.tags.slice(0, 6) as tag}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-dim">{tag}</span>
									{/each}
									{#if row.tags.length > 6}
										<span class="text-[10px] text-hub-dim">+{row.tags.length - 6}</span>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<AdrDrawer
	path={drawerPath}
	onClose={() => drawerPath = null}
	onTransition={handleTransition}
/>
