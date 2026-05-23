<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import type { FeaturesConfig } from '$lib/config.schema';
	import SystemNotifications from '$lib/components/SystemNotifications.svelte';
	import SchedulerMiniTimeline from '$lib/components/scheduler/SchedulerMiniTimeline.svelte';

	// ADR-008 — feature-visibility flags from the root layout load. The Playbooks
	// homepage card (and its /api/playbooks fetch) are hidden when the flag is off.
	const features = $derived($page.data.features as FeaturesConfig | undefined);
	const showPlaybooks = $derived(features?.playbook !== false);

	// ADR-002: DashboardData previously held `pipelineSummary` for the Pipelines
	// card. Both the field and the card were removed 2026-05-16; the response
	// now returns `recentActivity` + `projectSummary` only and the homepage no
	// longer reads dashboard at all. Kept as an empty marker for future fields.
	type DashboardData = Record<string, never>;

	interface VaultRecent {
		path: string;
		title: string;
		meta: { type?: string; [key: string]: unknown };
		mtime: number;
	}

	let dashboard = $state<DashboardData | null>(null);

	// Playbooks
	interface PlaybookSummary {
		name: string;
		description: string;
		roles: { id: string; provider: string }[];
		phases: { id: string; type: string }[];
	}
	let playbookCount = $state(0);
	let playbookItems = $state<PlaybookSummary[]>([]);
	let playbookProviders = $state<Record<string, boolean>>({});

	// Vault
	let vaultNoteCount = $state(0);
	let vaultRecent = $state<VaultRecent[]>([]);
	let vaultOrphans = $state(0);
	let vaultUnresolved = $state(0);
	let vaultZones = $state<Record<string, number>>({});
	let vaultThisWeek = $state(0);

	// Files Explorer roots
	interface ExplorerRoot {
		id: string;
		name: string;
		path: string;
		resolvedPath: string;
	}
	let explorerRoots = $state<ExplorerRoot[]>([]);

	// Scheduler tile data
	interface SchedulerRunRow {
		status: 'success' | 'error' | string;
		startedAt: string;
	}
	interface SchedulerTaskSummary {
		id: string;
		type: string;
		enabled: boolean;
		cron: string | null;
		timezone: string | null;
		lastStatus: string | null;
		nextRunAt: string | null;
		recentHistory: SchedulerRunRow[];
	}
	let schedulerTasks = $state<SchedulerTaskSummary[]>([]);
	let nowMs = $state(Date.now());
	let tickHandle: ReturnType<typeof setInterval> | null = null;

	const noteTypeColors: Record<string, string> = {
		learning: '#10b981',
		decision: '#f59e0b',
		debugging: '#ef4444',
		pattern: '#8b5cf6',
		research: '#06b6d4',
		output: '#3b82f6',
	};

	async function loadDashboard() {
		try {
			const res = await fetch('/api/dashboard');
			if (res.ok) dashboard = await res.json();
		} catch { /* silent */ }
	}

	async function loadScheduler() {
		try {
			const res = await fetch('/api/scheduler/tasks?historyLimit=7');
			if (res.ok) {
				const data = await res.json();
				schedulerTasks = (data.tasks ?? []).map((t: SchedulerTaskSummary) => ({
					id: t.id,
					type: t.type,
					enabled: t.enabled,
					cron: t.cron ?? null,
					timezone: t.timezone ?? null,
					lastStatus: t.lastStatus,
					nextRunAt: t.nextRunAt,
					recentHistory: t.recentHistory ?? [],
				}));
			}
		} catch { /* silent */ }
	}

	function relativeFromNow(iso: string | null, baseMs: number): string {
		if (!iso) return '—';
		const ms = new Date(iso).getTime() - baseMs;
		if (ms < 0) return 'overdue';
		const mins = Math.floor(ms / 60_000);
		const hours = Math.floor(mins / 60);
		const days = Math.floor(hours / 24);
		if (days > 0) return `${days}d ${hours % 24}h`;
		if (hours > 0) return `${hours}h ${mins % 60}m`;
		return `${mins}m`;
	}

	function countdownLabel(iso: string | null, baseMs: number): string {
		if (!iso) return '—';
		const ms = new Date(iso).getTime() - baseMs;
		if (ms < 0) return '00:00';
		const totalSec = Math.floor(ms / 1000);
		const hours = Math.floor(totalSec / 3600);
		const mins = Math.floor((totalSec % 3600) / 60);
		const secs = totalSec % 60;
		// Show H:MM:SS when ≥1h, else MM:SS
		const pad = (n: number) => n.toString().padStart(2, '0');
		if (hours > 0) return `${hours}:${pad(mins)}:${pad(secs)}`;
		return `${pad(mins)}:${pad(secs)}`;
	}

	const nextTask = $derived.by(() => {
		const candidates = schedulerTasks
			.filter((t) => t.enabled && t.nextRunAt)
			.map((t) => ({ task: t, atMs: new Date(t.nextRunAt!).getTime() }))
			.sort((a, b) => a.atMs - b.atMs);
		return candidates[0]?.task ?? null;
	});

	const upcomingRuns = $derived(
		schedulerTasks
			.filter((t) => t.enabled && t.nextRunAt)
			.map((t) => ({ at: new Date(t.nextRunAt!).getTime(), taskId: t.id }))
			.sort((a, b) => a.at - b.at)
	);

	const schedulerSummary = $derived.by(() => {
		const total = schedulerTasks.length;
		const active = schedulerTasks.filter((t) => t.enabled).length;
		const disabled = schedulerTasks.filter((t) => !t.enabled).length;
		const failed = schedulerTasks.filter((t) => t.lastStatus === 'error').length;
		return { total, active, disabled, failed };
	});

	async function loadPlaybooks() {
		try {
			const res = await fetch('/api/playbooks');
			if (res.ok) {
				const data = await res.json();
				playbookItems = data.playbooks || [];
				playbookCount = playbookItems.length;
				playbookProviders = data.providers || {};
			}
		} catch { /* silent */ }
	}

	const zoneColors: Record<string, string> = {
		inbox: '#f59e0b',
		projects: '#6366f1',
		knowledge: '#06b6d4',
		content: '#8b5cf6',
		operations: '#64748b',
		archive: '#6b7280',
	};
	const zoneOrder = ['knowledge', 'content', 'projects', 'operations', 'inbox', 'archive'];

	async function loadVault() {
		try {
			const [statsRes, recentRes] = await Promise.all([
				fetch('/api/vault'),
				fetch('/api/vault/recent?limit=3')
			]);
			if (statsRes.ok) {
				const data = await statsRes.json();
				vaultNoteCount = data.stats?.totalNotes ?? 0;
				vaultOrphans = data.stats?.orphanNotes ?? 0;
				vaultUnresolved = data.stats?.unresolvedLinks ?? 0;
				vaultZones = data.stats?.notesByZone ?? {};
				const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
				try {
					const allRes = await fetch('/api/vault/recent?limit=200');
					if (allRes.ok) {
						const allData = await allRes.json();
						const notes = allData.notes ?? allData;
						vaultThisWeek = notes.filter((n: VaultRecent) => n.mtime > weekAgo).length;
					}
				} catch { /* silent */ }
			}
			if (recentRes.ok) {
				const data = await recentRes.json();
				vaultRecent = data.notes ?? [];
			}
		} catch { /* silent */ }
	}

	async function loadExplorerRoots() {
		try {
			const res = await fetch('/api/settings/explorer-roots');
			if (res.ok) {
				const data = await res.json();
				explorerRoots = data.roots ?? [];
			}
		} catch { /* silent */ }
	}

	let vaultEventSource: EventSource | null = null;

	let agentCount = $state(0);
	let agentsByBackend = $state<{ pty: number; cli: number; ai: number }>({ pty: 0, cli: 0, ai: 0 });

	let toolCount = $state(0);
	let toolsByCategory = $state<{ read: number; write: number; agent: number; skill: number; reply: number }>({
		read: 0, write: 0, agent: 0, skill: 0, reply: 0,
	});
	let recentToolCalls = $state(0);
	let skillCount = $state(0);

	async function loadAgents() {
		try {
			const res = await fetch('/api/agents');
			if (res.ok) {
				const data = await res.json();
				const list = (data.agents ?? []) as { backend: 'claude-pty' | 'claude-cli-flag' | 'ai-sdk' }[];
				agentCount = list.length;
				agentsByBackend = {
					pty: list.filter((a) => a.backend === 'claude-pty').length,
					cli: list.filter((a) => a.backend === 'claude-cli-flag').length,
					ai: list.filter((a) => a.backend === 'ai-sdk').length,
				};
			}
		} catch { /* silent */ }
	}

	async function loadTools() {
		try {
			const res = await fetch('/api/orchestrator/tools');
			if (res.ok) {
				const data = await res.json();
				const list = (data.tools ?? []) as { category: 'read' | 'write' | 'agent' | 'skill' | 'reply' }[];
				toolCount = list.length;
				toolsByCategory = {
					read: list.filter((t) => t.category === 'read').length,
					write: list.filter((t) => t.category === 'write').length,
					agent: list.filter((t) => t.category === 'agent').length,
					skill: list.filter((t) => t.category === 'skill').length,
					reply: list.filter((t) => t.category === 'reply').length,
				};
				recentToolCalls = (data.recent_calls ?? []).length;
			}
		} catch { /* silent */ }
	}

	async function loadSkills() {
		try {
			const res = await fetch('/api/skills');
			if (res.ok) {
				const data = await res.json();
				skillCount = (data.skills ?? []).length;
			}
		} catch { /* silent */ }
	}

	function refreshVolatile() {
		// Fires on tab focus, SSE reindex, or explicit user action.
		loadVault();
		loadDashboard();
		if (showPlaybooks) loadPlaybooks();
		loadExplorerRoots();
		loadScheduler();
		loadAgents();
		loadTools();
		loadSkills();
	}

	onMount(() => {
		// ADR-037: workspace listing moved to /workspaces, vault projects to /projects.
		// Homepage is now a pure dashboard — bento tiles only, no blocking loaders.
		refreshVolatile();

		// ADR-008 P2: 1s ticker drives the scheduler countdown. Single setInterval.
		tickHandle = setInterval(() => { nowMs = Date.now(); }, 1000);

		const onVisible = () => { if (document.visibilityState === 'visible') refreshVolatile(); };
		document.addEventListener('visibilitychange', onVisible);

		const onVaultRefresh = () => { refreshVolatile(); };
		window.addEventListener('vault:refresh', onVaultRefresh);

		// SSE stream — live-updates when files change or healers run.
		try {
			const es = new EventSource('/api/vault/events');
			vaultEventSource = es;
			let debounce: ReturnType<typeof setTimeout> | null = null;
			es.addEventListener('reindexed', () => {
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => { loadVault(); }, 300);
			});
			es.onerror = () => { /* browser auto-reconnects */ };
		} catch { /* SSE not supported — visibility fallback covers most cases */ }

		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('vault:refresh', onVaultRefresh);
			vaultEventSource?.close();
			if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
		};
	});
