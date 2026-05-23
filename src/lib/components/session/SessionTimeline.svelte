<script lang="ts">
	import { onMount } from 'svelte';
	import ClaudeSessionPanel from './ClaudeSessionPanel.svelte';
	import SoulHubRunPanel from './SoulHubRunPanel.svelte';
	import PtyLogPanel from './PtyLogPanel.svelte';
	import type { TimelineEntry, TimelineTotals } from '$lib/sessions/joiner.js';

	interface Props {
		project?: string;
		defaultWindow?: '24h' | '7d' | '30d';
	}

	let { project, defaultWindow = '7d' }: Props = $props();

	let loading = $state(true);
	let error = $state('');
	let entries = $state<TimelineEntry[]>([]);
	let totals = $state<TimelineTotals>({ sessionCount: 0, costUsd: 0, toolCalls: 0, filesTouched: 0 });
	let windowSel = $state<'24h' | '7d' | '30d'>(defaultWindow);
	let q = $state('');
	let expanded = $state<Set<string>>(new Set());

	function sinceForWindow(w: '24h' | '7d' | '30d'): string {
		const now = Date.now();
		const days = w === '24h' ? 1 : w === '7d' ? 7 : 30;
		return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const params = new URLSearchParams({
				since: sinceForWindow(windowSel),
				limit: '200',
			});
			if (project) params.set('project', project);
			if (q.trim()) params.set('q', q.trim());
			const res = await fetch(`/api/sessions/timeline?${params}`);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			entries = data.entries ?? [];
			totals = data.totals ?? { sessionCount: 0, costUsd: 0, toolCalls: 0, filesTouched: 0 };
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	$effect(() => {
		// Re-fetch when window changes
		windowSel;
		load();
	});

	function toggle(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function fmtUsd(n: number | null | undefined): string {
		if (n === null || n === undefined) return '—';
		if (n < 0.01) return `$${n.toFixed(4)}`;
		return `$${n.toFixed(2)}`;
	}

	function fmtMs(n: number | undefined): string {
		if (!n) return '—';
		if (n < 1000) return `${n}ms`;
		if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
		return `${Math.floor(n / 60_000)}m ${Math.floor((n / 1000) % 60)}s`;
	}

	function fmtTime(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
	}

	function dayKey(iso: string): string {
		return new Date(iso).toISOString().slice(0, 10);
	}

	function dayLabel(key: string): string {
		const today = new Date().toISOString().slice(0, 10);
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		if (key === today) return 'Today';
		if (key === yesterday) return 'Yesterday';
		return new Date(key).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
	}

	function shortCwd(p: string): string {
		if (!p) return '—';
		if (p.startsWith('/Users/jneaimi/')) return '~/' + p.split('/').slice(3).join('/');
		return p;
	}

	const groupedByDay = $derived.by(() => {
		const groups = new Map<string, TimelineEntry[]>();
		for (const e of entries) {
			const key = dayKey(e.startedAt);
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(e);
		}
		return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
	});
</script>

<div class="flex flex-col h-full bg-hub-bg">
	<!-- Toolbar -->
	<div class="flex-shrink-0 px-4 py-3 border-b border-hub-border bg-hub-surface flex items-center gap-3 flex-wrap">
		<div class="flex items-center gap-1 bg-hub-bg/60 rounded-lg p-0.5">
			{#each ['24h', '7d', '30d'] as w (w)}
				<button
					onclick={() => { windowSel = w as '24h' | '7d' | '30d'; }}
					class="text-xs px-2.5 py-1 rounded transition-colors cursor-pointer {windowSel === w ? 'bg-hub-card text-hub-text' : 'text-hub-dim hover:text-hub-muted'}"
				>{w}</button>
			{/each}
		</div>
		<input
			type="text"
			placeholder="Search prompts, runs, paths…"
			bind:value={q}
			onkeydown={(e) => { if (e.key === 'Enter') load(); }}
			class="flex-1 max-w-md bg-hub-bg/60 border border-hub-border rounded-lg px-3 py-1.5 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50"
		/>
		<button
			onclick={load}
			class="text-xs px-2.5 py-1 rounded text-hub-dim hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
			aria-label="Refresh"
		>Refresh</button>
	</div>

	<!-- Totals bar -->
	{#if !loading && !error}
		<div class="flex-shrink-0 px-4 py-2 border-b border-hub-border/40 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Sessions</div>
				<div class="text-hub-text font-mono">{totals.sessionCount}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Cost</div>
				<div class="text-hub-text font-mono">{fmtUsd(totals.costUsd)}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Tool calls</div>
				<div class="text-hub-text font-mono">{totals.toolCalls}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Files touched</div>
				<div class="text-hub-text font-mono">{totals.filesTouched}</div>
			</div>
		</div>
	{/if}

	<!-- Body -->
	<div class="flex-1 overflow-y-auto">
		{#if loading}
			<div class="p-6 text-center text-sm text-hub-dim">Loading sessions…</div>
		{:else if error}
			<div class="p-6 text-center">
				<p class="text-sm text-hub-danger mb-2">Failed to load: {error}</p>
				<button onclick={load} class="text-xs text-hub-info hover:text-hub-text cursor-pointer">Retry</button>
			</div>
		{:else if entries.length === 0}
			<div class="p-12 text-center text-sm text-hub-dim">
				No sessions in this window{project ? ' for this project' : ''}.
			</div>
		{:else}
			<div class="px-4 py-3 space-y-5">
				{#each groupedByDay as [day, dayEntries] (day)}
					<div>
						<h3 class="text-[10px] uppercase tracking-wider text-hub-dim mb-2 sticky top-0 bg-hub-bg py-1">
							{dayLabel(day)}
							<span class="text-hub-dim/60 ml-2 normal-case">· {dayEntries.length} session{dayEntries.length === 1 ? '' : 's'}</span>
						</h3>
						<div class="space-y-1.5">
							{#each dayEntries as entry (entry.id)}
								{@const isOpen = expanded.has(entry.id)}
								<div class="border border-hub-border/40 rounded-lg overflow-hidden">
									<button
										onclick={() => toggle(entry.id)}
										class="w-full text-left px-3 py-2 hover:bg-hub-card/40 transition-colors cursor-pointer"
									>
										<div class="flex items-center justify-between gap-2 mb-1">
											<div class="flex items-center gap-2 min-w-0">
												<span class="text-[10px] font-mono text-hub-dim flex-shrink-0">{fmtTime(entry.startedAt)}</span>
												{#if entry.kind === 'pty+run'}
													<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-purple/15 text-hub-purple font-mono flex-shrink-0">pty+run</span>
												{:else if entry.kind === 'run'}
													<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-cta/15 text-hub-cta font-mono flex-shrink-0">{entry.run?.surface ?? 'run'}</span>
												{:else}
													<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-info/15 text-hub-info font-mono flex-shrink-0">pty</span>
												{/if}
												{#if entry.claude && entry.claude.sessionIds.length > 0}
													<span class="text-[10px] px-1.5 py-0.5 rounded bg-hub-card text-hub-muted font-mono flex-shrink-0">claude</span>
												{/if}
												<span class="text-xs text-hub-text truncate" title={entry.label}>{entry.label || '(empty)'}</span>
											</div>
											<div class="flex items-center gap-3 flex-shrink-0 text-[10px] text-hub-dim">
												{#if entry.claude && entry.claude.totalCostUsd !== null && entry.claude.totalCostUsd > 0}
													<span class="font-mono">{fmtUsd(entry.claude.totalCostUsd)}</span>
												{/if}
												{#if entry.claude && entry.claude.toolCallCount > 0}
													<span>{entry.claude.toolCallCount} tools</span>
												{/if}
												{#if entry.durationMs}
													<span>{fmtMs(entry.durationMs)}</span>
												{/if}
											</div>
										</div>
										<div class="flex items-center gap-3 text-[10px] text-hub-dim font-mono">
											<span class="truncate" title={entry.cwd}>{shortCwd(entry.cwd)}</span>
											{#if entry.gitBranch}<span class="text-hub-cta/70">{entry.gitBranch}</span>{/if}
										</div>
									</button>
									{#if isOpen}
										<div class="border-t border-hub-border/40 h-96">
											{#if entry.run}
												<SoulHubRunPanel runId={entry.run.runId} />
											{:else if entry.pty && entry.claude && entry.claude.sessionIds.length > 0}
												<ClaudeSessionPanel ptySessionId={entry.pty.id} />
											{:else if entry.pty}
												<PtyLogPanel ptyId={entry.pty.id} />
											{:else}
												<div class="p-4 text-xs text-hub-dim">No detail panel available.</div>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
