<script lang="ts">
	import SessionTimeline from '$lib/components/session/SessionTimeline.svelte';
</script>

<svelte:head>
	<title>Sessions — Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col bg-hub-bg">
	<header class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border bg-hub-surface">
		<div class="flex items-center gap-3">
			<div class="flex items-center gap-2">
				<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
				</svg>
				<h1 class="text-base font-semibold text-hub-text">Sessions</h1>
			</div>
			<span class="text-[10px] text-hub-dim hidden sm:inline">terminal · pipelines · playbooks · claude</span>
			<div class="flex-1"></div>
		</div>
	</header>

	<div class="flex-1 min-h-0">
		<SessionTimeline defaultWindow="7d" />
	</div>
</div>
