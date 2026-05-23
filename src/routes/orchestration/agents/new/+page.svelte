<script lang="ts">
	import AgentWizard from '$lib/components/agents/AgentWizard.svelte';
</script>

<svelte:head>
	<title>New agent · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg" data-agents>
	<!-- Header -->
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
				<h1 class="text-lg font-semibold text-hub-text">New agent</h1>
			</div>
		</div>
	</header>

	<!-- Form -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-4xl mx-auto w-full">
			<AgentWizard mode="create" />
		</div>
	</div>
</div>
