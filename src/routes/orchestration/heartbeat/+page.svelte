<script lang="ts">
	import { onMount } from 'svelte';

	interface Commitment {
		id: number;
		channel: string;
		target: string;
		suggestedText: string;
		dueAfterTs: number;
		status: 'pending' | 'surfaced' | 'dismissed';
		source: 'extractor' | 'user-explicit' | 'crm-followup';
		confidence: number;
		createdAt: number;
	}
	interface LogEntry {
		ts: number;
		target: string;
		taskName?: string;
		status: string;
		model?: string;
	}
	interface Feed {
		commitments: Commitment[];
		log: LogEntry[];
		voiceSurface: { notePath: string; ackedAt: number }[];
	}

	let feed = $state<Feed | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch('/api/orchestration/heartbeat');
			const data = await res.json();
			if (!data.ok) throw new Error(data.error ?? 'request failed');
			feed = {
				commitments: data.commitments ?? [],
				log: data.log ?? [],
				voiceSurface: data.voiceSurface ?? [],
			};
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function fmtTime(ts: number): string {
		return new Date(ts).toLocaleString('en-GB', {
			day: '2-digit',
			month: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		});
	}
	function statusBadge(s: string): string {
		return s === 'pending' ? '⏳ pending' : s === 'surfaced' ? '✓ surfaced' : '✕ dismissed';
	}
	function sourceLabel(s: string): string {
		return s === 'user-explicit' ? 'you asked' : s === 'crm-followup' ? 'CRM follow-up' : 'inferred';
	}
</script>

<div class="flex-1 overflow-y-auto">
	<div class="max-w-6xl mx-auto w-full px-4 sm:px-6 py-6 space-y-6">
		<header class="flex items-start justify-between gap-3">
			<div>
				<h1 class="text-lg font-semibold text-hub-text">Heartbeat</h1>
				<p class="mt-1 text-xs text-hub-muted">
					Proactive work the heartbeat is tracking — what's queued, what fired, and why.
					Read-only; disposition (approve / snooze / dismiss) lands in a later phase.
				</p>
			</div>
			<button
				class="flex-shrink-0 rounded-md border border-hub-border px-2 py-1 text-xs text-hub-muted transition-colors hover:bg-hub-card hover:text-hub-text"
				onclick={load}
				disabled={loading}
			>
				{loading ? 'Refreshing…' : 'Refresh'}
			</button>
		</header>

		{#if loading && !feed}
			<p class="text-sm text-hub-muted">Loading…</p>
		{:else if loadError}
			<p class="text-sm text-red-400">Failed to load: {loadError}</p>
		{:else if feed}
			<!-- Commitments -->
			<section class="space-y-2">
				<h2 class="text-sm font-medium text-hub-text">Commitments ({feed.commitments.length})</h2>
				{#if feed.commitments.length === 0}
					<p class="text-xs text-hub-muted">Nothing tracked right now.</p>
				{:else}
					<div class="space-y-1.5">
						{#each feed.commitments as c (c.id)}
							<div class="rounded-lg border border-hub-border bg-hub-card px-3 py-2">
								<div class="flex items-start justify-between gap-2">
									<span class="text-sm text-hub-text">{c.suggestedText}</span>
									<span class="flex-shrink-0 text-xs text-hub-muted whitespace-nowrap">{statusBadge(c.status)}</span>
								</div>
								<div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-hub-muted">
									<span>why: {sourceLabel(c.source)} · conf {(c.confidence * 100).toFixed(0)}%</span>
									<span>due {fmtTime(c.dueAfterTs)}</span>
									<span>{c.channel} · {c.target}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Recent ticks (proactive run log) -->
			<section class="space-y-2">
				<h2 class="text-sm font-medium text-hub-text">Recent ticks ({feed.log.length})</h2>
				{#if feed.log.length === 0}
					<p class="text-xs text-hub-muted">No runs logged yet.</p>
				{:else}
					<div class="space-y-1">
						{#each feed.log as e}
							<div class="flex items-center gap-3 rounded-md border border-hub-border bg-hub-card px-3 py-1.5 text-xs">
								<span class="text-hub-muted whitespace-nowrap">{fmtTime(e.ts)}</span>
								<span class="text-hub-text">{e.status}</span>
								{#if e.taskName}<span class="text-hub-muted">· {e.taskName}</span>{/if}
								{#if e.model}<span class="ml-auto text-hub-muted">{e.model}</span>{/if}
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Voice-queue surface -->
			<section class="space-y-2">
				<h2 class="text-sm font-medium text-hub-text">Voice surface ({feed.voiceSurface.length})</h2>
				{#if feed.voiceSurface.length === 0}
					<p class="text-xs text-hub-muted">No voice-queue items within the ack window.</p>
				{:else}
					<div class="space-y-1">
						{#each feed.voiceSurface as v}
							<div class="flex items-center gap-3 rounded-md border border-hub-border bg-hub-card px-3 py-1.5 text-xs">
								<span class="text-hub-text truncate">{v.notePath}</span>
								<span class="ml-auto text-hub-muted whitespace-nowrap">{fmtTime(v.ackedAt)}</span>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/if}
	</div>
</div>
