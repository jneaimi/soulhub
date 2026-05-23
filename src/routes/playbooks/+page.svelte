<script lang="ts">
	import { onMount } from 'svelte';

	interface PlaybookSummary {
		name: string;
		description: string;
		dir: string;
		roles: { id: string; provider: string; model?: string; skills?: string[]; mcp?: string[] }[];
		phases: { id: string; type: string }[];
		inputCount: number;
		outputType: string;
		hasHooks: boolean;
		prerequisites: { name: string; check: string; required?: boolean }[];
	}

	interface ChainSummary {
		name: string;
		description: string;
		dir: string;
		nodes: { id: string; playbook: string }[];
		inputCount: number;
	}

	let playbooks = $state<PlaybookSummary[]>([]);
	let chains = $state<ChainSummary[]>([]);
	let providers = $state<Record<string, boolean>>({});
	let loading = $state(true);
	let error = $state('');
	let filter = $state('');

	const filtered = $derived(
		playbooks.filter(
			(p) =>
				p.name.toLowerCase().includes(filter.toLowerCase()) ||
				p.description.toLowerCase().includes(filter.toLowerCase())
		)
	);

	const phaseTypeColors: Record<string, string> = {
		sequential: 'bg-hub-info/15 text-hub-info',
		parallel: 'bg-hub-purple/15 text-hub-purple',
		handoff: 'bg-hub-warning/15 text-hub-warning',
		human: 'bg-hub-cta/15 text-hub-cta',
		gate: 'bg-hub-danger/15 text-hub-danger',
		consensus: 'bg-hub-dim/15 text-hub-dim',
	};

	function dirName(dir: string): string {
		return dir.split('/').pop() || dir;
	}

	async function loadPlaybooks() {
		try {
			const res = await fetch('/api/playbooks');
			if (!res.ok) throw new Error('Failed to load playbooks');
			const data = await res.json();
			playbooks = data.playbooks || [];
			chains = data.chains || [];
			providers = data.providers || {};
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadPlaybooks();
	});
