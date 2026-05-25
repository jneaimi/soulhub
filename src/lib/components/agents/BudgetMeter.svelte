<script lang="ts">
	interface Props {
		spentUsd: number;
		softUsd: number;       // configured max_usd (soft cap)
		ceilingUsd: number;    // hard ceiling (default 2× soft if unset upstream)
		subagentUsd?: number;  // optional sub-agent rollup portion of spent
		compact?: boolean;
	}
	let { spentUsd, softUsd, ceilingUsd, subagentUsd, compact = false }: Props = $props();

	// Bar fills relative to the CEILING (the true wall). Soft cap is a marker.
	const pct = $derived(ceilingUsd > 0 ? Math.min(100, (spentUsd / ceilingUsd) * 100) : 0);
	const softPct = $derived(ceilingUsd > 0 ? Math.min(100, (softUsd / ceilingUsd) * 100) : 0);
	// Colour band: cta below soft, warning between soft and ceiling, danger at/above ceiling.
	const barColor = $derived(
		spentUsd >= ceilingUsd ? 'bg-hub-danger' : spentUsd >= softUsd ? 'bg-hub-warning' : 'bg-hub-cta'
	);
</script>

<div class="w-full">
	<div class="relative h-1.5 w-full rounded-full bg-hub-bg overflow-hidden">
		<div class="h-full {barColor} motion-safe:transition-all" style="width: {pct}%"></div>
		<!-- soft-cap marker -->
		<div class="absolute top-0 h-full w-px bg-hub-muted/60" style="left: {softPct}%"></div>
	</div>
	{#if !compact}
		<div class="mt-1 flex items-center justify-between text-[10px] text-hub-muted font-mono">
			<span>${spentUsd.toFixed(2)} / ${ceilingUsd.toFixed(2)}</span>
			<span class="text-hub-dim">soft ${softUsd.toFixed(2)}{#if subagentUsd}{' · '}sub ${subagentUsd.toFixed(2)}{/if}</span>
		</div>
	{/if}
</div>
