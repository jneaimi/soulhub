<script lang="ts">
	import { onMount } from 'svelte';
	import type { RunSummary, StepRollup } from '$lib/sessions/summarize-soul-hub.js';

	interface Props {
		runId: string;
		parentRunId?: string;
	}

	let { runId, parentRunId }: Props = $props();

	type View = 'steps' | 'files' | 'subruns';

	let loading = $state(true);
	let error = $state('');
	let summary = $state<RunSummary | null>(null);
	let view = $state<View>('steps');

	async function load() {
		loading = true;
		error = '';
		try {
			const qs = parentRunId ? `?parentRunId=${encodeURIComponent(parentRunId)}` : '';
			const res = await fetch(`/api/runs/${encodeURIComponent(runId)}${qs}`);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			const data = await res.json();
			summary = data.summary;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);

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

	function shortPath(p: string): string {
		return p.startsWith('/Users/') ? '~/' + p.split('/').slice(3).join('/') : p;
	}

	function statusColor(s: StepRollup['status']): string {
		if (s === 'ok') return 'text-hub-cta';
		if (s === 'error') return 'text-hub-danger';
		if (s === 'skipped') return 'text-hub-dim';
		if (s === 'running') return 'text-hub-info';
		return 'text-hub-muted';
	}

	const totalTokens = $derived(
		summary
			? summary.cost.tokens.input +
					summary.cost.tokens.output +
					summary.cost.tokens.cacheRead +
					summary.cost.tokens.cacheCreate5m +
					summary.cost.tokens.cacheCreate1h
			: 0,
	);
</script>

<div class="h-full flex flex-col bg-[#0a0a0f] text-hub-text">
	{#if loading}
		<div class="flex-1 flex items-center justify-center">
			<p class="text-sm text-hub-dim">Loading run events…</p>
		</div>
	{:else if error}
		<div class="flex-1 flex items-center justify-center p-6">
			<div class="text-center max-w-md">
				<p class="text-sm text-hub-danger mb-2">Failed to load: {error}</p>
				<button
					onclick={load}
					class="text-xs text-hub-info hover:text-hub-text transition-colors cursor-pointer"
				>Retry</button>
			</div>
		</div>
	{:else if !summary}
		<div class="flex-1 flex items-center justify-center p-6">
			<p class="text-sm text-hub-muted">No event log for this run.</p>
		</div>
	{:else}
		{@const s = summary}
		<!-- Header summary grid -->
		<div class="flex-shrink-0 px-4 py-3 border-b border-hub-border/40 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Surface</div>
				<div class="text-hub-text font-mono">{s.surface ?? '—'}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Status</div>
				<div class="font-mono {statusColor(s.status as StepRollup['status'])}">{s.status ?? '—'}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Duration</div>
				<div class="text-hub-text font-mono">{fmtMs(s.durationMs)}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Cost</div>
				<div class="text-hub-text font-mono">{fmtUsd(s.cost.totalUsd)}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Steps</div>
				<div class="text-hub-text font-mono">{s.steps.length}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Tool calls</div>
				<div class="text-hub-text font-mono">{s.toolCallCount}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Tokens</div>
				<div class="text-hub-text font-mono">{fmtTokens(totalTokens)}</div>
			</div>
			<div>
				<div class="text-[10px] text-hub-dim uppercase tracking-wider">Sub-runs</div>
				<div class="text-hub-text font-mono">{s.subRunIds.length}</div>
			</div>
		</div>

		<!-- View tabs -->
		<div class="flex-shrink-0 flex items-center gap-1 px-3 py-1 border-b border-hub-border/40">
			{#each ['steps', 'files', 'subruns'] as v (v)}
				<button
					onclick={() => { view = v as View; }}
					class="text-[11px] px-2.5 py-1 rounded transition-colors cursor-pointer {view === v ? 'bg-hub-surface text-hub-text' : 'text-hub-dim hover:text-hub-muted'}"
				>
					{v === 'steps' ? `Steps (${s.steps.length})` : v === 'files' ? `Files (${s.filesTouched.length})` : `Sub-runs (${s.subRunIds.length})`}
				</button>
			{/each}
		</div>

		<!-- View body -->
		<div class="flex-1 min-h-0 overflow-y-auto px-4 py-3">
			{#if view === 'steps'}
				{#if s.steps.length === 0}
					<p class="text-xs text-hub-dim py-6 text-center">No steps recorded.</p>
				{:else}
					<div class="space-y-2">
						{#each s.steps as step (step.stepId)}
							<div class="border border-hub-border/40 rounded-lg p-3">
								<div class="flex items-center justify-between gap-2 mb-1">
									<div class="flex items-center gap-2 min-w-0">
										<span class="text-xs px-1.5 py-0.5 rounded bg-hub-purple/15 text-hub-purple font-mono">{step.stepType ?? '—'}</span>
										<span class="text-xs text-hub-text font-mono truncate" title={step.stepId}>{step.stepId}</span>
									</div>
									<span class="text-[10px] font-mono {statusColor(step.status)}">{step.status ?? '—'}</span>
								</div>
								<div class="flex items-center gap-3 text-[10px] text-hub-dim">
									<span>{fmtMs(step.durationMs)}</span>
									{#if step.toolCallCount > 0}<span>{step.toolCallCount} tool calls</span>{/if}
									{#if step.agentSpawns.length > 0}<span>{step.agentSpawns.length} agent{step.agentSpawns.length === 1 ? '' : 's'}</span>{/if}
								</div>
								{#if step.error}
									<div class="text-[11px] text-hub-danger mt-1 line-clamp-2">{step.error}</div>
								{/if}
								{#if step.outputPath}
									<a
										href="/files?path={encodeURIComponent(step.outputPath)}"
										class="text-[10px] text-hub-info hover:text-hub-text font-mono mt-1 truncate block"
										title={step.outputPath}
									>→ {shortPath(step.outputPath)}</a>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{:else if view === 'files'}
				{#if s.filesTouched.length === 0 && s.outputs.length === 0}
					<p class="text-xs text-hub-dim py-6 text-center">No files touched in this run.</p>
				{:else}
					<div class="space-y-1">
						<p class="text-[11px] text-hub-dim mb-2">{s.outputs.length} output{s.outputs.length === 1 ? '' : 's'} landed</p>
						{#each s.outputs as out (out.path)}
							<a
								href="/files?path={encodeURIComponent(out.path)}"
								class="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-hub-surface transition-colors cursor-pointer group"
								title={out.path}
							>
								<svg class="w-3.5 h-3.5 text-hub-cta/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
								</svg>
								<span class="text-xs text-hub-text font-mono truncate group-hover:text-hub-cta transition-colors">{out.path.substring(out.path.lastIndexOf('/') + 1)}</span>
								<span class="text-[10px] text-hub-dim/70 truncate flex-1 font-mono">{shortPath(out.path.substring(0, out.path.lastIndexOf('/')))}</span>
								<span class="text-[10px] text-hub-dim flex-shrink-0">{out.surface}</span>
							</a>
						{/each}
					</div>
				{/if}
			{:else if view === 'subruns'}
				{#if s.subRunIds.length === 0}
					<p class="text-xs text-hub-dim py-6 text-center">No sub-runs spawned.</p>
				{:else}
					<div class="space-y-1.5">
						{#each s.subRunIds as childId (childId)}
							<a
								href="/api/runs/{childId}?parentRunId={runId}"
								class="block py-2 px-3 rounded-lg border border-hub-border/40 hover:bg-hub-surface transition-colors cursor-pointer"
							>
								<span class="text-xs font-mono text-hub-cta">{childId}</span>
							</a>
						{/each}
					</div>
				{/if}
			{/if}
		</div>

		{#if s.firstPrompt}
			<div class="flex-shrink-0 px-4 py-2 border-t border-hub-border/40 text-[11px] text-hub-dim italic line-clamp-2" title={s.firstPrompt}>
				"{s.firstPrompt}"
			</div>
		{/if}
	{/if}
</div>
