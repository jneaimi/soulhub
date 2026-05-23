<script lang="ts">
	import TerminalTabs from '$lib/components/TerminalTabs.svelte';
</script>

<svelte:head>
	<title>Terminal — Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full">
	<!-- Header -->
	<header class="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-hub-border bg-hub-surface/30">
		<div class="flex items-center gap-2">
			<a
				href="/"
				class="p-1.5 rounded-lg text-hub-dim hover:text-hub-muted hover:bg-hub-card transition-colors cursor-pointer"
				aria-label="Back to dashboard"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="15 18 9 12 15 6"/>
				</svg>
			</a>
			<div class="flex items-center gap-1.5">
				<svg class="w-4 h-4 text-hub-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
				</svg>
				<h1 class="text-sm font-semibold text-hub-text">Terminal</h1>
			</div>
		</div>
	</header>

	<!-- Terminal fills remaining space -->
	<div class="flex-1 min-h-0">
		<TerminalTabs
			cwd=""
			projectName=""
			autoStart={true}
			autoStartShell={true}
		/>
	</div>
</div>