</script>

<svelte:head>
	<title>Soul Hub</title>
</svelte:head>

<div class="h-full flex flex-col">
	<!-- Main — bento dashboard. Workspaces live at /workspaces; vault projects at /projects. -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8">
		<div class="max-w-6xl mx-auto">
			<!-- System Notifications -->
			<SystemNotifications />

			<!-- Bento layout — Vault is the hero (full width), Playbooks/Files balance below.
			     ADR-002: Pipelines card removed 2026-05-16. Naseej replaces it; surface is at /naseej. -->
			<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
				<!-- Vault (hero) -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-6">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-1.5">
							<h3 class="text-sm font-semibold text-hub-text">
								Vault
								{#if vaultNoteCount > 0}
									<span class="text-hub-dim font-normal ml-1">({vaultNoteCount})</span>
								{/if}
							</h3>
							<span class="w-2 h-2 rounded-full {vaultUnresolved > 0 ? 'bg-amber-400' : 'bg-emerald-400'}"></span>
						</div>
						<div class="flex items-center gap-2">
							<a
								href="/vault?new=1"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="New note"
								title="New note"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/vault" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">Open vault</a>
						</div>
					</div>

					<!-- Zone distribution -->
					{#if vaultNoteCount > 0 && Object.keys(vaultZones).length > 0}
						<div class="space-y-1 mb-3">
							{#each zoneOrder.filter(z => vaultZones[z]) as zone}
								{@const count = vaultZones[zone] ?? 0}
								{@const pct = Math.round((count / vaultNoteCount) * 100)}
								<div class="flex items-center gap-2">
									<span class="text-[10px] text-hub-dim w-16 text-right truncate">{zone}</span>
									<div class="flex-1 h-1.5 rounded-full bg-hub-bg overflow-hidden">
										<div
											class="h-full rounded-full transition-all duration-500"
											style="width: {pct}%; background-color: {zoneColors[zone] ?? '#64748b'}"
										></div>
									</div>
									<span class="text-[10px] text-hub-dim w-6">{count}</span>
								</div>
							{/each}
						</div>
					{/if}

					<!-- Recent notes -->
					{#if vaultRecent.length > 0}
						<div class="space-y-1.5">
							{#each vaultRecent as note}
								{@const noteType = note.meta?.type ?? 'unknown'}
								<a
									href="/vault?note={encodeURIComponent(note.path)}"
									class="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<span
										class="flex-shrink-0 w-2 h-2 rounded-full"
										style="background-color: {noteTypeColors[noteType] ?? '#64748b'}"
									></span>
									<span class="text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate">{note.title}</span>
								</a>
							{/each}
						</div>
					{:else}
						<p class="text-xs text-hub-dim py-3 text-center">No notes yet</p>
					{/if}

					<!-- Health + activity -->
					<div class="flex items-center gap-3 mt-2 text-[10px]">
						{#if vaultThisWeek > 0}
							<span class="text-hub-cta">+{vaultThisWeek} this week</span>
						{/if}
						{#if vaultUnresolved > 0}
							<span class="text-hub-warning">{vaultUnresolved} broken</span>
						{/if}
						{#if vaultOrphans > 0}
							<span class="text-hub-dim">{vaultOrphans} orphans</span>
						{/if}
						{#if vaultUnresolved === 0 && vaultOrphans === 0 && vaultThisWeek === 0}
							<span class="text-emerald-400">Healthy</span>
						{/if}
					</div>
				</div>

				<!-- Orchestration (ADR-016 — Agents · Skills · Tools · Metrics consolidated) -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-2">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<h3 class="text-sm font-semibold text-hub-text">Orchestration</h3>
						</div>
						<div class="flex items-center gap-2">
							<a href="/orchestration" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer" title="Agents · Skills · Tools · Metrics — all dispatchable layers (ADR-016)">Open</a>
						</div>
					</div>
					<a
						href="/orchestration"
						class="block group"
						title="Agents · Skills · Tools · Metrics"
					>
						<div class="flex items-center justify-around py-2">
							<div class="text-center">
								<div class="text-lg font-semibold text-hub-purple group-hover:text-hub-info transition-colors">{agentCount}</div>
								<div class="text-[10px] text-hub-dim font-mono">AGENTS</div>
							</div>
							<div class="text-center">
								<div class="text-lg font-semibold text-hub-warning group-hover:text-hub-info transition-colors">{skillCount}</div>
								<div class="text-[10px] text-hub-dim font-mono">SKILLS</div>
							</div>
							<div class="text-center">
								<div class="text-lg font-semibold text-emerald-400 group-hover:text-hub-info transition-colors">{toolCount}</div>
								<div class="text-[10px] text-hub-dim font-mono">TOOLS</div>
							</div>
							<div class="text-center">
								<div class="text-lg font-semibold text-hub-info">{recentToolCalls}</div>
								<div class="text-[10px] text-hub-dim font-mono">RECENT</div>
							</div>
						</div>
						<div class="mt-2 pt-2 border-t border-hub-border/50 text-[10px] text-hub-dim text-center">
							All dispatchable layers
						</div>
					</a>
				</div>

				<!-- Scheduler -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-4">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<h3 class="text-sm font-semibold text-hub-text">Scheduler</h3>
							{#if schedulerSummary.total > 0}
								<span class="text-[11px] text-hub-dim bg-hub-bg px-1.5 py-0.5 rounded">{schedulerSummary.total}</span>
							{/if}
						</div>
						<div class="flex items-center gap-2">
							<a
								href="/scheduler/builder"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="New task"
								title="New scheduled task"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/scheduler" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">View all</a>
						</div>
					</div>
					{#if schedulerTasks.length === 0}
						<p class="text-xs text-hub-dim py-3 text-center">No tasks yet</p>
					{:else}
						<!-- Hero: countdown + next task -->
						{#if nextTask}
							<div class="flex items-start gap-3 mb-3">
								<div class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-hub-bg border border-hub-border/60">
									<svg class="w-3.5 h-3.5 text-hub-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
									<span class="font-mono text-sm text-hub-text tabular-nums" aria-label="Time until next scheduled run">
										{countdownLabel(nextTask.nextRunAt, nowMs)}
									</span>
								</div>
								<div class="min-w-0 flex-1">
									<div class="text-xs text-hub-text truncate">{nextTask.id}</div>
									<div class="text-[11px] text-hub-dim truncate">
										{nextTask.cron ?? '—'}{nextTask.timezone ? ` · ${nextTask.timezone}` : ''}
									</div>
								</div>
							</div>

							<!-- Mini-timeline (sm+ only — dense for desktop) -->
							<div class="hidden sm:block mb-3">
								<SchedulerMiniTimeline runs={upcomingRuns} nowMs={nowMs} windowHours={6} />
							</div>
						{/if}

						<!-- Task list with 7-dot history -->
						<div class="space-y-1">
							{#each schedulerTasks.slice(0, 4) as t (t.id)}
								{@const okCount = t.recentHistory.filter((r) => r.status === 'success').length}
								{@const failCount = t.recentHistory.filter((r) => r.status === 'error').length}
								<a
									href="/scheduler"
									class="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<span class="flex-1 min-w-0 text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate">{t.id}</span>
									<span class="text-[11px] text-hub-dim tabular-nums whitespace-nowrap w-16 text-right">
										{t.enabled && t.nextRunAt ? `in ${relativeFromNow(t.nextRunAt, nowMs)}` : t.enabled ? '—' : 'off'}
									</span>
									<span
										class="flex items-center gap-0.5"
										aria-label="Last {t.recentHistory.length} runs: {okCount} ok, {failCount} failed"
									>
										{#each Array.from({ length: 7 }) as _, i}
											{@const run = t.recentHistory[i]}
											<span
												class="w-1.5 h-1.5 rounded-sm {!run ? 'bg-hub-border/40' : run.status === 'success' ? 'bg-hub-cta/70' : run.status === 'error' ? 'bg-hub-danger' : 'bg-hub-info/60'}"
												title={run ? `${run.status} · ${new Date(run.startedAt).toLocaleString()}` : 'no run'}
											></span>
										{/each}
									</span>
								</a>
							{/each}
						</div>

						<!-- Footer strip -->
						<div class="mt-3 pt-2 border-t border-hub-border/50 flex items-center justify-between text-[10px] text-hub-dim">
							<span>
								{schedulerSummary.active} active{schedulerSummary.failed > 0 ? ` · ${schedulerSummary.failed} failed` : ''}{schedulerSummary.disabled > 0 ? ` · ${schedulerSummary.disabled} disabled` : ''}
							</span>
							<a href="/scheduler" class="text-hub-dim hover:text-hub-info transition-colors cursor-pointer">history →</a>
						</div>
					{/if}
				</div>

				{#if showPlaybooks}
				<!-- Playbooks -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-3">
					<div class="flex items-center justify-between mb-3">
						<div class="flex items-center gap-2">
							<h3 class="text-sm font-semibold text-hub-text">Playbooks</h3>
							{#if playbookCount > 0}
								<span class="text-[11px] text-hub-dim bg-hub-bg px-1.5 py-0.5 rounded">{playbookCount}</span>
							{/if}
						</div>
						<div class="flex items-center gap-2">
							<a
								href="/playbooks/builder"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="New playbook"
								title="New playbook"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/playbooks" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">View all</a>
						</div>
					</div>
					{#if playbookItems.length === 0}
						<p class="text-xs text-hub-dim py-3 text-center">No playbooks yet</p>
					{:else}
						<div class="space-y-1.5">
							{#each playbookItems.slice(0, 3) as pb}
								<a
									href="/playbooks/{encodeURIComponent(pb.name)}"
									class="block py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<div class="text-xs text-hub-muted group-hover:text-hub-text transition-colors">{pb.name}</div>
									<div class="text-[11px] text-hub-dim mt-0.5">
										{pb.roles.length} role{pb.roles.length === 1 ? '' : 's'}, {pb.phases.length} phase{pb.phases.length === 1 ? '' : 's'}
									</div>
								</a>
							{/each}
						</div>
					{/if}
					{#if Object.keys(playbookProviders).length > 0}
						<div class="mt-3 pt-2 border-t border-hub-border/50 flex gap-3 text-[10px] text-hub-dim">
							{#each Object.entries(playbookProviders) as [name, available]}
								<span class="flex items-center gap-1">
									<span class="w-1.5 h-1.5 rounded-full {available ? 'bg-hub-cta' : 'bg-hub-border'}"></span>
									{name}
								</span>
							{/each}
						</div>
					{/if}
				</div>

				{/if}
				<!-- Files Explorer -->
				<div class="bg-hub-card rounded-xl p-4 border border-hub-border xl:col-span-3">
					<div class="flex items-center justify-between mb-3">
						<h3 class="text-sm font-semibold text-hub-text">
							Files
							{#if explorerRoots.length > 0}
								<span class="text-hub-dim font-normal ml-1">({explorerRoots.length})</span>
							{/if}
						</h3>
						<div class="flex items-center gap-2">
							<a
								href="/settings#explorer-roots"
								class="w-7 h-7 grid place-items-center rounded-md text-hub-dim hover:text-hub-cta hover:bg-hub-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-hub-cta/50"
								aria-label="Add root"
								title="Add root in Settings"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							</a>
							<a href="/files" class="text-[11px] text-hub-info hover:text-hub-text transition-colors cursor-pointer">Open</a>
						</div>
					</div>
					{#if explorerRoots.length === 0}
						<p class="text-xs text-hub-dim py-3 text-center">
							No folders yet.
							<a href="/settings" class="text-hub-cta hover:underline cursor-pointer">Add one</a>
							to start browsing.
						</p>
					{:else}
						<div class="space-y-1.5">
							{#each explorerRoots.slice(0, 5) as root}
								<a
									href="/files"
									class="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								>
									<svg class="w-3.5 h-3.5 text-hub-cta/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
									</svg>
									<span class="text-xs text-hub-muted group-hover:text-hub-text transition-colors truncate">{root.name}</span>
									<span class="text-[10px] text-hub-dim/70 ml-auto truncate font-mono">{root.path}</span>
								</a>
							{/each}
						</div>
						{#if explorerRoots.length > 5}
							<div class="mt-2 text-[10px] text-hub-dim text-center">
								+{explorerRoots.length - 5} more
							</div>
						{/if}
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
