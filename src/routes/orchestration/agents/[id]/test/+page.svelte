<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import AgentTestChat from '$lib/components/agents/AgentTestChat.svelte';

	type Backend = 'claude-pty' | 'claude-cli-flag' | 'ai-sdk';

	interface AgentSummary {
		id: string;
		name: string;
		description: string;
		backend: Backend;
		model?: string;
		provider?: string;
		source_path: string;
		budget?: { max_usd?: number; max_turns?: number; timeout_sec?: number };
	}

	let agent = $state<AgentSummary | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	const id = $derived($page.params.id ?? '');

	async function load() {
		try {
			const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
			if (res.status === 404) {
				goto('/orchestration/agents');
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			agent = data.agent ?? null;
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);
</script>

<svelte:head>
	<title>{agent?.name ? `Test ${agent.name}` : 'Test agent'} · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg" data-agents>
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-5xl mx-auto w-full">
			<a
				href="/orchestration/agents"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to agents"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div class="flex items-center gap-2 min-w-0">
				<svg class="w-5 h-5 text-hub-cta flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
				</svg>
				<h1 class="text-lg font-semibold text-hub-text truncate">
					Test {agent?.name ?? id}
				</h1>
			</div>
			<div class="flex-1"></div>
			<a
				href="/orchestration/agents/{encodeURIComponent(id)}/edit"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
			>
				✎ Edit
			</a>
		</div>
		{#if agent?.description}
			<p class="max-w-5xl mx-auto w-full text-xs text-hub-muted mt-1.5 truncate">
				{agent.description}
			</p>
		{/if}
	</header>

	<!-- Body -->
	<div class="flex-1 overflow-hidden px-4 sm:px-6 py-4">
		<div class="max-w-5xl mx-auto h-full">
			{#if loading}
				<div class="h-full bg-hub-card rounded-xl border border-hub-border motion-safe:animate-pulse"></div>
			{:else if loadError}
				<div class="bg-hub-card border border-hub-danger/40 rounded-xl p-4 text-sm text-hub-danger">
					Failed to load agent: {loadError}
				</div>
			{:else if agent}
				<AgentTestChat {agent} />
			{/if}
		</div>
	</div>
</div>
