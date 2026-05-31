<script lang="ts">
	/** O3 D3 — workbench approval surface. The page the 🔍 Investigate Telegram
	 *  button deep-links to. Single-run focus: transcript + velocity + actions,
	 *  driven by the D1 endpoint (POST /api/agents/runs/[runId]/approve-budget).
	 *
	 *  Banner + greyed actions when the budget-approval row has TTL'd / been
	 *  resolved elsewhere (Telegram tap, prior workbench call). */

	import { goto } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** runId is stable across the lifetime of this page. */
	const runId = data.runId;

	/** Action state — disabled while a POST is in flight. */
	let busy = $state(false);
	let error = $state('');
	let successMessage = $state('');

	/** UI panel state. */
	let showCustom = $state(false);
	let showStopForm = $state(false);
	let customUsd = $state<number | null>(null);
	let customTurns = $state<number | null>(null);
	let stopReason = $state('');

	function fmtUsd(n: number): string {
		return `$${n.toFixed(2)}`;
	}

	function pctSpend(): number {
		if (!data.approval) return 0;
		const c = data.approval.ceilingUsd;
		if (c <= 0) return 0;
		return Math.min(100, (data.approval.spentUsd / c) * 100);
	}

	function pctTurns(): number {
		if (!data.approval) return 0;
		const c = data.approval.ceilingTurns;
		if (c <= 0) return 0;
		return Math.min(100, (data.approval.turns / c) * 100);
	}

	async function post(body: Record<string, unknown>): Promise<void> {
		busy = true;
		error = '';
		try {
			const res = await fetch(`/api/agents/runs/${encodeURIComponent(runId)}/approve-budget`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			const j = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			if (j.action === 'stopped') {
				successMessage = 'Run stopped. Redirecting…';
			} else {
				successMessage = `Resumed with ceiling $${j.ceilingUsd?.toFixed?.(2) ?? '?'} · ${j.ceilingTurns ?? '?'} turns. Redirecting…`;
			}
			// Brief pause so the operator sees confirmation, then return to the
			// budget list (the live source of truth for paused runs).
			setTimeout(() => goto('/orchestration/agents/budget'), 1200);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busy = false;
		}
	}

	function approveQuick(addUsd: number, addTurns: number): void {
		const body: Record<string, unknown> = {};
		if (addUsd > 0) body.addUsd = addUsd;
		if (addTurns > 0) body.addTurns = addTurns;
		post(body);
	}

	function approveCustom(): void {
		const body: Record<string, unknown> = {};
		if (customUsd && customUsd > 0) body.addUsd = customUsd;
		if (customTurns && customTurns > 0) body.addTurns = customTurns;
		if (!body.addUsd && !body.addTurns) {
			error = 'Enter a $ amount or a turn count above 0.';
			return;
		}
		post(body);
	}

	function stopRun(): void {
		const body: Record<string, unknown> = { stop: true };
		const r = stopReason.trim();
		if (r) body.reason = r;
		post(body);
	}

	function toggleShowAll(): void {
		const next = new URL(window.location.href);
		if (data.showAll) {
			next.searchParams.delete('all');
		} else {
			next.searchParams.set('all', '1');
		}
		goto(next.pathname + next.search);
	}

	function roleLabel(role: 'user' | 'assistant'): string {
		return role === 'user' ? '👤 you' : '🤖 agent';
	}
</script>

<svelte:head>
	<title>Approve · {data.run.agentId} · run {runId.slice(0, 8)}</title>
</svelte:head>

<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
	<div class="max-w-4xl mx-auto">
		<a
			href="/orchestration/agents/budget"
			class="inline-block text-xs text-hub-muted hover:text-hub-text mb-3"
		>
			← Budget queue
		</a>

		<header class="mb-6">
			<h1 class="text-lg font-semibold text-hub-text">
				{data.run.agentId}
				<span class="font-mono text-sm text-hub-muted">· {runId.slice(0, 8)}</span>
			</h1>
			<p class="text-xs text-hub-dim mt-1">
				{#if data.expired}
					This budget-approval window has expired or was already resolved elsewhere. The run
					is in status <span class="font-mono">{data.run.status}</span>; only the transcript
					is available below.
				{:else if data.approval}
					Paused at its budget ceiling. Approve more, stop and keep the partial result, or
					read the transcript and decide.
				{/if}
			</p>
		</header>

		{#if data.expired}
			<div
				class="mb-4 px-3 py-2 rounded bg-hub-warning/10 border border-hub-warning/30 text-xs text-hub-warning"
			>
				⚠️ Approval window expired. Action buttons are disabled — the run already
				terminated or was resolved via Telegram / another workbench tab.
			</div>
		{/if}

		{#if error}
			<div
				class="mb-4 px-3 py-2 rounded bg-hub-danger/10 border border-hub-danger/30 text-xs text-hub-danger"
			>
				{error}
			</div>
		{/if}

		{#if successMessage}
			<div
				class="mb-4 px-3 py-2 rounded bg-hub-cta/10 border border-hub-cta/30 text-xs text-hub-cta"
			>
				✅ {successMessage}
			</div>
		{/if}

		<!-- Spend + velocity card -->
		{#if data.approval}
			<section class="bg-hub-card rounded-xl border border-hub-border p-4 mb-4">
				{#if data.velocity}
					<p class="text-xs italic text-hub-muted mb-3">{data.velocity.text}</p>
				{/if}

				<div class="mb-1 flex items-center justify-between text-xs text-hub-muted">
					<span>Spend</span>
					<span class="font-mono">
						{fmtUsd(data.approval.spentUsd)} / {fmtUsd(data.approval.ceilingUsd)}
					</span>
				</div>
				<div class="h-1.5 rounded-full bg-hub-bg mb-3 overflow-hidden">
					<div class="h-full bg-hub-warning" style="width:{pctSpend()}%"></div>
				</div>

				<div class="mb-1 flex items-center justify-between text-xs text-hub-muted">
					<span>Turns</span>
					<span class="font-mono">{data.approval.turns} / {data.approval.ceilingTurns}</span>
				</div>
				<div class="h-1.5 rounded-full bg-hub-bg overflow-hidden">
					<div class="h-full bg-hub-info" style="width:{pctTurns()}%"></div>
				</div>

				{#if data.approval.subjectPath}
					<p class="text-xs text-hub-dim mt-3">
						Subject:
						<span class="font-mono">{data.approval.subjectPath}</span>
					</p>
				{/if}
			</section>
		{/if}

		<!-- Action buttons -->
		{#if !data.expired && data.approval}
			<section class="bg-hub-card rounded-xl border border-hub-border p-4 mb-4">
				<h2 class="text-sm font-semibold text-hub-text mb-3">Decision</h2>

				<div class="flex items-center gap-2 flex-wrap mb-3">
					<button
						onclick={() => approveQuick(2, 0)}
						disabled={busy}
						class="min-h-[44px] px-3 py-1.5 rounded text-xs font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
					>
						➕ $2
					</button>
					<button
						onclick={() => approveQuick(5, 0)}
						disabled={busy}
						class="min-h-[44px] px-3 py-1.5 rounded text-xs font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
					>
						➕ $5
					</button>
					<button
						onclick={() => approveQuick(0, 10)}
						disabled={busy}
						class="min-h-[44px] px-3 py-1.5 rounded text-xs font-medium bg-hub-info/15 text-hub-info hover:bg-hub-info/25 transition-colors cursor-pointer disabled:opacity-50"
					>
						➕ 10 turns
					</button>
					<button
						onclick={() => (showCustom = !showCustom)}
						disabled={busy}
						class="min-h-[44px] px-3 py-1.5 rounded text-xs font-medium bg-hub-bg text-hub-muted hover:bg-hub-bg/70 hover:text-hub-text transition-colors cursor-pointer disabled:opacity-50"
					>
						{showCustom ? '✕ Cancel custom' : '✎ Custom…'}
					</button>
					<button
						onclick={() => (showStopForm = !showStopForm)}
						disabled={busy}
						class="min-h-[44px] px-3 py-1.5 rounded text-xs font-medium bg-hub-danger/15 text-hub-danger hover:bg-hub-danger/25 transition-colors cursor-pointer disabled:opacity-50"
					>
						{showStopForm ? '✕ Cancel stop' : '🛑 Stop with reason'}
					</button>
				</div>

				{#if showCustom}
					<div class="border-t border-hub-border pt-3 mt-3">
						<div class="flex items-end gap-3 flex-wrap">
							<label class="flex flex-col text-xs text-hub-muted">
								Add $
								<input
									type="number"
									min="0"
									max="50"
									step="0.5"
									bind:value={customUsd}
									class="mt-1 px-2 py-1 w-24 bg-hub-bg border border-hub-border rounded font-mono text-sm text-hub-text"
									placeholder="0"
								/>
							</label>
							<label class="flex flex-col text-xs text-hub-muted">
								Add turns
								<input
									type="number"
									min="0"
									max="200"
									step="1"
									bind:value={customTurns}
									class="mt-1 px-2 py-1 w-24 bg-hub-bg border border-hub-border rounded font-mono text-sm text-hub-text"
									placeholder="0"
								/>
							</label>
							<button
								onclick={approveCustom}
								disabled={busy}
								class="min-h-[44px] px-3 py-1.5 rounded text-xs font-medium bg-hub-cta text-hub-bg hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
							>
								Approve
							</button>
						</div>
						<p class="text-[11px] text-hub-dim mt-2">Per-call cap: $50, 200 turns.</p>
					</div>
				{/if}

				{#if showStopForm}
					<div class="border-t border-hub-border pt-3 mt-3">
						<label class="flex flex-col text-xs text-hub-muted">
							Why are you stopping? (optional, recorded on the run)
							<textarea
								bind:value={stopReason}
								rows="3"
								maxlength="500"
								class="mt-1 px-2 py-1 bg-hub-bg border border-hub-border rounded text-sm text-hub-text"
								placeholder="e.g. looped on the same edit; manual investigation needed"
							></textarea>
						</label>
						<div class="mt-3">
							<button
								onclick={stopRun}
								disabled={busy}
								class="min-h-[44px] px-3 py-1.5 rounded text-xs font-medium bg-hub-danger text-hub-bg hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
							>
								🛑 Confirm stop
							</button>
						</div>
					</div>
				{/if}
			</section>
		{/if}

		<!-- Transcript -->
		<section class="bg-hub-card rounded-xl border border-hub-border p-4">
			<div class="flex items-center justify-between mb-3">
				<h2 class="text-sm font-semibold text-hub-text">
					Transcript
					{#if data.totalTurns > 0}
						<span class="text-xs text-hub-muted font-normal ml-2">
							{data.showAll
								? `${data.totalTurns} turns`
								: `last ${data.turns.length} of ${data.totalTurns} turns`}
						</span>
					{/if}
				</h2>
				{#if data.totalTurns > data.turns.length || data.showAll}
					<button
						onclick={toggleShowAll}
						class="text-xs px-2 py-1 rounded bg-hub-bg text-hub-muted hover:text-hub-text hover:bg-hub-bg/70 transition-colors cursor-pointer"
					>
						{data.showAll ? 'Show recent only' : 'Show all'}
					</button>
				{/if}
			</div>

			{#if data.turns.length === 0}
				<p class="text-xs text-hub-muted italic">
					No transcript available — the JSONL was not found or could not be parsed.
				</p>
			{:else}
				<div class="space-y-3">
					{#each data.turns as turn, i (i)}
						<div class="border-l-2 border-hub-border pl-3">
							<div class="flex items-center gap-2 mb-1">
								<span class="text-xs font-semibold text-hub-text">{roleLabel(turn.role)}</span>
								{#if turn.timestamp}
									<span class="text-[11px] text-hub-dim font-mono">{turn.timestamp}</span>
								{/if}
							</div>
							<pre
								class="text-xs text-hub-muted whitespace-pre-wrap font-mono leading-relaxed">{turn.text}</pre>
						</div>
					{/each}
				</div>
			{/if}
		</section>

		<footer class="text-xs text-hub-dim mt-6">
			Actions POST to <span class="font-mono">/api/agents/runs/{runId.slice(0, 8)}…/approve-budget</span>
			(same-origin only).
			{#if !data.publicUrlConfigured}
				· Telegram deep-link button is hidden because <span class="font-mono">SOUL_HUB_PUBLIC_URL</span>
				is not configured.
			{/if}
		</footer>
	</div>
</div>
