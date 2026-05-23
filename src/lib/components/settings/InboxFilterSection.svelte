<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	// Shape returned by GET /api/inbox/filter/stats — see
	// src/routes/api/inbox/filter/stats/+server.ts.
	interface Stats {
		ruleCount: number;
		systemRuleCount: number;
		userRuleCount: number;
		cacheSize: number;
		queuedCount: number;
		skippedCount: number;
		newCount: number;
		processedCount: number;
		byCategory: Record<string, number>;
	}
	interface Worker {
		enabled: boolean;
		llmAvailable: boolean;
		llmDisabled: boolean;
		lastTickAt: number | null;
		lastError: string | null;
		backoffUntilMs: number;
	}

	let stats = $state<Stats | null>(null);
	let worker = $state<Worker | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	// L2 chip palette — same family as inbox/+page.svelte but standalone here
	// so the component can be lifted into other surfaces (setup wizard, etc.)
	// without coupling.
	const categoryColors: Record<string, string> = {
		personal: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
		transactional: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
		notification: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
		promotional: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
		bulk: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
		unclassified: 'bg-hub-surface text-hub-dim border-hub-border',
	};
	const categoryBarColors: Record<string, string> = {
		personal: 'bg-violet-400',
		transactional: 'bg-emerald-400',
		notification: 'bg-sky-400',
		promotional: 'bg-amber-400',
		bulk: 'bg-slate-400',
		unclassified: 'bg-hub-dim/60',
	};
	const CATEGORY_ORDER = [
		'personal',
		'transactional',
		'notification',
		'unclassified',
		'promotional',
		'bulk',
	];

	async function load() {
		try {
			const res = await fetch('/api/inbox/filter/stats');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			stats = data.stats;
			worker = data.worker;
			error = null;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
		// Live-poll every 10s — cheap (pure SQL COUNT + in-memory worker state).
		refreshTimer = setInterval(() => void load(), 10_000);
	});

	onDestroy(() => {
		if (refreshTimer) clearInterval(refreshTimer);
	});

	function timeAgo(ms: number | null): string {
		if (!ms) return 'never';
		const diff = Date.now() - ms;
		if (diff < 1000) return 'just now';
		const s = Math.round(diff / 1000);
		if (s < 60) return `${s}s ago`;
		const m = Math.round(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.round(h / 24)}d ago`;
	}

	// Total of byCategory — drives the percentages in the bar chart.
	const categoryTotal = $derived(
		stats ? Object.values(stats.byCategory).reduce((a, b) => a + b, 0) : 0,
	);

	// Compose a single status line: "Running · LLM available" / "Disabled" /
	// "Running · Rules-only (LLM disabled)" / "Running · Backing off until …".
	const statusLine = $derived.by(() => {
		if (!worker) return { dot: 'bg-hub-dim/50', text: 'Loading…' };
		if (!worker.enabled) return { dot: 'bg-hub-dim/50', text: 'Disabled (INBOX_FILTER_DISABLED=1)' };
		if (worker.backoffUntilMs > Date.now()) {
			const until = new Date(worker.backoffUntilMs).toLocaleTimeString();
			return { dot: 'bg-amber-400 animate-pulse', text: `Backing off until ${until}` };
		}
		if (worker.llmDisabled) return { dot: 'bg-amber-400', text: 'Running · Rules-only (LLM disabled)' };
		if (!worker.llmAvailable) return { dot: 'bg-amber-400', text: 'Running · LLM unavailable (auth failed)' };
		return { dot: 'bg-emerald-400', text: 'Running · LLM available' };
	});
</script>

<section class="mb-6">
	<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">
				Inbox Filter (Layer 2)
			</h2>
			<button
				type="button"
				onclick={() => void load()}
				class="text-[10px] text-hub-dim hover:text-hub-text uppercase tracking-wider px-2 py-0.5 rounded cursor-pointer transition-colors"
				title="Refresh now (auto-polls every 10s)"
			>
				Refresh
			</button>
		</div>

		{#if error}
			<div class="text-xs text-hub-danger bg-hub-danger/10 rounded px-2 py-1.5 mb-3">
				Failed to load stats: {error}
			</div>
		{/if}

		{#if loading && !stats}
			<div class="text-xs text-hub-dim">Loading…</div>
		{:else if stats && worker}
			<!-- Worker status -->
			<div class="space-y-2 mb-4">
				<div class="flex items-center gap-2">
					<span class="w-2 h-2 rounded-full flex-shrink-0 {statusLine.dot}"></span>
					<span class="text-sm text-hub-text">{statusLine.text}</span>
				</div>
				<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-hub-muted pl-4">
					<span>Last tick: <span class="text-hub-text">{timeAgo(worker.lastTickAt)}</span></span>
				</div>
				{#if worker.lastError}
					<div class="text-xs text-hub-danger bg-hub-danger/10 rounded px-2 py-1 ml-4">
						{worker.lastError}
					</div>
				{/if}
			</div>

			<!-- Counts -->
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
				<div class="bg-hub-bg/50 rounded-md px-3 py-2">
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Rules</div>
					<div class="text-sm text-hub-text mt-0.5">
						{stats.ruleCount}
						<span class="text-hub-dim text-xs">({stats.systemRuleCount} sys · {stats.userRuleCount} user)</span>
					</div>
				</div>
				<div class="bg-hub-bg/50 rounded-md px-3 py-2">
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Cache</div>
					<div class="text-sm text-hub-text mt-0.5">{stats.cacheSize.toLocaleString()} entries</div>
				</div>
				<div class="bg-hub-bg/50 rounded-md px-3 py-2">
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Queued</div>
					<div class="text-sm text-emerald-300 mt-0.5">{stats.queuedCount.toLocaleString()}</div>
				</div>
				<div class="bg-hub-bg/50 rounded-md px-3 py-2">
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Skipped</div>
					<div class="text-sm text-hub-muted mt-0.5">{stats.skippedCount.toLocaleString()}</div>
				</div>
				{#if stats.newCount > 0 || stats.processedCount > 0}
					<div class="bg-hub-bg/50 rounded-md px-3 py-2">
						<div class="text-[10px] text-hub-dim uppercase tracking-wider">New</div>
						<div class="text-sm text-blue-300 mt-0.5">{stats.newCount.toLocaleString()}</div>
					</div>
					<div class="bg-hub-bg/50 rounded-md px-3 py-2">
						<div class="text-[10px] text-hub-dim uppercase tracking-wider">Processed</div>
						<div class="text-sm text-hub-text mt-0.5">{stats.processedCount.toLocaleString()}</div>
					</div>
				{/if}
			</div>

			<!-- Category distribution -->
			{#if categoryTotal > 0}
				<div class="mb-4">
					<div class="text-[10px] text-hub-dim uppercase tracking-wider mb-2">
						Category distribution ({categoryTotal.toLocaleString()} classified)
					</div>
					<!-- Stacked bar — proportional segments per category -->
					<div class="flex h-2 rounded-full overflow-hidden bg-hub-bg/50 mb-2">
						{#each CATEGORY_ORDER as cat (cat)}
							{@const count = stats.byCategory[cat] ?? 0}
							{#if count > 0}
								<div
									class="{categoryBarColors[cat]} h-full"
									style="width: {(count / categoryTotal) * 100}%"
									title="{cat}: {count.toLocaleString()} ({((count / categoryTotal) * 100).toFixed(1)}%)"
								></div>
							{/if}
						{/each}
					</div>
					<!-- Legend with counts -->
					<div class="flex flex-wrap gap-1">
						{#each CATEGORY_ORDER as cat (cat)}
							{@const count = stats.byCategory[cat] ?? 0}
							{#if count > 0}
								<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium border {categoryColors[cat]}">
									{cat} · {count.toLocaleString()}
								</span>
							{/if}
						{/each}
					</div>
				</div>
			{:else}
				<div class="text-xs text-hub-dim mb-4">
					No messages classified yet — the worker will start filtering as mail arrives.
				</div>
			{/if}

			<!-- Configuration footer — env vars, deliberately not toggle-able
			     from here. Operator sets via Platform Environment + PM2 reload. -->
			<div class="border-t border-hub-border/50 pt-3 text-[11px] text-hub-dim leading-relaxed">
				<div class="text-[10px] uppercase tracking-wider text-hub-dim mb-1">Configuration</div>
				<p>
					Toggle via env vars in <span class="text-hub-muted">~/.soul-hub/.env</span> +
					PM2 reload to take effect:
				</p>
				<ul class="mt-1 space-y-0.5 ml-3 list-disc">
					<li>
						<code class="text-hub-muted">INBOX_FILTER_DISABLED=1</code> — skip the
						worker entirely
					</li>
					<li>
						<code class="text-hub-muted">INBOX_FILTER_LLM_DISABLED=1</code> — rules-only
						mode (gray-area mail stays <code class="text-hub-muted">new</code>
						until the 7-day fallback)
					</li>
					<li>
						<code class="text-hub-muted">INBOX_FILTER_COLDSTART_SKIP=1</code> — skip
						the historical sweep on fresh installs
					</li>
				</ul>
			</div>
		{/if}
	</div>
</section>
