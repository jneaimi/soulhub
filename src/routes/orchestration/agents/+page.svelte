<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import AgentRow from '$lib/components/agents/AgentRow.svelte';

	type Backend = 'claude-pty' | 'claude-cli-flag' | 'ai-sdk';
	type Provenance = 'builtin' | 'user-created' | 'external';
	type Lane = 'A' | 'B';
	type Health = 'ready' | 'unhealthy' | 'unknown';

	interface AgentStats {
		totalRuns: number;
		totalCostUsd: number;
		totalTurns: number;
		successRate: number;
		lastRunAt: number | null;
		lastStatus: string | null;
	}

	interface AgentSummary {
		id: string;
		name: string;
		description: string;
		backend: Backend;
		model?: string;
		provider?: string;
		tools: string[];
		skills: string[];
		provenance: Provenance;
		lane: Lane;
		health: Health;
		health_reason?: string;
		source_path: string;
		system_prompt: string;
		stats?: AgentStats | null;
	}

	type FilterMode = 'all' | 'pty' | 'cli-flag' | 'ai-sdk' | 'unhealthy';

	interface OpenRouterBalance {
		available: boolean;
		usage_monthly?: number;
		usage_daily?: number;
		limit?: number | null;
		limit_remaining?: number | null;
		is_free_tier?: boolean;
	}

	let agents = $state<AgentSummary[]>([]);
	let laneADir = $state('');
	let laneBDir = $state('');
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let filter = $state<FilterMode>('all');
	let search = $state('');
	let expandedIds = $state(new Set<string>());
	let deleteConfirm = $state(new Map<string, number>());
	let installingSeed = $state(false);
	let toast = $state<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let orBalance = $state<OpenRouterBalance | null>(null);

	function flashToast(kind: 'success' | 'error' | 'info', text: string) {
		toast = { kind, text };
		setTimeout(() => {
			toast = null;
		}, 3500);
	}

	async function loadAgents() {
		try {
			const res = await fetch('/api/agents');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			agents = data.agents ?? [];
			laneADir = data.laneADir ?? '';
			laneBDir = data.laneBDir ?? '';
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	async function loadOpenRouterBalance() {
		try {
			const res = await fetch('/api/openrouter/balance');
			if (!res.ok) {
				orBalance = null;
				return;
			}
			const data = (await res.json()) as OpenRouterBalance;
			orBalance = data.available ? data : null;
		} catch {
			// Best-effort — chip just disappears on transient failure.
			orBalance = null;
		}
	}

	const filteredAgents = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return agents.filter((a) => {
			if (q && !a.id.toLowerCase().includes(q) && !a.description.toLowerCase().includes(q)) return false;
			if (filter === 'pty' && a.backend !== 'claude-pty') return false;
			if (filter === 'cli-flag' && a.backend !== 'claude-cli-flag') return false;
			if (filter === 'ai-sdk' && a.backend !== 'ai-sdk') return false;
			if (filter === 'unhealthy' && a.health === 'ready') return false;
			return true;
		});
	});

	const summary = $derived.by(() => {
		const total = agents.length;
		const pty = agents.filter((a) => a.backend === 'claude-pty').length;
		const cli = agents.filter((a) => a.backend === 'claude-cli-flag').length;
		const ai = agents.filter((a) => a.backend === 'ai-sdk').length;
		const unhealthy = agents.filter((a) => a.health !== 'ready').length;
		const builtin = agents.filter((a) => a.provenance === 'builtin').length;
		const custom = agents.filter((a) => a.provenance === 'user-created').length;
		const external = agents.filter((a) => a.provenance === 'external').length;
		return { total, pty, cli, ai, unhealthy, builtin, custom, external };
	});

	function toggleExpand(id: string) {
		const next = new Set(expandedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedIds = next;
	}

	async function handleDelete(id: string) {
		// Click-again-to-confirm: same UX as scheduler cancel.
		const lastConfirm = deleteConfirm.get(id);
		const now = Date.now();
		if (lastConfirm && now - lastConfirm < 5000) {
			try {
				const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
					method: 'DELETE',
				});
				const data = await res.json();
				if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
				flashToast('success', `Deleted ${id}`);
				const next = new Map(deleteConfirm);
				next.delete(id);
				deleteConfirm = next;
				loadAgents();
			} catch (err) {
				flashToast('error', `Delete failed: ${(err as Error).message}`);
			}
			return;
		}
		const next = new Map(deleteConfirm);
		next.set(id, now);
		deleteConfirm = next;
		flashToast('info', `Click delete again to confirm removing ${id}`);
		// Auto-clear the confirm state after 5s
		setTimeout(() => {
			const next2 = new Map(deleteConfirm);
			if (next2.get(id) === now) {
				next2.delete(id);
				deleteConfirm = next2;
			}
		}, 5000);
	}

	async function installSeed() {
		installingSeed = true;
		try {
			const res = await fetch('/api/agents/seed', { method: 'POST' });
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			const installed = (data.installed ?? []).length;
			const skipped = (data.skipped ?? []).length;
			flashToast('success', `Seed roster: ${installed} installed, ${skipped} skipped`);
			loadAgents();
		} catch (err) {
			flashToast('error', `Seed install failed: ${(err as Error).message}`);
		} finally {
			installingSeed = false;
		}
	}

	const filterChips: { id: FilterMode; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'pty', label: 'PTY' },
		{ id: 'cli-flag', label: 'CLI flag' },
		{ id: 'ai-sdk', label: 'AI SDK' },
		{ id: 'unhealthy', label: 'Unhealthy' },
	];

	onMount(() => {
		loadAgents();
		loadOpenRouterBalance();
		// Refresh agent list every 30s; OR balance every 60s (server-side TTL
		// matches, so additional polls would just hit the cache).
		pollInterval = setInterval(() => {
			loadAgents();
			loadOpenRouterBalance();
		}, 30_000);
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
	});