</script>

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-5xl mx-auto flex items-center gap-3">
			<h1 class="text-lg font-semibold text-hub-text">Playbooks</h1>
			<a href="/playbooks/builder" class="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium bg-hub-cta text-black hover:bg-hub-cta-hover transition-colors cursor-pointer">
				New Playbook
			</a>
		</div>
	</header>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-5xl mx-auto space-y-4">
			<!-- Search -->
			<input
				type="text"
				bind:value={filter}
				placeholder="Filter playbooks..."
				class="w-full bg-hub-panel border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-info/50"
			/>

			<!-- Loading -->
			{#if loading}
				<div class="flex items-center justify-center py-16">
					<svg class="w-5 h-5 text-hub-info animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
					</svg>
					<span class="ml-2 text-sm text-hub-dim">Loading playbooks...</span>
				</div>

			<!-- Error -->
			{:else if error}
				<div class="border border-hub-danger/30 bg-hub-danger/5 rounded-lg p-4 text-sm text-hub-danger">
					{error}
				</div>

			<!-- Empty -->
			{:else if filtered.length === 0 && filter}
				<p class="text-center text-hub-dim text-sm py-16">No playbooks match "{filter}"</p>
			{:else if playbooks.length === 0}
				<div class="text-center py-16">
					<p class="text-hub-dim text-sm">No playbooks found</p>
					<p class="text-hub-dim/60 text-xs mt-1">Add playbook directories to /playbooks</p>
				</div>

			<!-- Playbook Cards -->
			{:else}
				<div class="space-y-3">
					{#each filtered as pb}
						<a
							href="/playbooks/{encodeURIComponent(dirName(pb.dir))}"
							class="block border border-hub-border rounded-lg p-4 hover:border-hub-dim transition-colors cursor-pointer group"
						>
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex-1">
									<h2 class="text-sm font-semibold text-hub-text group-hover:text-hub-cta transition-colors">
										{pb.name}
									</h2>
									{#if pb.description}
										<p class="text-xs text-hub-dim mt-1 line-clamp-2">{pb.description}</p>
									{/if}
								</div>
								<div class="flex items-center gap-1.5 flex-shrink-0">
									<button
										onclick={(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); window.location.href = `/playbooks/builder?fork=${encodeURIComponent(dirName(pb.dir))}`; }}
										class="px-1.5 py-0.5 rounded text-[10px] font-medium text-hub-dim hover:text-hub-info hover:bg-hub-info/10 transition-colors cursor-pointer"
									>
										fork
									</button>
									<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-purple/15 text-hub-purple">
										{pb.outputType}
									</span>
								</div>
							</div>

							<!-- Roles -->
							<div class="mt-3 flex flex-wrap gap-1.5">
								{#each pb.roles as role}
									<div class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-hub-card text-hub-muted border border-hub-border/50">
										<span>{role.id}</span>
										{#if role.model}
											<span class="text-hub-dim">({role.provider}/{role.model})</span>
										{:else}
											<span class="text-hub-dim">({role.provider})</span>
										{/if}
										{#each role.skills || [] as skill}
											<span class="px-1 py-px rounded bg-hub-info/15 text-hub-info text-[9px]">{skill}</span>
										{/each}
										{#each role.mcp || [] as tool}
											<span class="px-1 py-px rounded bg-hub-warning/15 text-hub-warning text-[9px]">{tool}</span>
										{/each}
									</div>
								{/each}
							</div>

							<!-- Phases + Meta -->
							<div class="mt-3 flex items-center gap-3 flex-wrap">
								{#each pb.phases as phase}
									<span class="px-1.5 py-0.5 rounded text-[10px] font-medium {phaseTypeColors[phase.type] || 'bg-hub-dim/15 text-hub-dim'}">
										{phase.id} [{phase.type}]
									</span>
								{/each}

								<div class="ml-auto flex items-center gap-2 flex-shrink-0">
									{#if pb.hasHooks}
										<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-purple/15 text-hub-purple">hooks</span>
									{/if}
									{#if pb.prerequisites?.length}
										<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-hub-cta/15 text-hub-cta">
											{pb.prerequisites.length} prereq{pb.prerequisites.length !== 1 ? 's' : ''}
										</span>
									{/if}
									<span class="text-[10px] text-hub-dim">
										{pb.inputCount} input{pb.inputCount !== 1 ? 's' : ''}
									</span>
								</div>
							</div>
						</a>
					{/each}
				</div>
			{/if}

			<!-- Playbook Chains -->
			{#if chains.length > 0}
				<div class="mt-8">
					<h2 class="text-hub-text text-sm font-medium mb-3">Playbook Chains</h2>
					<div class="space-y-3">
						{#each chains as chain}
							<div class="bg-hub-panel border border-hub-border rounded-lg p-4">
								<div class="flex items-center gap-2">
									<span class="text-hub-text font-medium">{chain.name}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-purple/15 text-hub-purple">chain</span>
								</div>
								{#if chain.description}
									<p class="text-hub-dim text-sm mt-1">{chain.description}</p>
								{/if}
								<div class="flex gap-2 mt-2 text-[11px] text-hub-dim">
									{#each chain.nodes as node, i}
										{#if i > 0}<span class="text-hub-border">&rarr;</span>{/if}
										<span class="bg-hub-bg/50 px-1.5 py-0.5 rounded">{node.playbook}</span>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Provider Status -->
			{#if !loading && Object.keys(providers).length > 0}
				<div class="pt-4 border-t border-hub-border/50">
					<div class="flex items-center gap-4 text-xs text-hub-dim">
						<span>Providers:</span>
						{#each Object.entries(providers) as [name, available]}
							<span class="flex items-center gap-1.5">
								<span class="w-2 h-2 rounded-full {available ? 'bg-hub-cta/60' : 'bg-hub-danger/60'}"></span>
								{name}
							</span>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
