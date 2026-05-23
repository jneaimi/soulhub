<script lang="ts">
	import SessionTimeline from '$lib/components/session/SessionTimeline.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Sessions — {data.name}</title>
</svelte:head>

<div class="h-full flex flex-col bg-hub-bg">
	<header class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border bg-hub-surface">
		<div class="flex items-center gap-3">
			<a
				href="/workspace/{data.name}"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to project"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div class="flex items-center gap-2 min-w-0">
				<svg class="w-5 h-5 text-hub-cta flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
				</svg>
				<h1 class="text-base font-semibold text-hub-text truncate">{data.name}</h1>
				<span class="text-xs text-hub-dim">/ Sessions</span>
			</div>
			<div class="flex-1"></div>
			{#if data.devPath}
				<span class="text-[10px] text-hub-dim font-mono truncate max-w-md hidden sm:block" title={data.devPath}>{data.devPath}</span>
			{/if}
		</div>
	</header>

	<div class="flex-1 min-h-0">
		{#if data.devPath}
			<SessionTimeline project={data.devPath} defaultWindow="7d" />
		{:else}
			<div class="p-12 text-center text-sm text-hub-dim">
				No project directory found at <code>~/dev/{data.name}</code>.
			</div>
		{/if}
	</div>
</div>
