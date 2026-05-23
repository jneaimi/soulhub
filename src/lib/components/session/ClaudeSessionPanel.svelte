<script lang="ts">
	import { onMount } from 'svelte';
	import type { ClaudeSession, SessionSummary, ClaudeSessionRef } from '$lib/sessions/types.js';
	import ToolCallTimeline from './ToolCallTimeline.svelte';
	import FileChangesList from './FileChangesList.svelte';
	import SubagentTree from './SubagentTree.svelte';

	interface Props {
		ptySessionId: string;
	}

	let { ptySessionId }: Props = $props();

	type View = 'tools' | 'files' | 'subagents';

	let loading = $state(true);
	let error = $state('');
	let refs = $state<ClaudeSessionRef[]>([]);
	let summaries = $state<SessionSummary[]>([]);
	let selectedClaudeId = $state<string>('');
	let view = $state<View>('tools');

	// When the user switches Claude session, fetch its full event timeline.
	let currentSession = $state<ClaudeSession | null>(null);
	let currentSummary = $state<SessionSummary | null>(null);
	let detailLoading = $state(false);

	const selectedRef = $derived(refs.find((r) => r.sessionId === selectedClaudeId));
	const selectedSummary = $derived(summaries.find((s) => s.sessionId === selectedClaudeId));

	async function loadList() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`/api/sessions/${ptySessionId}/claude`);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			refs = data.refs ?? [];
			summaries = data.summaries ?? [];
			if (refs.length > 0 && !selectedClaudeId) selectedClaudeId = refs[0].sessionId;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	async function loadDetail(claudeId: string) {
		detailLoading = true;
		currentSession = null;
		currentSummary = null;
		try {
			const res = await fetch(`/api/sessions/${ptySessionId}/claude/${claudeId}`);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			currentSession = data.session;
			currentSummary = data.summary;
		} catch (e) {
			console.error('detail load failed', e);
		} finally {
			detailLoading = false;
		}
	}

	$effect(() => {
		if (selectedClaudeId) loadDetail(selectedClaudeId);
	});

	onMount(loadList);

	function fmtUsd(n: number | null | undefined): string {
		if (n === null || n === undefined) return '—';
		if (n < 0.01) return `$${n.toFixed(4)}`;
		return `$${n.toFixed(2)}`;
	}

	function fmtTokens(n: number | undefined): string {
		if (!n) return '0';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
		return String(n);
	}

	function fmtMs(n: number | undefined): string {
		if (!n) return '—';
		if (n < 1000) return `${n}ms`;
		if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
		return `${Math.floor(n / 60_000)}m ${Math.floor((n / 1000) % 60)}s`;
	}
</script>

<div class="h-full flex flex-col bg-[#0a0a0f] text-hub-text">
	{#if loading}
		<div class="flex-1 flex items-center justify-center">
			<p class="text-sm text-hub-dim">Loading Claude session data…</p>
		</div>
	{:else if error}
		<div class="flex-1 flex items-center justify-center p-6">
			<div class="text-center max-w-md">
				<p class="text-sm text-hub-danger mb-2">Failed to load: {error}</p>
				<button
					onclick={loadList}
					class="text-xs text-hub-info hover:text-hub-text transition-colors cursor-pointer"
				>Retry</button>
			</div>
		</div>
	{:else if refs.length === 0}
		<div class="flex-1 flex items-center justify-center p-6">
			<div class="text-center max-w-md">
				<svg class="w-10 h-10 text-hub-dim mx-auto mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
				</svg>
				<p class="text-sm text-hub-muted">No matching Claude Code session for this terminal.</p>
				<p class="text-[11px] text-hub-dim mt-1">Shell-only PTY sessions or sessions where Claude Code wasn't started won't show here.</p>
			</div>
		</div>
	{:else}
		<!-- Session selector when multiple matched -->
		{#if refs.length > 1}
			<div class="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-hub-border/40 overflow-x-auto">
				<span class="text-[10px] text-hub-dim flex-shrink-0">Sessions ({refs.length}):</span>
				{#each refs as ref}
					<button
						onclick={() => { selectedClaudeId = ref.sessionId; }}
						class="text-[11px] px-2 py-1 rounded font-mono whitespace-nowrap transition-colors cursor-pointer {selectedClaudeId === ref.sessionId ? 'bg-hub-cta/20 text-hub-cta' : 'text-hub-muted hover:bg-hub-surface'}"
					>
						{ref.sessionId.slice(0, 8)}
					</button>
				{/each}
			</div>
		{/if}

		{#if selectedSummary}
			{@const s = selectedSummary}
			<!-- Header summary -->
			<div class="flex-shrink-0 px-4 py-3 border-b border-hub-border/40 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Cost</div>
					<div class="text-hub-text font-mono">{fmtUsd(s.cost.totalUsd)}</div>
				</div>
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Model</div>
					<div class="text-hub-text font-mono truncate" title={s.model}>{s.model ?? '—'}</div>
				</div>
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Duration</div>
					<div class="text-hub-text font-mono">{fmtMs(s.durationMs)}</div>
				</div>
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Branch</div>
					<div class="text-hub-text font-mono truncate" title={s.gitBranch}>{s.gitBranch ?? '—'}</div>
				</div>
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Tokens</div>
					<div class="text-hub-text font-mono">{fmtTokens(s.cost.tokens.input + s.cost.tokens.output + s.cost.tokens.cacheCreate + s.cost.tokens.cacheRead)}</div>
				</div>
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Tool calls</div>
					<div class="text-hub-text font-mono">{s.toolCallCount}</div>
				</div>
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Files</div>
					<div class="text-hub-text font-mono">{s.filesTouched.length}</div>
				</div>
				<div>
					<div class="text-[10px] text-hub-dim uppercase tracking-wider">Sub-agents</div>
					<div class="text-hub-text font-mono">{s.subagents.length}</div>
				</div>
			</div>

			<!-- View tabs -->
			<div class="flex-shrink-0 flex items-center gap-1 px-3 py-1 border-b border-hub-border/40">
				{#each ['tools', 'files', 'subagents'] as v (v)}
					<button
						onclick={() => { view = v as View; }}
						class="text-[11px] px-2.5 py-1 rounded transition-colors cursor-pointer {view === v ? 'bg-hub-surface text-hub-text' : 'text-hub-dim hover:text-hub-muted'}"
					>
						{v === 'tools' ? `Tools (${s.toolCallCount})` : v === 'files' ? `Files (${s.filesTouched.length})` : `Sub-agents (${s.subagents.length})`}
					</button>
				{/each}
			</div>

			<!-- View body -->
			<div class="flex-1 min-h-0 overflow-y-auto px-4 py-3">
				{#if view === 'tools'}
					{#if detailLoading}
						<p class="text-xs text-hub-dim py-6 text-center">Loading events…</p>
					{:else if currentSession}
						<ToolCallTimeline events={currentSession.events} toolBreakdown={s.toolBreakdown} />
					{/if}
				{:else if view === 'files'}
					<FileChangesList filesTouched={s.filesTouched} fileSnapshots={s.fileSnapshots} />
				{:else if view === 'subagents'}
					<SubagentTree {ptySessionId} claudeSessionId={s.sessionId} subagents={s.subagents} />
				{/if}
			</div>

			{#if s.firstPrompt}
				<div class="flex-shrink-0 px-4 py-2 border-t border-hub-border/40 text-[11px] text-hub-dim italic line-clamp-2" title={s.firstPrompt}>
					"{s.firstPrompt}"
				</div>
			{/if}
		{/if}
	{/if}
</div>
