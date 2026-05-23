<script lang="ts">
	interface AssignmentState {
		role: string;
		status: string;
		error?: string;
	}

	interface PhaseState {
		id: string;
		type: string;
		status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';
		assignments: AssignmentState[];
		depends_on?: string[];
		error?: string;
		iterations?: number;
	}

	let { phases = [] } = $props<{ phases: PhaseState[] }>();

	const phaseTypeColors: Record<string, string> = {
		sequential: 'bg-hub-info/15 text-hub-info',
		parallel: 'bg-hub-purple/15 text-hub-purple',
		handoff: 'bg-hub-warning/15 text-hub-warning',
		human: 'bg-hub-cta/15 text-hub-cta',
		gate: 'bg-hub-danger/15 text-hub-danger',
		consensus: 'bg-hub-dim/15 text-hub-dim',
	};

	const statusDotColors: Record<string, string> = {
		pending: 'bg-hub-border',
		running: 'bg-hub-info animate-pulse',
		completed: 'bg-hub-cta',
		failed: 'bg-hub-danger',
		skipped: 'bg-hub-border',
		paused: 'bg-hub-warning animate-pulse',
	};

	const statusTextColors: Record<string, string> = {
		pending: 'text-hub-dim',
		running: 'text-hub-info',
		completed: 'text-hub-cta',
		failed: 'text-hub-danger',
		skipped: 'text-hub-dim',
		paused: 'text-hub-warning',
	};
</script>

{#if phases.length > 0}
	<section>
		<h2 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-2">Progress</h2>
		<div class="border border-hub-border rounded-lg divide-y divide-hub-border/50">
			{#each phases as ps, i}
				<div class="px-3 py-2.5">
					<div class="flex items-center gap-2">
						<span class="w-2 h-2 rounded-full flex-shrink-0 {statusDotColors[ps.status] || 'bg-hub-border'}"></span>
						<span class="text-sm font-medium {statusTextColors[ps.status] || 'text-hub-dim'}">{ps.id}</span>
						<span class="px-1.5 py-0.5 rounded text-[10px] font-medium {phaseTypeColors[ps.type] || 'bg-hub-dim/15 text-hub-dim'}">
							{ps.type}
						</span>
						{#if ps.depends_on?.length}
							<span class="text-[10px] text-hub-dim">
								depends: {ps.depends_on.join(', ')}
							</span>
						{/if}
						{#if ps.iterations}
							<span class="text-[10px] text-hub-dim">iter: {ps.iterations}</span>
						{/if}
						<span class="ml-auto text-[10px] text-hub-dim">{ps.status}</span>
					</div>
					{#if ps.assignments.length > 0}
						<div class="mt-1.5 ml-4 space-y-1">
							{#each ps.assignments as a}
								<div class="flex items-center gap-2 text-xs">
									<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {statusDotColors[a.status] || 'bg-hub-border'}"></span>
									<span class="{statusTextColors[a.status] || 'text-hub-dim'}">{a.role}</span>
									<span class="text-hub-dim">{a.status}</span>
									{#if a.error}
										<span class="text-hub-danger text-[10px]">{a.error}</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if ps.error}
						<div class="mt-1.5 ml-4 text-xs text-hub-danger">{ps.error}</div>
					{/if}
				</div>
			{/each}
		</div>
	</section>
{/if}
