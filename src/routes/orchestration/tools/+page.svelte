<script lang="ts">
	import { onMount } from 'svelte';

	type Category = 'reply' | 'read' | 'write' | 'agent' | 'skill';

	interface LiveSkill {
		name: string;
		description: string;
	}

	interface LiveAgent {
		id: string;
		description: string;
	}

	type LatencyClass = 'fast' | 'slow' | 'auto';

	interface LatencyInfo {
		explicit_class: LatencyClass;
		samples: number;
		p95_ms: number | null;
		suggested_class: 'fast' | 'slow' | null;
		suggestion_disagrees: boolean;
	}

	interface ToolListing {
		name: string;
		category: Category;
		llm_description: string;
		ui_description: string;
		latencyClass?: LatencyClass;
		latency?: LatencyInfo;
		has_config?: { settingsKey: string; label: string };
		examples?: { user: string; toolArgs: string }[];
		last_invoked_at?: number;
		recent_calls: number;
		/** Present on `invokeSkill` — the live chat-invokable skill list. */
		live_skills?: LiveSkill[];
		/** Present on `dispatchAgent` — the live chat-dispatchable + ready agent list. */
		live_agents?: LiveAgent[];
	}

	interface RecentCall {
		name: string;
		at: number;
		argPreview: string;
	}

	/** ADR-005 S4 — propose/closure audit entry shape from /api/vault/writes. */
	interface VaultWriteEntry {
		action: 'create' | 'update' | 'delete';
		path: string;
		agent: string;
		context?: string;
		zone?: string;
		type?: string;
		success: boolean;
		timestamp: string;
	}

	const PROPOSE_ACTORS = new Set([
		'proposeAdr',
		'proposeSlice',
		'suggestAdrEdit',
		'projectShipSlice',
	]);

	type FilterMode = 'all' | Category;

	let tools = $state<ToolListing[]>([]);
	let recent = $state<RecentCall[]>([]);
	let proposeWrites = $state<VaultWriteEntry[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let filter = $state<FilterMode>('all');
	let search = $state('');
	let expandedNames = $state(new Set<string>());

	const CATEGORY_LABEL: Record<Category, string> = {
		read: 'Read',
		write: 'Write',
		agent: 'Dispatch agent',
		skill: 'Invoke skill',
		reply: 'Reply',
	};

	const CATEGORY_DOT: Record<Category, string> = {
		read: 'bg-blue-500',
		write: 'bg-emerald-500',
		agent: 'bg-violet-500',
		skill: 'bg-amber-500',
		reply: 'bg-slate-400',
	};

	const LATENCY_BADGE: Record<LatencyClass, string> = {
		fast: 'bg-emerald-500/15 text-emerald-300',
		slow: 'bg-amber-500/15 text-amber-300',
		auto: 'bg-slate-500/20 text-slate-300',
	};

	function fmtLatencyMs(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	async function load() {
		try {
			const res = await fetch('/api/orchestrator/tools');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			tools = data.tools ?? [];
			recent = data.recent_calls ?? [];
			loadError = null;
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
		// ADR-005 S4 — pull the 4 propose-* / closure actors from the vault
		// audit log. In-memory ring buffer, resets on PM2 reload. Fail-soft
		// so a vault-writes outage doesn't break the tools page.
		try {
			const wres = await fetch('/api/vault/writes?limit=200');
			if (wres.ok) {
				const wdata = await wres.json();
				const entries: VaultWriteEntry[] = wdata.entries ?? [];
				proposeWrites = entries
					.filter((e) => PROPOSE_ACTORS.has(e.agent))
					.slice(0, 30);
			}
		} catch {
			// best-effort
		}
	}

	const PROPOSE_ACTOR_DOT: Record<string, string> = {
		proposeAdr: 'bg-emerald-500',
		proposeSlice: 'bg-emerald-400',
		suggestAdrEdit: 'bg-amber-400',
		projectShipSlice: 'bg-sky-500',
	};
	const PROPOSE_ACTOR_LABEL: Record<string, string> = {
		proposeAdr: 'propose ADR',
		proposeSlice: 'propose slice',
		suggestAdrEdit: 'suggest edit',
		projectShipSlice: 'ship slice',
	};

	function fmtRelativeIso(ts: string): string {
		const at = Date.parse(ts);
		if (Number.isNaN(at)) return '—';
		return fmtRelative(at);
	}

	function vaultLinkFromPath(path: string): string {
		// Drop trailing .md and prefix with /vault/ so the operator can jump
		// straight into the resulting note. Same convention as ProposalsPanel.
		return `/vault/${path.replace(/\.md$/, '')}`;
	}

	function toggleExpand(name: string) {
		if (expandedNames.has(name)) {
			const next = new Set(expandedNames);
			next.delete(name);
			expandedNames = next;
		} else {
			expandedNames = new Set([...expandedNames, name]);
		}
	}

	function fmtRelative(at: number | undefined): string {
		if (!at) return '—';
		const ms = Date.now() - at;
		if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
		return `${Math.floor(ms / 86_400_000)}d ago`;
	}

	const filteredTools = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return tools.filter((t) => {
			if (filter !== 'all' && t.category !== filter) return false;
			if (q) {
				const haystack = `${t.name} ${t.ui_description} ${t.llm_description}`.toLowerCase();
				if (!haystack.includes(q)) return false;
			}
			return true;
		});
	});

	const summary = $derived({
		total: tools.length,
		read: tools.filter((t) => t.category === 'read').length,
		write: tools.filter((t) => t.category === 'write').length,
		agent: tools.filter((t) => t.category === 'agent').length,
		skill: tools.filter((t) => t.category === 'skill').length,
		reply: tools.filter((t) => t.category === 'reply').length,
	});

	onMount(() => {
		load();
	});
</script>

<svelte:head>
	<title>Tools · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg">
	<header class="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-hub-border">
		<div class="max-w-6xl mx-auto w-full">
			<h1 class="text-lg font-semibold text-hub-text">Tools</h1>
			<p class="text-xs text-hub-muted mt-0.5">
				Tools the orchestrator-v2 LLM can pick from each turn. Read-only registry — tools are
				always-on. Per-item config knobs link out to settings panels where they exist.
			</p>
		</div>
	</header>

	<main class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		<div class="max-w-6xl mx-auto w-full space-y-4">
			{#if loadError}
				<div class="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
					Failed to load: {loadError}
				</div>
			{/if}

			<!-- Summary chips -->
			<div class="flex flex-wrap items-center gap-2 text-xs">
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<strong class="text-hub-text">{summary.total}</strong> tools
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1"></span>
					{summary.read} read
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1"></span>
					{summary.write} write
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1"></span>
					{summary.agent} agent
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1"></span>
					{summary.skill} skill
				</span>
				<span class="px-2 py-1 rounded-md bg-hub-card text-hub-muted">
					<span class="inline-block w-2 h-2 rounded-full bg-slate-400 mr-1"></span>
					{summary.reply} reply
				</span>
			</div>

			<!-- Filters + search -->
			<div class="flex flex-wrap items-center gap-2">
				<div class="flex items-center gap-1 text-xs">
					{#each ['all', 'read', 'write', 'agent', 'skill', 'reply'] as cat}
						<button
							class="px-2 py-1 rounded-md transition-colors {filter === cat
								? 'bg-hub-text text-hub-bg'
								: 'bg-hub-card text-hub-muted hover:text-hub-text'}"
							onclick={() => (filter = cat as FilterMode)}
						>
							{cat === 'all' ? 'All' : CATEGORY_LABEL[cat as Category]}
						</button>
					{/each}
				</div>
				<input
					type="text"
					bind:value={search}
					placeholder="Search…"
					class="flex-1 min-w-[180px] px-3 py-1.5 rounded-md bg-hub-card border border-hub-border text-sm text-hub-text placeholder:text-hub-muted focus:outline-none focus:border-hub-text/40"
				/>
			</div>

			<!-- Tool list -->
			{#if loading}
				<div class="text-sm text-hub-muted py-8 text-center">Loading…</div>
			{:else if filteredTools.length === 0}
				<div class="text-sm text-hub-muted py-8 text-center">
					No tools match the current filter.
				</div>
			{:else}
				<div class="space-y-2">
					{#each filteredTools as t (t.name)}
						{@const expanded = expandedNames.has(t.name)}
						<div class="rounded-lg border border-hub-border bg-hub-card overflow-hidden">
							<button
								class="w-full flex items-start gap-3 px-4 py-3 hover:bg-hub-card/60 transition-colors text-left cursor-pointer"
								onclick={() => toggleExpand(t.name)}
							>
								<span class="mt-1 inline-block w-2 h-2 rounded-full {CATEGORY_DOT[t.category]} flex-shrink-0"></span>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<code class="text-sm font-mono text-hub-text">{t.name}</code>
										<span class="text-[10px] uppercase tracking-wide text-hub-muted">
											{CATEGORY_LABEL[t.category]}
										</span>
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">always on</span>
										{#if t.has_config}
											<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300">configurable</span>
										{/if}
										{#if t.latency}
											{@const cls = t.latency.explicit_class}
											<span
												class="text-[10px] px-1.5 py-0.5 rounded {LATENCY_BADGE[cls]}"
												title={cls === 'slow'
													? 'Slow tool — background-dispatched via runSkillInBackground'
													: cls === 'auto'
														? 'Unclassified — runs inline; suggestion surfaces after 20 samples'
														: 'Fast tool — runs inline inside the orchestrator turn'}
											>
												{cls}
											</span>
											{#if t.latency.suggestion_disagrees && t.latency.suggested_class}
												<span
													class="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300"
													title={`Rolling p95 ${fmtLatencyMs(t.latency.p95_ms)} over ${t.latency.samples} samples — operator-approval needed to flip the manifest`}
												>
													→ suggest {t.latency.suggested_class}
												</span>
											{/if}
										{/if}
									</div>
									<p class="text-xs text-hub-muted mt-1">{t.ui_description}</p>
									<div class="text-[11px] text-hub-muted mt-1 flex gap-3">
										<span>last: {fmtRelative(t.last_invoked_at)}</span>
										<span>recent: {t.recent_calls}</span>
									</div>
								</div>
								<svg
									class="w-4 h-4 text-hub-muted flex-shrink-0 transition-transform {expanded
										? 'rotate-180'
										: ''}"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</button>
							{#if expanded}
								<div class="border-t border-hub-border px-4 py-3 space-y-3 bg-hub-bg/40">
									<div>
										<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
											LLM description (what the model sees)
										</div>
										<p class="text-xs text-hub-text whitespace-pre-wrap">{t.llm_description}</p>
									</div>
									{#if t.latency}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Latency (ADR-030)
											</div>
											<div class="text-xs text-hub-text space-y-0.5">
												<div>
													Manifest class:
													<span class="font-mono">{t.latency.explicit_class}</span>
												</div>
												<div class="text-hub-muted">
													Rolling p95: <span class="font-mono">{fmtLatencyMs(t.latency.p95_ms)}</span>
													over <span class="font-mono">{t.latency.samples}</span> sample{t.latency.samples === 1 ? '' : 's'}
													{#if t.latency.samples < 20}
														<span class="text-[10px]">(need 20 for a suggestion)</span>
													{/if}
												</div>
												{#if t.latency.suggested_class}
													<div class="text-orange-300">
														Suggestion:
														<span class="font-mono">{t.latency.suggested_class}</span>
														{#if t.latency.suggestion_disagrees}
															— disagrees with the manifest. Flip
															<code class="font-mono">latencyClass</code> in
															<code class="font-mono">tools/manifest.ts</code>
															to apply.
														{:else}
															— matches the manifest. Nothing to change.
														{/if}
													</div>
												{/if}
											</div>
										</div>
									{/if}
									{#if t.has_config}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Configurable
											</div>
											<a
												href="/settings"
												class="text-xs text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline"
											>
												{t.has_config.label} <span class="text-hub-muted">({t.has_config.settingsKey})</span>
											</a>
										</div>
									{/if}
									{#if t.live_skills && t.live_skills.length > 0}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Live skills ({t.live_skills.length})
											</div>
											<ul class="space-y-1.5">
												{#each t.live_skills as s}
													<li class="text-xs flex items-baseline gap-2">
														<a
															href="/orchestration/skills"
															class="font-mono text-hub-text hover:text-blue-300 underline-offset-2 hover:underline"
															title="Edit skill overlay on /orchestration/skills"
														>
															{s.name}
														</a>
														<span class="text-hub-muted truncate">{s.description}</span>
													</li>
												{/each}
											</ul>
										</div>
									{:else if t.name === 'invokeSkill'}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Live skills
											</div>
											<p class="text-xs text-hub-muted">
												No chat-invokable skills enabled. <a href="/orchestration/skills" class="text-blue-300 hover:underline">Configure on /orchestration/skills</a>.
											</p>
										</div>
									{/if}
									{#if t.live_agents && t.live_agents.length > 0}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Live agents ({t.live_agents.length})
											</div>
											<ul class="space-y-1.5">
												{#each t.live_agents as a}
													<li class="text-xs flex items-baseline gap-2">
														<a
															href={`/agents/${a.id}`}
															class="font-mono text-hub-text hover:text-blue-300 underline-offset-2 hover:underline"
															title="Open agent detail"
														>
															{a.id}
														</a>
														<span class="text-hub-muted truncate">{a.description}</span>
													</li>
												{/each}
											</ul>
										</div>
									{:else if t.name === 'dispatchAgent'}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Live agents
											</div>
											<p class="text-xs text-hub-muted">
												No chat-dispatchable + ready agents. <a href="/orchestration/agents" class="text-blue-300 hover:underline">Configure on /orchestration/agents</a>.
											</p>
										</div>
									{/if}
									{#if t.examples && t.examples.length > 0}
										<div>
											<div class="text-[10px] uppercase tracking-wide text-hub-muted mb-1">
												Examples
											</div>
											<ul class="space-y-2">
												{#each t.examples as ex}
													<li class="text-xs">
														<div class="text-hub-text">{ex.user}</div>
														<code class="block text-[11px] text-hub-muted font-mono">→ {ex.toolArgs}</code>
													</li>
												{/each}
											</ul>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<!-- Recent invocations (read-only ring buffer) -->
			{#if recent.length > 0}
				<section class="mt-6">
					<h2 class="text-sm font-semibold text-hub-text mb-2">Recent invocations</h2>
					<p class="text-[11px] text-hub-muted mb-2">
						In-memory ring buffer (last 50). Resets on PM2 reload. Persistent telemetry is Phase B.
					</p>
					<div class="rounded-lg border border-hub-border bg-hub-card overflow-hidden divide-y divide-hub-border">
						{#each recent as c}
							<div class="px-3 py-2 text-xs flex items-start gap-3">
								<code class="text-hub-text font-mono">{c.name}</code>
								<span class="text-hub-muted flex-shrink-0">{fmtRelative(c.at)}</span>
								<code class="flex-1 text-[11px] text-hub-muted font-mono truncate">{c.argPreview}</code>
							</div>
						{/each}
					</div>
				</section>
			{/if}

			<!-- ADR-005 S4 — Recent AI proposals + closures (audit-attribution distinguisher) -->
			{#if proposeWrites.length > 0}
				<section class="mt-6">
					<h2 class="text-sm font-semibold text-hub-text mb-2">Recent AI proposals + closures</h2>
					<p class="text-[11px] text-hub-muted mb-2">
						The four AI-write actors from project-phases ADR-005 — colour-coded so proposals (propose ADR / propose slice / suggest edit) are visually distinct from closures (ship slice). Last 30 events; sourced from `/api/vault/writes`.
					</p>
					<div class="mb-2 flex flex-wrap gap-3 text-[11px] text-hub-muted">
						{#each Object.keys(PROPOSE_ACTOR_LABEL) as actor}
							<span class="inline-flex items-center gap-1">
								<span class="w-2 h-2 rounded-full {PROPOSE_ACTOR_DOT[actor]}"></span>
								<code class="font-mono">{actor}</code>
								<span>— {PROPOSE_ACTOR_LABEL[actor]}</span>
							</span>
						{/each}
					</div>
					<div class="rounded-lg border border-hub-border bg-hub-card overflow-hidden divide-y divide-hub-border">
						{#each proposeWrites as w}
							<div class="px-3 py-2 text-xs flex items-start gap-2">
								<span
									class="mt-1 w-2 h-2 rounded-full {PROPOSE_ACTOR_DOT[w.agent] ??
										'bg-slate-500'} flex-shrink-0"
									title={w.agent}
								></span>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<code class="text-hub-text font-mono">{w.agent}</code>
										<span class="text-hub-muted">{fmtRelativeIso(w.timestamp)}</span>
										<span class="text-hub-muted">·</span>
										<a
											href={vaultLinkFromPath(w.path)}
											class="text-hub-info hover:text-hub-text transition-colors truncate"
										>
											{w.path}
										</a>
										{#if !w.success}
											<span class="rounded bg-hub-error/15 px-1.5 py-0.5 text-[10px] text-hub-error">
												refused
											</span>
										{/if}
									</div>
									{#if w.context}
										<div class="text-[11px] text-hub-muted font-mono mt-0.5 truncate">
											{w.context}
										</div>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/if}
		</div>
	</main>
</div>
