<script lang="ts">
	import { onMount } from 'svelte';

	interface AuditRow {
		id: number;
		timestamp: number;
		tool: string;
		messageId: number | null;
		actor: string;
		args: unknown;
		result: unknown;
		conversationKey: string | null;
	}

	interface TrustTrainer {
		tool: string;
		confirmed: number;
		threshold: number;
		remaining: number;
		gateActive: boolean;
		forceConfirm: boolean;
	}

	interface AuditResponse {
		actions: AuditRow[];
		total: number;
		byTool: Record<string, number>;
		trustTrainer: TrustTrainer;
	}

	let data = $state<AuditResponse | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	// Filter state
	let toolFilter = $state('');
	let actorFilter = $state<'' | 'orchestrator' | 'worker' | 'operator-direct'>('');
	let confirmedOnly = $state(false);
	let sincePreset = $state<'all' | '1h' | '24h' | '7d' | '30d'>('all');
	let limit = $state(50);
	let offset = $state(0);

	const SINCE_PRESETS: Record<string, number | null> = {
		all: null,
		'1h': 60 * 60 * 1000,
		'24h': 24 * 60 * 60 * 1000,
		'7d': 7 * 24 * 60 * 60 * 1000,
		'30d': 30 * 24 * 60 * 60 * 1000,
	};

	async function load() {
		loading = true;
		const params = new URLSearchParams();
		if (toolFilter) params.set('tool', toolFilter);
		if (actorFilter) params.set('actor', actorFilter);
		if (confirmedOnly) params.set('confirmedOnly', 'true');
		const sinceMs = SINCE_PRESETS[sincePreset];
		if (sinceMs !== null && sinceMs !== undefined) {
			params.set('since', String(Date.now() - sinceMs));
		}
		params.set('limit', String(limit));
		params.set('offset', String(offset));

		try {
			const res = await fetch(`/api/inbox/agent-actions?${params}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			data = await res.json();
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function applyFilters() {
		offset = 0;
		void load();
	}

	function clearFilters() {
		toolFilter = '';
		actorFilter = '';
		confirmedOnly = false;
		sincePreset = 'all';
		offset = 0;
		void load();
	}

	function nextPage() {
		offset += limit;
		void load();
	}
	function prevPage() {
		offset = Math.max(0, offset - limit);
		void load();
	}

	function fmtRelative(at: number | undefined): string {
		if (!at) return '—';
		const ms = Date.now() - at;
		if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
		return `${Math.floor(ms / 86_400_000)}d ago`;
	}

	function fmtAbsolute(at: number): string {
		return new Date(at).toLocaleString('en-GB', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			timeZone: 'Asia/Dubai',
		});
	}

	function resultOk(r: unknown): boolean | null {
		if (r && typeof r === 'object' && 'ok' in r) {
			return (r as { ok: unknown }).ok === true;
		}
		return null;
	}

	function jsonPreview(v: unknown, max = 140): string {
		if (v === null || v === undefined) return '';
		try {
			const s = JSON.stringify(v);
			return s.length > max ? s.slice(0, max - 1) + '…' : s;
		} catch {
			return String(v);
		}
	}

	const ACTOR_DOT: Record<string, string> = {
		orchestrator: 'bg-violet-500',
		worker: 'bg-blue-500',
		'operator-direct': 'bg-emerald-500',
	};

	const showingFrom = $derived(data ? offset + 1 : 0);
	const showingTo = $derived(data ? Math.min(offset + data.actions.length, data.total) : 0);

	onMount(() => {
		void load();
	});
</script>

<svelte:head>
	<title>Audit · Soul Hub</title>
</svelte:head>

<main class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
	<div class="max-w-6xl mx-auto w-full space-y-4">
		<header>
			<h1 class="text-lg font-semibold text-hub-text">Audit log</h1>
			<p class="text-xs text-hub-muted mt-0.5">
				Every Layer 3 tool invocation writes a row (ADR-L3 §D7 Guardrail 2). Read-only —
				never deleted, even when the related message is pruned. Append-only via the
				orchestrator's tool internals.
			</p>
		</header>

		{#if loadError}
			<div class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
				Failed to load: {loadError}
			</div>
		{/if}

		<!-- Trust trainer panel -->
		{#if data?.trustTrainer}
			{@const tt = data.trustTrainer}
			{@const pct = Math.min(100, Math.round((tt.confirmed / tt.threshold) * 100))}
			<section class="rounded-lg border border-hub-border bg-hub-card p-4">
				<div class="flex items-start justify-between gap-4 flex-wrap">
					<div>
						<div class="text-xs uppercase tracking-wide text-hub-muted">
							Trust trainer · ADR-L3 §D7 Guardrail 1
						</div>
						<div class="mt-1 text-sm text-hub-text">
							<code class="font-mono">{tt.tool}</code>:
							{tt.confirmed} / {tt.threshold} confirmed
							{#if tt.gateActive}
								<span class="text-amber-300 ml-1">
									— gate active ({tt.remaining} to go)
								</span>
							{:else}
								<span class="text-emerald-300 ml-1">— gate lifted (auto-confirm)</span>
							{/if}
							{#if tt.forceConfirm}
								<span class="text-orange-300 ml-2">
									· forced via <code class="font-mono text-[11px]">INBOX_MARK_PROCESSED_CONFIRM=always</code>
								</span>
							{/if}
						</div>
						<p class="text-[11px] text-hub-muted mt-2 max-w-2xl">
							Until the operator has confirmed 50 successful mark-processed calls, the tool
							returns a proposal ("Confirm I should mark this as processed?") instead of
							executing. After the threshold the gate lifts and the tool runs directly.
						</p>
					</div>
					<div class="w-full sm:w-64 flex-shrink-0">
						<div class="h-2 rounded-full bg-hub-bg overflow-hidden">
							<div
								class="h-full transition-all {tt.gateActive ? 'bg-amber-500' : 'bg-emerald-500'}"
								style="width: {pct}%"
							></div>
						</div>
						<div class="text-[10px] text-hub-muted mt-1 text-right">{pct}%</div>
					</div>
				</div>
			</section>
		{/if}

		<!-- byTool histogram -->
		{#if data?.byTool && Object.keys(data.byTool).length > 0}
			<section>
				<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-2">By tool</div>
				<div class="flex flex-wrap items-center gap-1.5 text-xs">
					{#each Object.entries(data.byTool) as [tool, count]}
						<button
							class="px-2 py-1 rounded-md transition-colors {toolFilter === tool
								? 'bg-hub-text text-hub-bg'
								: 'bg-hub-card text-hub-muted hover:text-hub-text'}"
							onclick={() => {
								toolFilter = toolFilter === tool ? '' : tool;
								applyFilters();
							}}
							title="Click to filter / click again to clear"
						>
							<code class="font-mono">{tool}</code>
							<span class="ml-1 text-[10px] opacity-70">{count}</span>
						</button>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Filters -->
		<section class="flex flex-wrap items-center gap-2 text-xs">
			<select
				bind:value={actorFilter}
				onchange={applyFilters}
				class="px-2 py-1 rounded-md bg-hub-card border border-hub-border text-hub-text focus:outline-none focus:border-hub-text/40"
			>
				<option value="">All actors</option>
				<option value="orchestrator">orchestrator</option>
				<option value="worker">worker</option>
				<option value="operator-direct">operator-direct</option>
			</select>

			<select
				bind:value={sincePreset}
				onchange={applyFilters}
				class="px-2 py-1 rounded-md bg-hub-card border border-hub-border text-hub-text focus:outline-none focus:border-hub-text/40"
			>
				<option value="all">All time</option>
				<option value="1h">Last hour</option>
				<option value="24h">Last 24h</option>
				<option value="7d">Last 7d</option>
				<option value="30d">Last 30d</option>
			</select>

			<label class="flex items-center gap-1.5 px-2 py-1 rounded-md bg-hub-card cursor-pointer">
				<input type="checkbox" bind:checked={confirmedOnly} onchange={applyFilters} class="accent-emerald-500" />
				<span class="text-hub-text">Success only</span>
			</label>

			{#if toolFilter || actorFilter || confirmedOnly || sincePreset !== 'all'}
				<button
					class="px-2 py-1 rounded-md bg-hub-card text-hub-muted hover:text-hub-text transition-colors"
					onclick={clearFilters}
				>
					Clear filters
				</button>
			{/if}

			<span class="ml-auto text-hub-muted">
				{#if data}
					{showingFrom}–{showingTo} of {data.total}
				{/if}
			</span>
		</section>

		<!-- Action table -->
		{#if loading}
			<div class="text-sm text-hub-muted py-8 text-center">Loading…</div>
		{:else if data && data.actions.length === 0}
			<div class="rounded-lg border border-hub-border bg-hub-card text-sm text-hub-muted py-8 text-center">
				No rows match the current filters.
			</div>
		{:else if data}
			<div class="rounded-lg border border-hub-border bg-hub-card overflow-hidden divide-y divide-hub-border">
				{#each data.actions as row (row.id)}
					{@const okFlag = resultOk(row.result)}
					<div class="px-3 py-2.5 text-xs flex items-start gap-3 hover:bg-hub-card/60">
						<span
							class="mt-1 inline-block w-2 h-2 rounded-full {ACTOR_DOT[row.actor] ?? 'bg-slate-500'} flex-shrink-0"
							title={row.actor}
						></span>
						<div class="flex-1 min-w-0">
							<div class="flex items-baseline gap-2 flex-wrap">
								<code class="font-mono text-hub-text">{row.tool}</code>
								{#if row.messageId !== null}
									<span class="text-hub-muted">msg <code class="font-mono">{row.messageId}</code></span>
								{/if}
								<span class="text-[10px] text-hub-muted">{row.actor}</span>
								{#if okFlag === true}
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">ok</span>
								{:else if okFlag === false}
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">err</span>
								{/if}
								<span
									class="ml-auto text-[10px] text-hub-muted whitespace-nowrap"
									title={fmtAbsolute(row.timestamp)}
								>
									{fmtRelative(row.timestamp)}
								</span>
							</div>
							{#if row.args !== null}
								<div class="mt-1 text-[11px] text-hub-muted font-mono truncate" title={jsonPreview(row.args, 600)}>
									args: <span class="text-hub-text/80">{jsonPreview(row.args)}</span>
								</div>
							{/if}
							{#if row.result !== null}
								<div class="text-[11px] text-hub-muted font-mono truncate" title={jsonPreview(row.result, 600)}>
									result: <span class="text-hub-text/80">{jsonPreview(row.result)}</span>
								</div>
							{/if}
							{#if row.conversationKey}
								<div class="text-[10px] text-hub-muted/70 font-mono truncate mt-0.5">
									conv: {row.conversationKey}
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			<!-- Pagination -->
			{#if data.total > limit}
				<div class="flex items-center justify-between text-xs">
					<button
						class="px-3 py-1 rounded-md bg-hub-card text-hub-muted hover:text-hub-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						onclick={prevPage}
						disabled={offset === 0}
					>
						← Prev
					</button>
					<span class="text-hub-muted">
						Page {Math.floor(offset / limit) + 1} of {Math.ceil(data.total / limit)}
					</span>
					<button
						class="px-3 py-1 rounded-md bg-hub-card text-hub-muted hover:text-hub-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
						onclick={nextPage}
						disabled={offset + limit >= data.total}
					>
						Next →
					</button>
				</div>
			{/if}
		{/if}
	</div>
</main>
