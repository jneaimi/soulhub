<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import AgentWizard from '$lib/components/agents/AgentWizard.svelte';

	type Backend = 'claude-pty' | 'claude-cli-flag' | 'ai-sdk';
	type Provider = 'anthropic' | 'openai' | 'openrouter' | 'google' | 'mistral';

	interface FetchedAgent {
		id: string;
		name: string;
		description: string;
		backend: Backend;
		model?: string;
		provider?: Provider;
		tools: string[];
		skills: string[];
		system_prompt: string;
		chat_dispatchable?: boolean;
		goal_condition?: string;
	}

	let initial = $state<Partial<FetchedAgent> | null>(null);
	let loadError = $state<string | null>(null);

	const id = $derived($page.params.id ?? '');

	onMount(async () => {
		try {
			const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
			if (res.status === 404) {
				goto('/orchestration/agents');
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			initial = data.agent as FetchedAgent;
		} catch (err) {
			loadError = (err as Error).message;
		}
	});
</script>

<svelte:head>
	<title>Edit {id} · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg" data-agents>
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-4xl mx-auto w-full">
			<a
				href="/orchestration/agents"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to agents"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div class="flex items-center gap-2">
				<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>
				</svg>
				<h1 class="text-lg font-semibold text-hub-text">Edit · <span class="font-mono">{id}</span></h1>
			</div>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-4xl mx-auto w-full">
			{#if loadError}
				<div class="bg-hub-card border border-hub-danger/40 rounded-xl p-4 text-sm text-hub-danger">
					Failed to load agent: {loadError}
				</div>
			{:else if !initial}
				<div class="space-y-2">
					{#each Array(3) as _, i (i)}
						<div class="h-32 bg-hub-card rounded-xl border border-hub-border motion-safe:animate-pulse"></div>
					{/each}
				</div>
			{:else}
				<AgentWizard mode="edit" {initial} />
			{/if}
		</div>
	</div>
</div>
