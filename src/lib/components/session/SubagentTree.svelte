<script lang="ts">
	import type { SubagentRollup } from '$lib/sessions/types.js';

	interface Props {
		ptySessionId: string;
		claudeSessionId: string;
		subagents: SubagentRollup[];
	}

	let { ptySessionId, claudeSessionId, subagents }: Props = $props();

	let expanded = $state<Set<string>>(new Set());
	let drillCache = $state<Record<string, { loading: boolean; error?: string; tools?: Record<string, number>; eventCount?: number }>>({});

	async function toggle(agentId: string) {
		const next = new Set(expanded);
		if (next.has(agentId)) {
			next.delete(agentId);
			expanded = next;
			return;
		}
		next.add(agentId);
		expanded = next;
		if (drillCache[agentId]) return;
		drillCache = { ...drillCache, [agentId]: { loading: true } };
		try {
			const res = await fetch(`/api/sessions/${ptySessionId}/claude/${claudeSessionId}/subagents/${agentId}`);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				drillCache = { ...drillCache, [agentId]: { loading: false, error: j.error ?? `HTTP ${res.status}` } };
				return;
			}
			const data = await res.json();
			drillCache = { ...drillCache, [agentId]: {
				loading: false,
				tools: data.summary?.toolBreakdown,
				eventCount: data.summary?.eventCount,
			} };
		} catch (e) {
			drillCache = { ...drillCache, [agentId]: { loading: false, error: (e as Error).message } };
		}
	}

	function fmtUsd(n: number | null | undefined): string {
		if (n === null || n === undefined) return '—';
		if (n < 0.01) return `$${n.toFixed(4)}`;
		return `$${n.toFixed(2)}`;
	}

	function fmtTokens(n: number | undefined): string {
		if (!n) return '0';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return String(n);
	}

	function fmtMs(n: number | undefined): string {
		if (!n) return '—';
		if (n < 1000) return `${n}ms`;
		return `${(n / 1000).toFixed(1)}s`;
	}
</script>

{#if subagents.length === 0}
	<p class="text-xs text-hub-dim py-6 text-center">No sub-agents spawned in this session.</p>
{:else}
	<div class="space-y-2">
		{#each subagents as sa (sa.agentId)}
			<div class="border border-hub-border/40 rounded-lg overflow-hidden">
				<button
					onclick={() => toggle(sa.agentId)}
					class="w-full text-left p-3 hover:bg-hub-surface/40 transition-colors cursor-pointer"
				>
					<div class="flex items-center justify-between gap-2 mb-1">
						<div class="flex items-center gap-2 min-w-0">
							<span class="text-xs px-1.5 py-0.5 rounded bg-hub-purple/15 text-hub-purple font-mono">{sa.agentType}</span>
							<span class="text-[10px] text-hub-dim {sa.status === 'completed' ? 'text-hub-cta' : sa.status === 'error' ? 'text-hub-danger' : ''}">{sa.status}</span>
						</div>
						<span class="text-xs text-hub-text font-mono">{fmtUsd(sa.cost)}</span>
					</div>
					<div class="flex items-center gap-3 text-[10px] text-hub-dim">
						<span>{fmtMs(sa.totalDurationMs)}</span>
						<span>{fmtTokens(sa.totalTokens)} tokens</span>
						<span>{sa.totalToolUseCount ?? 0} tool calls</span>
					</div>
					{#if sa.descriptionPrompt}
						<div class="text-[11px] text-hub-muted mt-1 line-clamp-2">{sa.descriptionPrompt}</div>
					{/if}
				</button>
				{#if expanded.has(sa.agentId)}
					<div class="border-t border-hub-border/40 bg-hub-bg/30 p-3">
						{#if drillCache[sa.agentId]?.loading}
							<p class="text-[11px] text-hub-dim">Loading sub-agent log…</p>
						{:else if drillCache[sa.agentId]?.error}
							<p class="text-[11px] text-hub-danger">{drillCache[sa.agentId].error}</p>
						{:else if drillCache[sa.agentId]?.tools}
							<div class="text-[11px] text-hub-muted mb-2">{drillCache[sa.agentId].eventCount ?? 0} events captured</div>
							<div class="flex flex-wrap gap-1.5">
								{#each Object.entries(drillCache[sa.agentId].tools ?? {}).sort((a, b) => b[1] - a[1]) as [name, count]}
									<span class="text-[10px] px-2 py-0.5 rounded-full bg-hub-bg text-hub-muted border border-hub-border/40">
										{name} <span class="text-hub-dim">·{count}</span>
									</span>
								{/each}
							</div>
						{:else if sa.toolStats && Object.keys(sa.toolStats).length > 0}
							<!-- Fall back to the summary tool stats from parent (no drill load needed) -->
							<div class="flex flex-wrap gap-1.5">
								{#each Object.entries(sa.toolStats).sort((a, b) => b[1] - a[1]) as [name, count]}
									<span class="text-[10px] px-2 py-0.5 rounded-full bg-hub-bg text-hub-muted border border-hub-border/40">
										{name} <span class="text-hub-dim">·{count}</span>
									</span>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
