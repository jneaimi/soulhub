<script lang="ts">
	import { onMount } from 'svelte';

	type Status = 'success' | 'error' | 'cancelled' | 'timeout' | 'budget-exceeded';

	interface Metrics {
		period: { fromMs: number; toMs: number; days: number };
		dispatches: {
			total: number;
			byStatus: Record<Status, number>;
		};
		cancelRate: number;
		successRate: number;
		costUsd: number;
		avgDurationMs: number;
		byBackend: Record<string, number>;
		byAgent: Array<{
			agentId: string;
			runs: number;
			successRate: number;
			costUsd: number;
			lastRunAt: number | null;
		}>;
		recent: Array<{
			runId: string;
			agentId: string;
			backend: string;
			status: Status;
			startedAt: number;
			durationMs: number | null;
			costUsd: number;
			jid: string;
			taskSpec: string | null;
		}>;
		cliFlagTimeouts14d: number;
	}

	let days = $state(30);
	let metrics = $state<Metrics | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/orchestrator/metrics?days=${days}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			metrics = (await res.json()) as Metrics;
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	$effect(() => {
		void days;
		load();
	});

	function fmtCost(usd: number): string {
		if (!usd) return '$0';
		if (usd < 0.01) return '<$0.01';
		if (usd < 1) return `$${usd.toFixed(2)}`;
		return `$${usd.toFixed(2)}`;
	}

	function fmtPct(p: number): string {
		return `${(p * 100).toFixed(1)}%`;
	}

	function fmtMs(ms: number | null): string {
		if (ms == null) return '—';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${(ms / 60_000).toFixed(1)}m`;
	}

	function relTime(ms: number | null): string {
		if (!ms) return '—';
		const diff = Date.now() - ms;
		const min = 60_000;
		const hr = 60 * min;
		const day = 24 * hr;
		if (diff < min) return 'just now';
		if (diff < hr) return `${Math.floor(diff / min)}m ago`;
		if (diff < day) return `${Math.floor(diff / hr)}h ago`;
		if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
		return new Date(ms).toISOString().slice(0, 10);
	}

	function jidShort(jid: string): string {
		const at = jid.indexOf('@');
		return at === -1 ? jid : jid.slice(0, at);
	}

	const statusColor: Record<Status, string> = {
		success: 'text-hub-cta',
		error: 'text-hub-danger',
		cancelled: 'text-hub-muted',
		timeout: 'text-hub-warning',
		'budget-exceeded': 'text-hub-warning',
	};

	const backendColor: Record<string, string> = {
		'claude-pty': 'bg-hub-purple/30 border-hub-purple/40',
		'claude-cli-flag': 'bg-hub-warning/30 border-hub-warning/40',
		'ai-sdk': 'bg-hub-info/30 border-hub-info/40',
	};

	// ADR-005 §Falsifier criteria — derived state mapping current values
	// to red/yellow/green based on the documented thresholds.
	interface Criterion {
		id: string;
		title: string;
		threshold: string;
		current: string;
		state: 'green' | 'yellow' | 'red' | 'unknown';
		note?: string;
	}

	const criteria = $derived.by<Criterion[]>(() => {
		if (!metrics) return [];
		const cancelPct = metrics.cancelRate;
		// "Wrong agent ≥30%" — proxy via cancel rate. Yellow at 15%, red at 30%.
		const cancelState =
			metrics.dispatches.total < 5
				? 'unknown'
				: cancelPct >= 0.3
					? 'red'
					: cancelPct >= 0.15
						? 'yellow'
						: 'green';
		// "claude -p hangs ≥3 in 2w" — direct timeout count.
		const cliState =
			metrics.cliFlagTimeouts14d >= 3
				? 'red'
				: metrics.cliFlagTimeouts14d >= 1
					? 'yellow'
					: 'green';
		return [
			{
				id: 'wrong-agent',
				title: 'Wrong-agent rate (proxy: user cancellation)',
				threshold: '≥30% cancellation → revert to slash commands',
				current: `${fmtPct(cancelPct)} (${metrics.dispatches.byStatus.cancelled} of ${metrics.dispatches.total})`,
				state: cancelState as Criterion['state'],
				note:
					metrics.dispatches.total < 5
						? 'Need ≥5 production dispatches before this signal is meaningful.'
						: undefined,
			},
			{
				id: 'cli-hangs',
				title: '`claude-cli-flag` timeouts (14-day window)',
				threshold: '≥3 in 2 weeks → trigger Phase 3 (PTY migration narrowed)',
				current: `${metrics.cliFlagTimeouts14d} timeouts`,
				state: cliState,
			},
			{
				id: 'gemini-cost',
				title: 'Gemini Flash orchestrator cost',
				threshold: '>$5/month → investigate prompt size (expected ~$0.30/mo)',
				current: 'not yet instrumented',
				state: 'unknown',
				note:
					"Orchestrator's own decide() cost lives in dispatchRoute's usage tally, not agent_runs. Wire-up is a Phase 11 follow-up.",
			},
			{
				id: 'path-mix',
				title: 'Slash-command vs natural-language path ratio',
				threshold: 'User stops using natural-language path → revisit prompt + thresholds',
				current: 'not yet instrumented',
				state: 'unknown',
				note: 'Needs a path counter in `_inbound`. Phase 11 follow-up.',
			},
			{
				id: 'enum-leak',
				title: 'Hallucinated agent names',
				threshold: '≥1 occurrence → schema enforcement bug',
				current: '0 (closed enum is build-time guaranteed)',
				state: 'green',
				note: 'Zod runtime validation rejects any agent id outside listAgents().filter(chat_dispatchable=true) before dispatch.',
			},
		];
	});

	const stateBadge: Record<Criterion['state'], string> = {
		green: 'bg-hub-cta/15 text-hub-cta border-hub-cta/40',
		yellow: 'bg-hub-warning/15 text-hub-warning border-hub-warning/40',
		red: 'bg-hub-danger/15 text-hub-danger border-hub-danger/40',
		unknown: 'bg-hub-bg text-hub-muted border-hub-border',
	};
</script>

<svelte:head>
	<title>Orchestrator · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg" data-agents>
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-6xl mx-auto w-full">
			<div class="flex items-center gap-2 flex-1">
				<svg class="w-5 h-5 text-hub-cta" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>
				</svg>
				<h1 class="text-lg font-semibold text-hub-text">Metrics</h1>
				<span class="text-xs text-hub-dim">ADR-005 falsifier dashboard</span>
			</div>
			<!-- Period selector -->
			<div class="flex items-center gap-1 text-xs">
				{#each [7, 30, 90] as d (d)}
					<button
						type="button"
						onclick={() => (days = d)}
						class="px-2.5 py-1 rounded border transition-colors cursor-pointer
							{days === d
								? 'border-hub-cta/60 bg-hub-cta/10 text-hub-text'
								: 'border-hub-border bg-hub-bg text-hub-muted hover:text-hub-text'}"
					>
						{d}d
					</button>
				{/each}
			</div>
		</div>
	</header>

	<!-- Body -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-6xl mx-auto w-full space-y-4">
			{#if error}
				<div class="bg-hub-card border border-hub-danger/40 rounded-xl p-4 text-sm text-hub-danger">
					Failed to load metrics: {error}
				</div>
			{:else if !metrics}
				<div class="space-y-2">
					{#each Array(3) as _, i (i)}
						<div class="h-24 bg-hub-card rounded-xl border border-hub-border motion-safe:animate-pulse"></div>
					{/each}
				</div>
			{:else}
				<!-- Stats strip -->
				<div class="grid grid-cols-2 md:grid-cols-5 gap-3">
					<div class="bg-hub-card rounded-xl border border-hub-border p-3">
						<div class="text-[10px] text-hub-dim uppercase tracking-wider">Dispatches</div>
						<div class="text-2xl font-semibold text-hub-text mt-1">{metrics.dispatches.total}</div>
						<div class="text-[10px] text-hub-dim mt-0.5">last {metrics.period.days}d</div>
					</div>
					<div class="bg-hub-card rounded-xl border border-hub-border p-3">
						<div class="text-[10px] text-hub-dim uppercase tracking-wider">Success rate</div>
						<div class="text-2xl font-semibold {metrics.successRate >= 0.7 ? 'text-hub-cta' : 'text-hub-warning'} mt-1">
							{fmtPct(metrics.successRate)}
						</div>
						<div class="text-[10px] text-hub-dim mt-0.5">{metrics.dispatches.byStatus.success} ok</div>
					</div>
					<div class="bg-hub-card rounded-xl border border-hub-border p-3">
						<div class="text-[10px] text-hub-dim uppercase tracking-wider">Cancel rate</div>
						<div class="text-2xl font-semibold {metrics.cancelRate >= 0.3 ? 'text-hub-danger' : metrics.cancelRate >= 0.15 ? 'text-hub-warning' : 'text-hub-text'} mt-1">
							{fmtPct(metrics.cancelRate)}
						</div>
						<div class="text-[10px] text-hub-dim mt-0.5">{metrics.dispatches.byStatus.cancelled} cancelled</div>
					</div>
					<div class="bg-hub-card rounded-xl border border-hub-border p-3">
						<div class="text-[10px] text-hub-dim uppercase tracking-wider">Avg duration</div>
						<div class="text-2xl font-semibold text-hub-text mt-1">{fmtMs(metrics.avgDurationMs)}</div>
						<div class="text-[10px] text-hub-dim mt-0.5">per dispatch</div>
					</div>
					<div class="bg-hub-card rounded-xl border border-hub-border p-3">
						<div class="text-[10px] text-hub-dim uppercase tracking-wider">Worker cost</div>
						<div class="text-2xl font-semibold text-hub-text mt-1">{fmtCost(metrics.costUsd)}</div>
						<div class="text-[10px] text-hub-dim mt-0.5" title="Excludes orchestrator decide() cost — not yet captured">
							dispatched-agent only
						</div>
					</div>
				</div>

				<!-- Backend distribution -->
				{#if Object.keys(metrics.byBackend).length > 0}
					<div class="bg-hub-card rounded-xl border border-hub-border p-3">
						<div class="text-xs text-hub-muted mb-2">Backend distribution</div>
						<div class="flex h-2 rounded overflow-hidden">
							{#each Object.entries(metrics.byBackend) as [backend, n] (backend)}
								<div
									class="{backendColor[backend] ?? 'bg-hub-border'} border-r border-hub-bg/50"
									style="width: {(n / metrics.dispatches.total) * 100}%"
									title="{backend}: {n}"
								></div>
							{/each}
						</div>
						<div class="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-hub-muted">
							{#each Object.entries(metrics.byBackend) as [backend, n] (backend)}
								<span>
									<span class="inline-block w-2 h-2 rounded-sm {backendColor[backend] ?? 'bg-hub-border'} mr-1.5"></span>
									{backend}: <span class="text-hub-text font-medium">{n}</span>
								</span>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Falsifier criteria -->
				<div class="bg-hub-card rounded-xl border border-hub-border p-4">
					<div class="flex items-center gap-2 mb-3">
						<h2 class="text-sm font-semibold text-hub-text">ADR-005 falsifier criteria</h2>
						<span class="text-[10px] text-hub-dim">4-week observation window</span>
					</div>
					<div class="space-y-2">
						{#each criteria as c (c.id)}
							<div class="flex items-start gap-3 text-xs">
								<span class="px-2 py-0.5 rounded border text-[10px] uppercase tracking-wider font-medium flex-shrink-0 {stateBadge[c.state]}">
									{c.state}
								</span>
								<div class="flex-1 min-w-0">
									<div class="flex items-baseline gap-2 flex-wrap">
										<span class="text-hub-text font-medium">{c.title}</span>
										<span class="text-hub-cta font-mono">{c.current}</span>
									</div>
									<div class="text-[11px] text-hub-muted mt-0.5">{c.threshold}</div>
									{#if c.note}
										<div class="text-[10px] text-hub-dim mt-1 italic">{c.note}</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Top agents -->
				{#if metrics.byAgent.length > 0}
					<div class="bg-hub-card rounded-xl border border-hub-border p-4">
						<h2 class="text-sm font-semibold text-hub-text mb-3">Top agents</h2>
						<div class="space-y-1">
							{#each metrics.byAgent as a (a.agentId)}
								<a
									href="/orchestration/agents/{encodeURIComponent(a.agentId)}/runs"
									class="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-hub-bg text-xs cursor-pointer"
								>
									<span class="font-mono text-hub-text min-w-[160px] truncate">{a.agentId}</span>
									<span class="text-hub-muted min-w-[60px]">{a.runs} run{a.runs === 1 ? '' : 's'}</span>
									<span class="text-hub-muted min-w-[80px]">{fmtPct(a.successRate)} ok</span>
									<span class="text-hub-muted min-w-[60px]">{fmtCost(a.costUsd)}</span>
									<span class="text-hub-dim flex-1 text-right">{relTime(a.lastRunAt)}</span>
								</a>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Recent runs -->
				{#if metrics.recent.length > 0}
					<div class="bg-hub-card rounded-xl border border-hub-border p-4">
						<h2 class="text-sm font-semibold text-hub-text mb-3">
							Recent dispatches <span class="text-hub-dim text-xs font-normal">(last {metrics.recent.length})</span>
						</h2>
						<div class="space-y-1">
							{#each metrics.recent as r (r.runId)}
								<div class="flex items-start gap-3 px-2 py-1.5 rounded hover:bg-hub-bg text-xs">
									<span class="font-mono {statusColor[r.status]} min-w-[80px]">{r.status}</span>
									<a
										href="/orchestration/agents/{encodeURIComponent(r.agentId)}/runs"
										class="font-mono text-hub-text min-w-[140px] truncate hover:text-hub-cta cursor-pointer"
									>
										{r.agentId}
									</a>
									<span class="text-hub-muted min-w-[60px]">{fmtMs(r.durationMs)}</span>
									<span class="text-hub-muted min-w-[60px]">{fmtCost(r.costUsd)}</span>
									<span class="text-hub-dim min-w-[80px] font-mono truncate" title={r.jid}>{jidShort(r.jid)}</span>
									<span class="text-hub-dim flex-1 truncate text-right" title={r.taskSpec ?? ''}>{r.taskSpec ?? ''}</span>
									<span class="text-hub-dim min-w-[70px] text-right">{relTime(r.startedAt)}</span>
								</div>
							{/each}
						</div>
					</div>
				{:else}
					<div class="bg-hub-card rounded-xl border border-hub-border p-6 text-center text-sm text-hub-muted">
						No orchestrator dispatches in the last {metrics.period.days} days yet. Send a freeform message to your WhatsApp bot to fire one.
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>
