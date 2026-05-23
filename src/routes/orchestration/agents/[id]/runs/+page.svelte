<script lang="ts">
	import { page } from '$app/stores';

	type Status = 'success' | 'error' | 'cancelled' | 'timeout' | 'budget-exceeded';
	type Mode = 'production' | 'test';

	interface RunRow {
		id: number;
		runId: string;
		agentId: string;
		backend: string;
		model: string | null;
		provider: string | null;
		mode: Mode;
		taskSpec: string;
		jid: string | null;
		startedAt: number;
		finishedAt: number | null;
		durationMs: number | null;
		status: Status;
		costUsd: number;
		numTurns: number;
		resultExcerpt: string | null;
		errorMessage: string | null;
	}

	interface Stats {
		totalRuns: number;
		totalCostUsd: number;
		totalTurns: number;
		successRate: number;
		lastRunAt: number | null;
		lastStatus: Status | null;
	}

	type ModeFilter = 'all' | 'production' | 'test';

	let runs = $state<RunRow[]>([]);
	let stats = $state<Stats | null>(null);
	let agentName = $state('');
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let modeFilter = $state<ModeFilter>('all');
	let expanded = $state(new Set<number>());

	const id = $derived($page.params.id ?? '');

	async function load() {
		loading = true;
		try {
			const qp = modeFilter === 'all' ? '' : `?mode=${modeFilter}`;
			const [runsRes, agentRes] = await Promise.all([
				fetch(`/api/agents/${encodeURIComponent(id)}/runs${qp}`),
				fetch(`/api/agents/${encodeURIComponent(id)}`),
			]);
			if (!runsRes.ok) throw new Error(`runs HTTP ${runsRes.status}`);
			if (!agentRes.ok) throw new Error(`agent HTTP ${agentRes.status}`);
			const runsData = await runsRes.json();
			const agentData = await agentRes.json();
			runs = runsData.runs ?? [];
			stats = runsData.stats ?? null;
			agentName = agentData.agent?.name ?? id;
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function fmtTime(ms: number): string {
		const d = new Date(ms);
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	}

	function fmtDuration(ms: number | null): string {
		if (ms == null) return '—';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
	}

	function fmtCost(usd: number): string {
		if (!usd) return '—';
		if (usd < 0.0001) return '<$0.0001';
		if (usd < 0.01) return `$${usd.toFixed(4)}`;
		return `$${usd.toFixed(4)}`;
	}

	const statusColor: Record<Status, string> = {
		success: 'bg-hub-cta/15 text-hub-cta border-hub-cta/30',
		error: 'bg-hub-danger/15 text-hub-danger border-hub-danger/30',
		cancelled: 'bg-hub-muted/15 text-hub-muted border-hub-border',
		timeout: 'bg-hub-warning/15 text-hub-warning border-hub-warning/30',
		'budget-exceeded': 'bg-hub-warning/15 text-hub-warning border-hub-warning/30',
	};

	function toggleRow(rowId: number) {
		const next = new Set(expanded);
		if (next.has(rowId)) next.delete(rowId);
		else next.add(rowId);
		expanded = next;
	}

	const filterChips: { id: ModeFilter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'production', label: 'Production' },
		{ id: 'test', label: 'Test' },
	];

	// Single source of truth for fetch: re-run whenever `id` or `modeFilter`
	// changes. Reading `loading` inside the effect would create a feedback
	// loop (load() flips loading false→true→false, refiring the effect),
	// so we don't guard on it — overlapping loads just resolve last-wins.
	$effect(() => {
		void id;
		void modeFilter;
		load();
	});
</script>

<svelte:head>
	<title>Runs · {agentName || id} · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg" data-agents>
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-6xl mx-auto w-full">
			<a
				href="/orchestration/agents"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to agents"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<div class="flex items-center gap-2 min-w-0">
				<svg class="w-5 h-5 text-hub-cta flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
				</svg>
				<h1 class="text-lg font-semibold text-hub-text truncate">
					Runs · {agentName || id}
				</h1>
			</div>
			<div class="flex-1"></div>
			<a
				href="/orchestration/agents/{encodeURIComponent(id)}/test"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-info hover:text-hub-text hover:bg-hub-info/10 transition-colors cursor-pointer"
			>
				▶ Test
			</a>
			<a
				href="/orchestration/agents/{encodeURIComponent(id)}/edit"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
			>
				✎ Edit
			</a>
		</div>
	</header>

	<!-- Stats strip -->
	{#if stats}
		<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
			<div class="max-w-6xl mx-auto w-full flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-hub-muted">
				<span><span class="text-hub-text font-medium">{stats.totalRuns}</span> runs</span>
				<span class="text-hub-dim">·</span>
				<span><span class="text-hub-cta font-medium">{(stats.successRate * 100).toFixed(0)}%</span> success</span>
				<span class="text-hub-dim">·</span>
				<span><span class="text-hub-text font-medium">${stats.totalCostUsd.toFixed(4)}</span> total cost</span>
				<span class="text-hub-dim">·</span>
				<span><span class="text-hub-text font-medium">{stats.totalTurns}</span> turns</span>
				{#if stats.lastRunAt}
					<span class="text-hub-dim">·</span>
					<span>last: {fmtTime(stats.lastRunAt)}</span>
				{/if}
				<span class="text-hub-dim ml-auto">production-mode only · test runs excluded from totals</span>
			</div>
		</div>
	{/if}

	<!-- Filter -->
	<div class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border/50">
		<div class="max-w-6xl mx-auto w-full flex flex-wrap items-center gap-2">
			{#each filterChips as f (f.id)}
				<button
					type="button"
					onclick={() => (modeFilter = f.id)}
					class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer
						{modeFilter === f.id
							? 'bg-hub-cta text-black'
							: 'bg-hub-card text-hub-muted hover:text-hub-text border border-hub-border'}"
				>
					{f.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Body -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-6xl mx-auto w-full">
			{#if loading}
				<div class="space-y-1.5">
					{#each Array(6) as _, i (i)}
						<div class="h-12 bg-hub-card rounded-lg border border-hub-border motion-safe:animate-pulse"></div>
					{/each}
				</div>
			{:else if loadError}
				<div class="bg-hub-card border border-hub-danger/40 rounded-xl p-4 text-sm text-hub-danger">
					Failed to load runs: {loadError}
				</div>
			{:else if runs.length === 0}
				<div class="bg-hub-card rounded-xl border border-hub-border p-8 text-center">
					<p class="text-sm text-hub-muted">No runs yet for this agent.</p>
					<a
						href="/orchestration/agents/{encodeURIComponent(id)}/test"
						class="inline-block mt-3 px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta/90 transition-colors cursor-pointer"
					>
						Run a test →
					</a>
				</div>
			{:else}
				<div class="space-y-1">
					{#each runs as run (run.id)}
						<div class="bg-hub-card rounded-lg border border-hub-border overflow-hidden">
							<button
								type="button"
								onclick={() => toggleRow(run.id)}
								class="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-hub-bg/40 cursor-pointer"
							>
								<span class="px-1.5 py-0.5 rounded text-[10px] font-medium border {statusColor[run.status]}">
									{run.status}
								</span>
								{#if run.mode === 'test'}
									<span class="px-1.5 py-0.5 rounded text-[10px] font-medium border bg-hub-info/10 text-hub-info border-hub-info/30">
										test
									</span>
								{/if}
								<span class="flex-1 min-w-0 text-xs text-hub-muted truncate">
									{run.taskSpec}
								</span>
								<span class="flex-shrink-0 text-[10px] text-hub-dim font-mono">
									{fmtDuration(run.durationMs)}
								</span>
								<span class="flex-shrink-0 text-[10px] text-hub-dim font-mono w-20 text-right">
									{fmtCost(run.costUsd)}
								</span>
								<span class="flex-shrink-0 text-[10px] text-hub-dim w-14 text-right">
									{run.numTurns}t
								</span>
								<span class="flex-shrink-0 text-[10px] text-hub-dim w-32 text-right">
									{fmtTime(run.startedAt)}
								</span>
							</button>
							{#if expanded.has(run.id)}
								<div class="border-t border-hub-border/60 px-3 py-3 bg-hub-bg/40 space-y-2">
									<div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] text-hub-dim font-mono">
										<div>runId: <span class="text-hub-muted">{run.runId}</span></div>
										<div>backend: <span class="text-hub-muted">{run.backend}</span></div>
										{#if run.model}<div>model: <span class="text-hub-muted">{run.model}</span></div>{/if}
										{#if run.provider}<div>provider: <span class="text-hub-muted">{run.provider}</span></div>{/if}
										{#if run.jid}<div class="col-span-2">jid: <span class="text-hub-muted">{run.jid}</span></div>{/if}
									</div>
									{#if run.errorMessage}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-dim mb-1">Error</div>
											<pre class="text-[11px] text-hub-danger font-mono bg-hub-card border border-hub-danger/30 rounded p-2 overflow-x-auto whitespace-pre-wrap">{run.errorMessage}</pre>
										</div>
									{/if}
									{#if run.resultExcerpt}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-dim mb-1">Output excerpt</div>
											<pre class="text-[11px] text-hub-muted font-mono bg-hub-card border border-hub-border/60 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">{run.resultExcerpt}</pre>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
				<p class="text-[10px] text-hub-dim mt-3 text-center">
					Showing last {runs.length} run{runs.length === 1 ? '' : 's'}.
				</p>
			{/if}
		</div>
	</div>
</div>
