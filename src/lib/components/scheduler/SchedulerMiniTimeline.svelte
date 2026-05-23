<script lang="ts">
	interface UpcomingRun {
		at: number;
		taskId: string;
	}

	interface Props {
		runs: UpcomingRun[];
		nowMs: number;
		windowHours?: number;
	}

	let { runs, nowMs, windowHours = 6 }: Props = $props();

	const horizonMs = $derived(windowHours * 60 * 60 * 1000);

	const ticks = $derived.by(() => {
		const horizonEnd = nowMs + horizonMs;
		return runs
			.filter((r) => r.at >= nowMs && r.at <= horizonEnd)
			.map((r) => ({
				taskId: r.taskId,
				pct: ((r.at - nowMs) / horizonMs) * 100,
				atMs: r.at,
				label: relLabel(r.at - nowMs),
			}));
	});

	function relLabel(deltaMs: number): string {
		const mins = Math.round(deltaMs / 60_000);
		if (mins < 60) return `in ${mins}m`;
		const hours = Math.floor(mins / 60);
		return `in ${hours}h ${mins % 60}m`;
	}
</script>

<div class="relative h-8 w-full" aria-label="Upcoming runs in the next {windowHours} hours">
	<!-- baseline -->
	<div class="absolute top-1/2 left-0 right-0 h-px bg-hub-border/60"></div>

	<!-- tick marks -->
	{#each ticks as t (t.atMs + t.taskId)}
		<div
			class="absolute top-1/2 -translate-y-1/2 group"
			style="left: {t.pct}%"
			title="{t.taskId} · {t.label}"
		>
			<div class="w-px h-4 bg-hub-cta/70 group-hover:bg-hub-cta transition-colors"></div>
		</div>
	{/each}

	<!-- horizon labels -->
	<div class="absolute bottom-0 left-0 text-[9px] text-hub-dim leading-none">now</div>
	<div class="absolute bottom-0 right-0 text-[9px] text-hub-dim leading-none">+{windowHours}h</div>
</div>

{#if ticks.length === 0}
	<div class="text-[10px] text-hub-dim mt-0.5">No runs in next {windowHours}h</div>
{/if}
