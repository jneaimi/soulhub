<script lang="ts">
	import { onMount } from 'svelte';

	type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'paused';
	type PublishStatus = 'passed' | 'failed';
	type RunMode = 'production' | 'test' | 'oneshot';
	type RunSource = 'api' | 'scheduler' | 'cli' | 'chat';

	interface RunRow {
		id: number;
		runId: string;
		recipe: string;
		recipeVersion: string;
		project: string;
		status: RunStatus;
		startedAt: number;
		finishedAt: number | null;
		durationMs: number | null;
		mode: RunMode;
		source: RunSource;
		stepsJson: string | null;
		error: string | null;
		failedStep: string | null;
		costUsd: number | null;
	}

	interface PublishRow {
		id: number;
		component: string;
		version: string | null;
		publishedAt: number;
		status: PublishStatus;
		checksJson: string;
		durationMs: number;
	}

	interface RunsResponse {
		type: 'runs';
		total: number;
		results: RunRow[];
	}
	interface PublishesResponse {
		type: 'publishes';
		total: number;
		results: PublishRow[];
	}

	let tab = $state<'runs' | 'publishes'>('runs');
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let runs = $state<RunRow[]>([]);
	let publishes = $state<PublishRow[]>([]);
	let recipeFilter = $state('');
	let runStatusFilter = $state<'' | RunStatus>('');
	let componentFilter = $state('');
	let publishStatusFilter = $state<'' | PublishStatus>('');
	let expandedRun = $state<string | null>(null);
	let expandedPublish = $state<number | null>(null);

	async function load() {
		loading = true;
		loadError = null;
		try {
			const params = new URLSearchParams({ type: tab, limit: '100' });
			if (tab === 'runs') {
				if (recipeFilter) params.set('recipe', recipeFilter);
				if (runStatusFilter) params.set('status', runStatusFilter);
			} else {
				if (componentFilter) params.set('component', componentFilter);
				if (publishStatusFilter) params.set('status', publishStatusFilter);
			}
			const res = await fetch(`/api/naseej/audit?${params}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			const data = (await res.json()) as RunsResponse | PublishesResponse;
			if (data.type === 'runs') runs = data.results;
			else publishes = data.results;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	function switchTab(next: 'runs' | 'publishes') {
		tab = next;
		expandedRun = null;
		expandedPublish = null;
		void load();
	}

	function fmtRelative(at: number): string {
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

	function fmtDuration(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const m = Math.floor(ms / 60_000);
		const s = Math.floor((ms % 60_000) / 1000);
		return `${m}m ${s}s`;
	}

	function fmtCost(usd: number | null): string {
		if (usd === null || usd === 0) return '—';
		return `$${usd.toFixed(4)}`;
	}

	function runStatusClass(s: RunStatus): string {
		if (s === 'success') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
		if (s === 'running') return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
		if (s === 'failed') return 'bg-red-500/15 text-red-300 border-red-500/30';
		if (s === 'cancelled') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
		if (s === 'paused') return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
		return 'bg-hub-card text-hub-muted border-hub-border';
	}

	function publishStatusClass(s: PublishStatus): string {
		if (s === 'passed') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
		return 'bg-red-500/15 text-red-300 border-red-500/30';
	}

	function prettySteps(json: string | null): string {
		if (!json) return '';
		try {
			return JSON.stringify(JSON.parse(json), null, 2);
		} catch {
			return json;
		}
	}

	function prettyChecks(json: string): string {
		try {
			return JSON.stringify(JSON.parse(json), null, 2);
		} catch {
			return json;
		}
	}

	onMount(load);
</script>

<svelte:head>
	<title>Naseej audit — Soul Hub</title>
</svelte:head>

<main class="h-full overflow-y-auto">
	<div class="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6">
		<header class="mb-6 flex items-start justify-between gap-4 flex-wrap">
			<div>
				<h1 class="text-2xl font-semibold tracking-tight text-hub-text">Naseej audit</h1>
				<p class="mt-1 text-sm text-hub-muted max-w-2xl">
					Recipe runs + component publishes. Per ADR-021.
					<a href="/naseej" class="text-hub-info hover:underline">← Marketplace</a>
				</p>
			</div>
			<div class="flex items-center gap-2">
				<button
					class="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors"
					onclick={load}
					disabled={loading}
				>
					{loading ? 'Loading…' : 'Reload'}
				</button>
			</div>
		</header>

		<!-- Tabs -->
		<div class="mb-4 flex items-center gap-1 border-b border-hub-border">
			<button
				class="px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors {tab === 'runs'
					? 'border-hub-info text-hub-text'
					: 'border-transparent text-hub-muted hover:text-hub-text'}"
				onclick={() => switchTab('runs')}
			>
				Runs ({runs.length})
			</button>
			<button
				class="px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors {tab === 'publishes'
					? 'border-hub-info text-hub-text'
					: 'border-transparent text-hub-muted hover:text-hub-text'}"
				onclick={() => switchTab('publishes')}
			>
				Publishes ({publishes.length})
			</button>
		</div>

		{#if loadError}
			<div
				class="mb-4 px-4 py-3 border border-red-500/30 bg-red-500/10 text-red-300 text-sm rounded-md"
				role="alert"
			>
				{loadError}
			</div>
		{/if}

		<!-- Filters -->
		{#if tab === 'runs'}
			<div class="mb-4 flex items-center gap-2 flex-wrap text-xs">
				<input
					type="text"
					placeholder="Filter by recipe name…"
					bind:value={recipeFilter}
					onchange={load}
					class="flex-1 min-w-[200px] px-3 py-1.5 bg-hub-card border border-hub-border rounded-md text-hub-text placeholder:text-hub-muted/50 focus:outline-none focus:border-hub-info"
				/>
				<select
					bind:value={runStatusFilter}
					onchange={load}
					class="px-3 py-1.5 bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:border-hub-info"
				>
					<option value="">All statuses</option>
					<option value="running">Running</option>
					<option value="success">Success</option>
					<option value="failed">Failed</option>
					<option value="cancelled">Cancelled</option>
					<option value="paused">Paused</option>
				</select>
			</div>
		{:else}
			<div class="mb-4 flex items-center gap-2 flex-wrap text-xs">
				<input
					type="text"
					placeholder="Filter by component name…"
					bind:value={componentFilter}
					onchange={load}
					class="flex-1 min-w-[200px] px-3 py-1.5 bg-hub-card border border-hub-border rounded-md text-hub-text placeholder:text-hub-muted/50 focus:outline-none focus:border-hub-info"
				/>
				<select
					bind:value={publishStatusFilter}
					onchange={load}
					class="px-3 py-1.5 bg-hub-card border border-hub-border rounded-md text-hub-text focus:outline-none focus:border-hub-info"
				>
					<option value="">All statuses</option>
					<option value="passed">Passed</option>
					<option value="failed">Failed</option>
				</select>
			</div>
		{/if}

		<!-- Runs tab -->
		{#if tab === 'runs'}
			{#if runs.length === 0 && !loading}
				<div class="border border-dashed border-hub-border rounded-md py-12 text-center text-sm text-hub-muted">
					No recipe runs yet. Trigger one via <code class="text-xs bg-hub-card px-1 rounded">POST /api/recipes/run</code>.
				</div>
			{:else}
				<ul class="space-y-2">
					{#each runs as run (run.id)}
						<li
							class="border border-hub-border rounded-md bg-hub-card/30 hover:bg-hub-card/60 transition-colors"
						>
							<button
								class="w-full text-left p-3 flex items-start gap-3"
								onclick={() => (expandedRun = expandedRun === run.runId ? null : run.runId)}
							>
								<span
									class="px-1.5 py-0.5 text-[10px] rounded border {runStatusClass(run.status)} flex-shrink-0 uppercase tracking-wide"
									>{run.status}</span
								>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 text-sm">
										<span class="font-semibold text-hub-text truncate">{run.recipe}</span>
										<span class="text-[10px] font-mono text-hub-muted">v{run.recipeVersion}</span>
										<span class="text-[10px] font-mono text-hub-muted/70">{run.runId}</span>
									</div>
									<div class="mt-0.5 flex items-center gap-3 text-[11px] text-hub-muted">
										<span>{fmtRelative(run.startedAt)}</span>
										<span>·</span>
										<span>{fmtDuration(run.durationMs)}</span>
										<span>·</span>
										<span>{run.mode}/{run.source}</span>
										<span>·</span>
										<span>{run.project}</span>
										{#if run.costUsd !== null && run.costUsd > 0}
											<span>·</span>
											<span>{fmtCost(run.costUsd)}</span>
										{/if}
										{#if run.failedStep}
											<span>·</span>
											<span class="text-red-300">failed at: {run.failedStep}</span>
										{/if}
									</div>
								</div>
							</button>
							{#if expandedRun === run.runId}
								<div class="px-3 pb-3 text-[11px] font-mono text-hub-muted border-t border-hub-border/50 pt-2">
									<div>started: {fmtAbsolute(run.startedAt)}</div>
									{#if run.finishedAt}
										<div>finished: {fmtAbsolute(run.finishedAt)}</div>
									{/if}
									{#if run.error}
										<div class="mt-2 text-red-300">error: {run.error}</div>
									{/if}
									{#if run.stepsJson}
										<details class="mt-2">
											<summary class="cursor-pointer text-hub-info hover:underline">Steps</summary>
											<pre class="mt-1 text-[10px] whitespace-pre-wrap bg-hub-bg p-2 rounded">{prettySteps(run.stepsJson)}</pre>
										</details>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}

		<!-- Publishes tab -->
		{#if tab === 'publishes'}
			{#if publishes.length === 0 && !loading}
				<div class="border border-dashed border-hub-border rounded-md py-12 text-center text-sm text-hub-muted">
					No publishes yet. Try <code class="text-xs bg-hub-card px-1 rounded">POST /api/components</code>.
				</div>
			{:else}
				<ul class="space-y-2">
					{#each publishes as pub (pub.id)}
						<li
							class="border border-hub-border rounded-md bg-hub-card/30 hover:bg-hub-card/60 transition-colors"
						>
							<button
								class="w-full text-left p-3 flex items-start gap-3"
								onclick={() => (expandedPublish = expandedPublish === pub.id ? null : pub.id)}
							>
								<span
									class="px-1.5 py-0.5 text-[10px] rounded border {publishStatusClass(pub.status)} flex-shrink-0 uppercase tracking-wide"
									>{pub.status}</span
								>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 text-sm">
										<span class="font-semibold text-hub-text truncate">{pub.component}</span>
										{#if pub.version}
											<span class="text-[10px] font-mono text-hub-muted">v{pub.version}</span>
										{/if}
									</div>
									<div class="mt-0.5 flex items-center gap-3 text-[11px] text-hub-muted">
										<span>{fmtRelative(pub.publishedAt)}</span>
										<span>·</span>
										<span>{fmtDuration(pub.durationMs)}</span>
									</div>
								</div>
							</button>
							{#if expandedPublish === pub.id}
								<div class="px-3 pb-3 text-[11px] font-mono text-hub-muted border-t border-hub-border/50 pt-2">
									<div>at: {fmtAbsolute(pub.publishedAt)}</div>
									<details class="mt-2" open>
										<summary class="cursor-pointer text-hub-info hover:underline">Checks</summary>
										<pre class="mt-1 text-[10px] whitespace-pre-wrap bg-hub-bg p-2 rounded">{prettyChecks(pub.checksJson)}</pre>
									</details>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</main>
