<script lang="ts">
	let { status = '', phases = [], elapsed = '', error = '' } = $props<{
		status: string;
		phases: any[];
		elapsed: string;
		error: string;
	}>();

	const completedCount = $derived(phases.filter((p: any) => p.status === 'completed').length);
	const failedCount = $derived(phases.filter((p: any) => p.status === 'failed').length);

	const statusDotColors: Record<string, string> = {
		pending: 'bg-hub-border',
		running: 'bg-hub-info',
		completed: 'bg-hub-cta',
		failed: 'bg-hub-danger',
		skipped: 'bg-hub-border',
	};

	const statusTextColors: Record<string, string> = {
		pending: 'text-hub-dim',
		running: 'text-hub-info',
		completed: 'text-hub-cta',
		failed: 'text-hub-danger',
		skipped: 'text-hub-dim',
	};
</script>

<section>
	<h2 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-2">Result</h2>
	<div class="border border-hub-border rounded-lg p-4">
		<div class="flex items-center gap-2 mb-2">
			<span class="w-2.5 h-2.5 rounded-full {status === 'completed' ? 'bg-hub-cta' : 'bg-hub-danger'}"></span>
			<span class="text-sm font-medium {status === 'completed' ? 'text-hub-cta' : 'text-hub-danger'}">
				{status === 'completed' ? 'Completed' : 'Failed'}
			</span>
			<span class="text-xs text-hub-dim ml-1">
				{completedCount}/{phases.length} phases
				{#if failedCount > 0}
					({failedCount} failed)
				{/if}
			</span>
			{#if elapsed}
				<span class="ml-auto text-xs text-hub-dim">{elapsed}</span>
			{/if}
		</div>
		{#if error}
			<div class="mt-2 text-xs text-hub-danger border border-hub-danger/20 bg-hub-danger/5 rounded px-2 py-1.5">
				{error}
			</div>
		{/if}
		{#if phases.length > 0}
			<div class="mt-2 space-y-1">
				{#each phases as phase}
					<div class="flex items-center gap-2 text-xs">
						<span class="w-1.5 h-1.5 rounded-full {statusDotColors[phase.status] || 'bg-hub-border'}"></span>
						<span class="text-hub-muted">{phase.id}</span>
						<span class="{statusTextColors[phase.status] || 'text-hub-dim'}">{phase.status}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</section>