</script>

<svelte:head>
	<title>Agents · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg" data-agents>
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-6xl mx-auto w-full">
			<div class="flex items-center gap-2">
				<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>
				</svg>
				<h1 class="text-lg font-semibold text-hub-text">Agents</h1>
			</div>
			<div class="flex-1"></div>
			{#if orBalance}
				<a
					href="/settings"
					class="px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-hub-info hover:text-hub-text hover:bg-hub-info/10 transition-colors cursor-pointer flex items-center gap-1.5"
					title="OpenRouter spend — click to manage in Settings"
				>
					<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
					</svg>
					<span>OR</span>
					<span class="text-hub-muted">${(orBalance.usage_monthly ?? 0).toFixed(2)}/mo</span>
					{#if orBalance.limit_remaining != null}
						<span class="text-hub-dim">·</span>
						<span class="text-hub-muted">${(orBalance.limit_remaining ?? 0).toFixed(2)} left</span>
					{/if}
				</a>
			{/if}
			<a
				href="/orchestration/metrics"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
				title="WhatsApp orchestrator falsifier dashboard"
			>
				Orchestrator
			</a>
			<a
				href="/orchestration/skills"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
				title="Skills hub — chat overlay + install/manage"
			>
				Skills
			</a>
			<a
				href="/orchestration/agents/new"
				class="px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta/90 transition-colors cursor-pointer"
			>
				+ New agent
			</a>
		</div>
	</header>

	<!-- Summary strip -->
	<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
		<div class="max-w-6xl mx-auto w-full flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-hub-muted">
			<span><span class="text-hub-text font-medium">{summary.total}</span> agents</span>
			<span class="text-hub-dim">·</span>
			{#if summary.builtin > 0}
				<span><span class="text-hub-purple font-medium">{summary.builtin}</span> builtin</span>
				<span class="text-hub-dim">·</span>
			{/if}
			{#if summary.custom > 0}
				<span><span class="text-hub-cta font-medium">{summary.custom}</span> custom</span>
				<span class="text-hub-dim">·</span>
			{/if}
			{#if summary.external > 0}
				<span><span class="text-hub-text font-medium">{summary.external}</span> external</span>
				<span class="text-hub-dim">·</span>
			{/if}
			<span><span class="text-hub-purple font-medium">{summary.pty}</span> PTY</span>
			<span class="text-hub-dim">·</span>
			<span><span class="text-hub-warning font-medium">{summary.cli}</span> CLI flag</span>
			<span class="text-hub-dim">·</span>
			<span><span class="text-hub-info font-medium">{summary.ai}</span> AI SDK</span>
			{#if summary.unhealthy > 0}
				<span class="text-hub-dim">·</span>
				<span class="text-hub-warning"><span class="font-medium">{summary.unhealthy}</span> unhealthy</span>
			{/if}
		</div>
	</div>

	<!-- Filter + search -->
	<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
		<div class="max-w-6xl mx-auto w-full flex flex-wrap items-center gap-3">
			<div class="flex items-center gap-1.5 flex-wrap">
				{#each filterChips as f (f.id)}
					<button
						type="button"
						onclick={() => (filter = f.id)}
						class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer
							{filter === f.id
								? 'bg-hub-cta text-black'
								: 'bg-hub-card text-hub-muted hover:text-hub-text border border-hub-border'}"
					>
						{f.label}
					</button>
				{/each}
			</div>
			<div class="flex-1 min-w-[180px]">
				<input
					type="search"
					bind:value={search}
					placeholder="Search by name or description…"
					class="w-full px-3 py-1.5 rounded-lg bg-hub-card border border-hub-border text-xs text-hub-text placeholder-hub-dim focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
				/>
			</div>
		</div>
	</div>

	<!-- Agent list -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-6xl mx-auto w-full">
			{#if loading}
				<div class="space-y-2">
					{#each Array(4) as _, i (i)}
						<div class="h-16 bg-hub-card rounded-xl border border-hub-border motion-safe:animate-pulse"></div>
					{/each}
				</div>
			{:else if loadError}
				<div class="bg-hub-card border border-hub-danger/40 rounded-xl p-4 text-sm text-hub-danger">
					Failed to load agents: {loadError}
				</div>
			{:else if filteredAgents.length === 0}
				<div class="bg-hub-card rounded-xl border border-hub-border p-12 text-center">
					{#if agents.length === 0}
						<h3 class="text-base font-semibold text-hub-text mb-2">No agents yet</h3>
						<p class="text-sm text-hub-muted mb-1">
							Soul Hub looked in two places — both empty:
						</p>
						<ul class="text-xs text-hub-dim font-mono inline-block text-left mt-2 space-y-0.5">
							<li>Lane A: {laneADir || '~/.claude/agents/'}</li>
							<li>Lane B: {laneBDir || '~/.soul-hub/data/agents/'}</li>
						</ul>
						<div class="mt-5 flex items-center justify-center gap-2">
							<button
								type="button"
								onclick={installSeed}
								disabled={installingSeed}
								class="px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
							>
								{installingSeed ? 'Installing…' : 'Install starter roster (10 agents)'}
							</button>
							<a
								href="/orchestration/agents/new"
								class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-bg transition-colors cursor-pointer"
							>
								Or build one from scratch →
							</a>
						</div>
					{:else}
						<p class="text-sm text-hub-muted">No agents match this filter.</p>
					{/if}
				</div>
			{:else}
				<div class="space-y-2">
					{#each filteredAgents as agent (agent.id)}
						<AgentRow
							{agent}
							expanded={expandedIds.has(agent.id)}
							onToggleExpand={() => toggleExpand(agent.id)}
							deleteConfirming={deleteConfirm.has(agent.id)}
							onDelete={() => handleDelete(agent.id)}
						/>
					{/each}
				</div>
			{/if}

			{#if !loading && agents.length > 0}
				<p class="text-[10px] text-hub-dim mt-4 text-center">
					Showing {filteredAgents.length} of {agents.length}.
				</p>
			{/if}
		</div>
	</div>

	<!-- Toast -->
	{#if toast}
		<div
			class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg
				{toast.kind === 'success' ? 'bg-hub-cta text-black'
				: toast.kind === 'error' ? 'bg-hub-danger text-white'
				: 'bg-hub-card text-hub-text border border-hub-border'}"
			role="status"
		>
			{toast.text}
		</div>
	{/if}
</div>
