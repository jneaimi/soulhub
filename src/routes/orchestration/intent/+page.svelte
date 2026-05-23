<script lang="ts">
	import { onMount } from 'svelte';

	type IntentSource = 'regex' | 'llm' | 'pattern' | 'fallback';
	type MatchKind = 'exact' | 'prefix' | 'contains' | 'regex';

	interface SourceCounts {
		regex: number;
		llm: number;
		pattern: number;
		fallback: number;
	}

	interface PatternRow {
		id: number;
		signature: string;
		matchKind: MatchKind;
		pickedRoute: string;
		placeholderText: string | null;
		confidence: number;
		conversationKey: string | null;
		approvedAt: number;
		approvedBy: string;
		hitCount: number;
		lastHitTs: number | null;
		retiredAt: number | null;
	}

	interface RecentRow {
		ts: number;
		conversationKey: string;
		rawMessage: string;
		pickedRoute: string;
		source: IntentSource;
		confidence: number | null;
		latencyMs: number | null;
	}

	interface MetricsResponse {
		ok: boolean;
		period: { fromMs: number; toMs: number; days: number };
		gates: { enabled: boolean; historyFallback: boolean };
		sourceCounts: SourceCounts;
		routeCounts: Array<{ route: string; n: number }>;
		patterns: PatternRow[];
		proposalsPending: number;
		recent: RecentRow[];
	}

	interface ProposedRow {
		id: number;
		batchId: string;
		signature: string;
		matchKind: MatchKind;
		pickedRoute: string;
		placeholderText: string | null;
		confidence: number;
		conversationKey: string | null;
		citations: string[];
		rationale: string | null;
		proposedAt: number;
		dismissedAt: number | null;
	}

	let metrics = $state<MetricsResponse | null>(null);
	let proposed = $state<ProposedRow[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let days = $state<number>(7);
	let actingOnPattern = $state<number | null>(null);
	let actingOnProposal = $state<number | null>(null);

	async function load() {
		loading = true;
		loadError = null;
		try {
			const [metricsRes, proposedRes] = await Promise.all([
				fetch(`/api/intent/metrics?days=${days}`),
				fetch('/api/intent/proposed'),
			]);
			if (!metricsRes.ok) throw new Error(`metrics: HTTP ${metricsRes.status}`);
			if (!proposedRes.ok) throw new Error(`proposed: HTTP ${proposedRes.status}`);
			metrics = (await metricsRes.json()) as MetricsResponse;
			const p = (await proposedRes.json()) as { proposals: ProposedRow[] };
			proposed = p.proposals;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	async function approveProposal(id: number) {
		actingOnProposal = id;
		try {
			const res = await fetch('/api/intent/proposed', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'approve', id }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			await load();
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			actingOnProposal = null;
		}
	}

	async function rejectProposal(id: number) {
		actingOnProposal = id;
		try {
			const res = await fetch('/api/intent/proposed', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reject', id }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			await load();
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			actingOnProposal = null;
		}
	}

	async function retirePattern(id: number) {
		actingOnPattern = id;
		try {
			const res = await fetch('/api/intent/patterns', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'retire', id }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			await load();
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			actingOnPattern = null;
		}
	}

	function fmtRelative(at: number | null | undefined): string {
		if (!at) return '—';
		const ms = Date.now() - at;
		if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
		return `${Math.floor(ms / 86_400_000)}d ago`;
	}

	function fmtAbsolute(at: number): string {
		return new Date(at).toLocaleString('en-GB', {
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			timeZone: 'Asia/Dubai',
		});
	}

	function fmtPct(n: number, total: number): string {
		if (!total) return '0%';
		const p = (n / total) * 100;
		return p < 1 && p > 0 ? '<1%' : `${p.toFixed(0)}%`;
	}

	function fmtPreview(s: string, max = 80): string {
		const trimmed = s.replace(/\s+/g, ' ').trim();
		return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
	}

	const totalDecisions = $derived(() => {
		if (!metrics) return 0;
		const s = metrics.sourceCounts;
		return s.regex + s.llm + s.pattern + s.fallback;
	});

	const llmSkippedPct = $derived(() => {
		const total = totalDecisions();
		if (!total || !metrics) return '0%';
		const skipped = metrics.sourceCounts.regex + metrics.sourceCounts.pattern;
		return fmtPct(skipped, total);
	});

	// Source palette — same hub-* tokens as the rest of the app
	const SOURCE_LABEL: Record<IntentSource, string> = {
		regex: 'Regex',
		pattern: 'Pattern',
		llm: 'LLM',
		fallback: 'Fallback',
	};
	const SOURCE_BAR_CLASS: Record<IntentSource, string> = {
		regex: 'bg-hub-cta',
		pattern: 'bg-hub-purple',
		llm: 'bg-hub-info',
		fallback: 'bg-hub-warning',
	};
	const SOURCE_PILL_CLASS: Record<IntentSource, string> = {
		regex: 'bg-hub-cta/15 text-emerald-300 border-hub-cta/30',
		pattern: 'bg-hub-purple/15 text-violet-300 border-hub-purple/30',
		llm: 'bg-hub-info/15 text-blue-300 border-hub-info/30',
		fallback: 'bg-hub-warning/15 text-amber-300 border-hub-warning/30',
	};

	onMount(() => {
		void load();
	});

	$effect(() => {
		void days;
		if (metrics !== null) void load();
	});
</script>

<svelte:head>
	<title>Intent · Soul Hub</title>
</svelte:head>

<main class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
	<div class="max-w-6xl mx-auto w-full space-y-4">
		<!-- ─── Header ─── -->
		<header class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h1 class="text-lg font-semibold text-hub-text">Intent</h1>
				<p class="text-xs text-hub-muted mt-0.5 max-w-3xl">
					ADR-023 router intelligence — what every freeform message routed to, where the
					decision came from, and whether the learned-pattern engine is paying off. Read the
					<a class="text-hub-info hover:underline" href="https://github.com/jneaimi/soul-hub" rel="noreferrer">ADR</a>
					for the full design.
				</p>
			</div>

			<div class="flex items-center gap-2">
				<label for="period" class="text-[11px] uppercase tracking-wide text-hub-muted">
					Window
				</label>
				<select
					id="period"
					bind:value={days}
					class="bg-hub-card border border-hub-border rounded-md px-2 py-1 text-xs text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-info"
				>
					<option value={1}>24 hours</option>
					<option value={7}>7 days</option>
					<option value={30}>30 days</option>
					<option value={90}>90 days</option>
				</select>
			</div>
		</header>

		{#if loadError}
			<div class="rounded-lg border border-hub-danger/40 bg-hub-danger/10 px-4 py-2 text-xs text-red-200">
				{loadError}
			</div>
		{/if}

		<!-- ─── Gate status row ─── -->
		<div class="rounded-lg border border-hub-border bg-hub-card px-4 py-3 flex flex-wrap items-center gap-3">
			<span class="text-[11px] uppercase tracking-wide text-hub-muted">Engine gates</span>
			{#if loading && !metrics}
				<span class="text-xs text-hub-muted">loading…</span>
			{:else if metrics}
				<span
					class="text-xs px-2 py-0.5 rounded-md border font-mono"
					class:border-hub-cta={metrics.gates.enabled}
					class:bg-hub-cta={false}
					class:text-emerald-300={metrics.gates.enabled}
					class:border-hub-border={!metrics.gates.enabled}
					class:text-hub-muted={!metrics.gates.enabled}
				>
					P2 {metrics.gates.enabled ? 'ON' : 'OFF'}
				</span>
				<span
					class="text-xs px-2 py-0.5 rounded-md border font-mono"
					class:border-hub-cta={metrics.gates.historyFallback}
					class:text-emerald-300={metrics.gates.historyFallback}
					class:border-hub-border={!metrics.gates.historyFallback}
					class:text-hub-muted={!metrics.gates.historyFallback}
				>
					P3 {metrics.gates.historyFallback ? 'ON' : 'OFF'}
				</span>
				<span class="text-[11px] text-hub-muted">
					P2 = learned patterns · P3 = per-user history fallback. Flip via
					<code class="text-hub-text">~/.soul-hub/settings.json → intent.patternEngine</code>
					then PM2 reload.
				</span>
			{/if}
		</div>

		<!-- ─── ROI stat strip ─── -->
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
			<div class="rounded-lg border border-hub-border bg-hub-card px-4 py-3">
				<div class="text-2xl font-semibold text-hub-text">
					{loading && !metrics ? '…' : totalDecisions().toLocaleString()}
				</div>
				<div class="text-[11px] uppercase tracking-wide text-hub-muted mt-0.5">
					Decisions
				</div>
			</div>
			<div class="rounded-lg border border-hub-border bg-hub-card px-4 py-3">
				<div class="text-2xl font-semibold text-hub-text">
					{loading && !metrics ? '…' : llmSkippedPct()}
				</div>
				<div class="text-[11px] uppercase tracking-wide text-hub-muted mt-0.5">
					LLM skipped
				</div>
				<div class="text-[10px] text-hub-dim mt-0.5">regex + pattern</div>
			</div>
			<div class="rounded-lg border border-hub-border bg-hub-card px-4 py-3">
				<div class="text-2xl font-semibold text-hub-text">
					{loading && !metrics ? '…' : (metrics?.sourceCounts.pattern ?? 0).toLocaleString()}
				</div>
				<div class="text-[11px] uppercase tracking-wide text-hub-muted mt-0.5">
					Pattern hits
				</div>
				<div class="text-[10px] text-hub-dim mt-0.5">P2 + P3 combined</div>
			</div>
			<div class="rounded-lg border border-hub-border bg-hub-card px-4 py-3">
				<div class="text-2xl font-semibold text-hub-text">
					{loading && !metrics ? '…' : metrics?.patterns.length ?? 0}
				</div>
				<div class="text-[11px] uppercase tracking-wide text-hub-muted mt-0.5">
					Active patterns
				</div>
			</div>
		</div>

		<!-- ─── Source distribution segmented bar ─── -->
		{#if metrics && totalDecisions() > 0}
			<section class="rounded-lg border border-hub-border bg-hub-card p-4">
				<div class="flex items-center justify-between mb-2">
					<h2 class="text-sm font-semibold text-hub-text">Source distribution</h2>
					<span class="text-[11px] text-hub-muted">
						{totalDecisions().toLocaleString()} decisions · last {metrics.period.days}d
					</span>
				</div>
				<div class="flex h-2 rounded-full overflow-hidden bg-hub-border" aria-label="Source distribution bar">
					{#each ['regex', 'pattern', 'llm', 'fallback'] as src (src)}
						{@const n = metrics.sourceCounts[src as IntentSource]}
						{#if n > 0}
							<div
								class="{SOURCE_BAR_CLASS[src as IntentSource]} h-full"
								style="width: {(n / totalDecisions()) * 100}%"
								title="{SOURCE_LABEL[src as IntentSource]}: {n}"
							></div>
						{/if}
					{/each}
				</div>
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-[11px]">
					{#each ['regex', 'pattern', 'llm', 'fallback'] as src (src)}
						{@const n = metrics.sourceCounts[src as IntentSource]}
						<div class="flex items-center gap-2">
							<span class="w-2 h-2 rounded-sm {SOURCE_BAR_CLASS[src as IntentSource]}"></span>
							<span class="text-hub-text">{SOURCE_LABEL[src as IntentSource]}</span>
							<span class="text-hub-muted font-mono">{n.toLocaleString()}</span>
							<span class="text-hub-dim">({fmtPct(n, totalDecisions())})</span>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ─── Pending proposals ─── -->
		{#if proposed.length > 0}
			<section class="rounded-lg border border-hub-purple/40 bg-hub-purple/5 p-4 space-y-3">
				<div class="flex items-center justify-between gap-3 flex-wrap">
					<div>
						<h2 class="text-sm font-semibold text-hub-text">
							{proposed.length} pending {proposed.length === 1 ? 'proposal' : 'proposals'}
						</h2>
						<p class="text-[11px] text-hub-muted mt-0.5">
							Latest run from the offline analyst. Approve to promote into the runtime
							engine; reject to suppress on future runs.
						</p>
					</div>
				</div>
				<div class="space-y-2">
					{#each proposed as p (p.id)}
						<div class="rounded-md border border-hub-border bg-hub-bg/60 p-3">
							<div class="flex flex-wrap items-start justify-between gap-2">
								<div class="min-w-0 flex-1">
									<div class="flex flex-wrap items-center gap-2">
										<code class="text-xs text-hub-text bg-hub-card px-2 py-0.5 rounded">
											{p.signature}
										</code>
										<span class="text-[10px] uppercase tracking-wide text-hub-dim">
											{p.matchKind}
										</span>
										<span class="text-[10px] text-hub-muted">→</span>
										<code class="text-xs text-hub-info">{p.pickedRoute}</code>
										<span class="text-[10px] font-mono text-hub-muted">
											{p.confidence.toFixed(2)}
										</span>
										<span class="text-[10px] text-hub-dim">
											{p.conversationKey ? `· per-user` : '· global'}
										</span>
									</div>
									{#if p.rationale}
										<p class="text-[11px] text-hub-muted mt-1.5 leading-relaxed">
											{p.rationale}
										</p>
									{/if}
									{#if p.citations.length > 0}
										<details class="mt-1.5">
											<summary class="text-[11px] text-hub-info cursor-pointer hover:underline">
												{p.citations.length} {p.citations.length === 1 ? 'citation' : 'citations'}
											</summary>
											<ul class="mt-1.5 space-y-1 text-[11px] text-hub-muted">
												{#each p.citations as c, i (i)}
													<li class="font-mono leading-snug">• {fmtPreview(c, 180)}</li>
												{/each}
											</ul>
										</details>
									{/if}
								</div>
								<div class="flex items-center gap-1 flex-shrink-0">
									<button
										type="button"
										onclick={() => approveProposal(p.id)}
										disabled={actingOnProposal === p.id}
										class="text-xs px-2.5 py-1 rounded-md bg-hub-cta hover:bg-hub-cta-hover text-hub-bg font-medium transition-colors disabled:opacity-50"
									>
										{actingOnProposal === p.id ? '…' : 'Approve'}
									</button>
									<button
										type="button"
										onclick={() => rejectProposal(p.id)}
										disabled={actingOnProposal === p.id}
										class="text-xs px-2.5 py-1 rounded-md border border-hub-border hover:border-hub-danger text-hub-muted hover:text-hub-danger transition-colors disabled:opacity-50"
									>
										Reject
									</button>
								</div>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- ─── Active patterns table ─── -->
		<section class="rounded-lg border border-hub-border bg-hub-card overflow-hidden">
			<div class="px-4 py-3 border-b border-hub-border flex items-center justify-between">
				<h2 class="text-sm font-semibold text-hub-text">Active patterns</h2>
				<span class="text-[11px] text-hub-muted">
					{metrics?.patterns.length ?? 0} approved
				</span>
			</div>
			{#if loading && !metrics}
				<div class="px-4 py-6 text-xs text-hub-muted">Loading…</div>
			{:else if !metrics?.patterns.length}
				<div class="px-4 py-6 text-xs text-hub-muted">
					No approved patterns yet. The offline analyst writes proposals into
					<code class="text-hub-text">intent_patterns_proposed</code> at 02:00 Asia/Dubai;
					approve them above to populate this table. Until then the LLM router runs as
					normal.
				</div>
			{:else}
				<table class="w-full text-xs">
					<thead class="text-[10px] uppercase tracking-wide text-hub-muted bg-hub-bg/40">
						<tr>
							<th class="text-left px-3 py-2 font-medium">Signature</th>
							<th class="text-left px-3 py-2 font-medium">Match</th>
							<th class="text-left px-3 py-2 font-medium">Route</th>
							<th class="text-right px-3 py-2 font-medium">Conf</th>
							<th class="text-right px-3 py-2 font-medium">Hits</th>
							<th class="text-left px-3 py-2 font-medium">Last hit</th>
							<th class="text-left px-3 py-2 font-medium">Scope</th>
							<th class="text-right px-3 py-2 font-medium">Action</th>
						</tr>
					</thead>
					<tbody>
						{#each metrics.patterns as p (p.id)}
							<tr class="border-t border-hub-border/60 hover:bg-hub-bg/30">
								<td class="px-3 py-2">
									<code class="text-hub-text">{p.signature}</code>
								</td>
								<td class="px-3 py-2 text-hub-muted">{p.matchKind}</td>
								<td class="px-3 py-2">
									<code class="text-hub-info">{p.pickedRoute}</code>
								</td>
								<td class="px-3 py-2 text-right font-mono text-hub-text">
									{p.confidence.toFixed(2)}
								</td>
								<td class="px-3 py-2 text-right font-mono text-hub-text">
									{p.hitCount}
								</td>
								<td class="px-3 py-2 text-hub-muted" title={p.lastHitTs ? fmtAbsolute(p.lastHitTs) : ''}>
									{fmtRelative(p.lastHitTs)}
								</td>
								<td class="px-3 py-2 text-hub-muted">
									{p.conversationKey ? 'per-user' : 'global'}
								</td>
								<td class="px-3 py-2 text-right">
									<button
										type="button"
										onclick={() => retirePattern(p.id)}
										disabled={actingOnPattern === p.id}
										class="text-[11px] text-hub-muted hover:text-hub-danger transition-colors disabled:opacity-50"
									>
										{actingOnPattern === p.id ? '…' : 'Retire'}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>

		<!-- ─── Recent decisions ─── -->
		<section class="rounded-lg border border-hub-border bg-hub-card overflow-hidden">
			<div class="px-4 py-3 border-b border-hub-border flex items-center justify-between">
				<h2 class="text-sm font-semibold text-hub-text">Recent decisions</h2>
				<span class="text-[11px] text-hub-muted">
					last {metrics?.recent.length ?? 0}
				</span>
			</div>
			{#if loading && !metrics}
				<div class="px-4 py-6 text-xs text-hub-muted">Loading…</div>
			{:else if !metrics?.recent.length}
				<div class="px-4 py-6 text-xs text-hub-muted">
					No routing decisions in the window.
				</div>
			{:else}
				<ul>
					{#each metrics.recent as r (r.ts + r.conversationKey)}
						<li class="border-t border-hub-border/60 px-3 py-2 text-xs">
							<div class="flex items-start gap-2">
								<span
									class="text-[10px] uppercase tracking-wide font-mono px-1.5 py-0.5 rounded border {SOURCE_PILL_CLASS[r.source]}"
									title="source: {r.source}"
								>
									{r.source}
								</span>
								<span class="text-hub-muted font-mono shrink-0 w-12" title={fmtAbsolute(r.ts)}>
									{fmtRelative(r.ts)}
								</span>
								<code class="text-hub-info shrink-0">{r.pickedRoute}</code>
								<span class="text-hub-text min-w-0 flex-1 truncate">
									{fmtPreview(r.rawMessage, 100)}
								</span>
								{#if r.latencyMs !== null}
									<span class="text-hub-dim font-mono shrink-0">
										{r.latencyMs}ms
									</span>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</main>
