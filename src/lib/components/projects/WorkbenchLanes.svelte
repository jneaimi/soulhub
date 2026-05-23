<script lang="ts">
	/** projects-graph ADR-018 (Handoff Workbench) S1 — renders the five
	 *  readiness lanes returned by /api/vault/projects/[slug]/worklist. Each
	 *  row opens the artifact in the AdrDrawer (via onSelect). Read surface;
	 *  the dispatch loop (S2) populates `in_flight` and adds row actions. */
	type Owner = 'ai' | 'human' | 'unassigned';
	type Item = {
		id: string;
		slug: string;
		title: string;
		type: string;
		status: string;
		assignee: string | null;
		owner: Owner;
		work_type: string | null;
		blockedBy: string[];
		blockedByUnmet: string[];
	};
	type Lane = 'ready_for_ai' | 'waiting_on_you' | 'ready_for_you' | 'waiting_on_ai' | 'in_flight';

	// `lanes` arrives as untyped JSON from /worklist; cast each lane's rows to
	// Item[] at the render boundary (below) rather than claim the shape upstream.
	let {
		lanes,
		loading = false,
		error = '',
		onSelect,
	}: {
		lanes: Record<string, unknown[]> | null;
		loading?: boolean;
		error?: string;
		onSelect: (path: string) => void;
	} = $props();

	// Ordered lane metadata. `accent` is a left-border + dot color token.
	const LANES: { key: Lane; label: string; hint: string; accent: string }[] = [
		{ key: 'ready_for_ai', label: 'Ready for AI', hint: 'AI-owned, unblocked', accent: 'bg-hub-cta' },
		{ key: 'waiting_on_you', label: 'Waiting on you', hint: 'AI blocked by an upstream', accent: 'bg-hub-warning' },
		{ key: 'ready_for_you', label: 'Ready for you', hint: 'yours, unblocked', accent: 'bg-hub-info' },
		{ key: 'waiting_on_ai', label: 'Waiting on AI', hint: 'blocked by an upstream', accent: 'bg-hub-dim' },
		{ key: 'in_flight', label: 'In flight', hint: 'agent run active', accent: 'bg-hub-muted' },
	];

	function statusClass(status: string): string {
		switch (status) {
			case 'proposed': return 'bg-hub-warning/15 text-hub-warning';
			case 'accepted': return 'bg-hub-info/15 text-hub-info';
			default: return 'bg-hub-dim/15 text-hub-dim';
		}
	}
	function ownerLabel(it: Item): string {
		if (it.owner === 'ai') return `AI · ${it.assignee}`;
		if (it.owner === 'human') return it.assignee ?? 'you';
		return 'unassigned';
	}
</script>

{#if loading}
	<p class="text-sm text-hub-dim py-6 text-center">Loading worklist…</p>
{:else if error}
	<p class="text-sm text-hub-danger py-6 text-center">{error}</p>
{:else if lanes}
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
		{#each LANES as lane (lane.key)}
			{@const items = (lanes[lane.key] ?? []) as Item[]}
			<div class="rounded-lg border border-hub-border bg-hub-card/30 overflow-hidden">
				<div class="flex items-center gap-2 px-3 py-2 border-b border-hub-border/60">
					<span class="w-1.5 h-1.5 rounded-full {lane.accent}"></span>
					<span class="text-xs font-semibold text-hub-text">{lane.label}</span>
					<span class="text-[10px] text-hub-dim ml-auto">{items.length}</span>
				</div>
				{#if items.length === 0}
					<p class="px-3 py-3 text-[11px] text-hub-dim italic">{lane.hint}</p>
				{:else}
					<div class="p-1.5 space-y-0.5">
						{#each items as it (it.id)}
							<button
								type="button"
								class="w-full text-left px-2 py-1.5 rounded hover:bg-hub-card/70 transition-colors cursor-pointer group"
								onclick={() => onSelect(it.id)}
							>
								<div class="flex items-center gap-2">
									<span class="text-[12px] text-hub-text group-hover:text-hub-cta transition-colors truncate flex-1">{it.title}</span>
									<span class="shrink-0 px-1 py-0.5 rounded text-[9px] font-medium {statusClass(it.status)}">{it.status}</span>
								</div>
								<div class="flex items-center gap-2 mt-0.5 text-[10px] text-hub-dim">
									<span class="font-mono uppercase">{it.type}</span>
									<span>· {ownerLabel(it)}</span>
									{#if it.blockedByUnmet.length > 0}
										<span class="text-hub-warning">· blocked ×{it.blockedByUnmet.length}</span>
									{/if}
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
