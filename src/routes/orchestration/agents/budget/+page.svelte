<script lang="ts">
	/** ADR-007 — budget-approval web surface. Lists ADR-006 paused runs (agents
	 *  that hit their hard ceiling and paused with the session preserved) and
	 *  lets the operator grant more budget or stop — the SAME engine the Telegram
	 *  buttons drive, just a second front-door. Polls every 30s to stay live. */

	import { onMount } from 'svelte';
	import type { PageData } from './$types';

	type Approval = PageData['approvals'][number];

	let { data }: { data: PageData } = $props();

	let approvals = $state<Approval[]>(data.approvals);
	let error = $state(data.error);
	let loading = $state(false);
	/** epoch ms of the last successful fetch — TTL counts down from here. */
	let fetchedAt = $state(Date.now());
	/** ticks every 30s so the rendered TTL re-derives without a re-fetch. */
	let nowTick = $state(Date.now());
	/** runId currently armed for Stop (click-again-to-confirm). */
	let armedStop = $state<string | null>(null);
	/** per-run in-flight action guard. */
	let busy = $state<Record<string, boolean>>({});

	async function refresh() {
		loading = true;
		try {
			const res = await fetch('/api/agents/budget-approvals');
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			const j = await res.json();
			approvals = (j.approvals ?? []) as Approval[];
			fetchedAt = Date.now();
			nowTick = Date.now();
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to refresh';
		} finally {
			loading = false;
		}
	}

	async function act(runId: string, action: 'bump_usd' | 'bump_turns' | 'stop', amount?: number) {
		busy = { ...busy, [runId]: true };
		try {
			const res = await fetch(`/api/agents/budget-approvals/${encodeURIComponent(runId)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, amount }),
			});
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			armedStop = null;
			await refresh();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Action failed';
		} finally {
			busy = { ...busy, [runId]: false };
		}
	}

	function clickStop(runId: string) {
		if (armedStop === runId) {
			act(runId, 'stop');
		} else {
			armedStop = runId;
		}
	}

	onMount(() => {
		const poll = setInterval(refresh, 30_000);
		const tick = setInterval(() => (nowTick = Date.now()), 30_000);
		return () => {
			clearInterval(poll);
			clearInterval(tick);
		};
	});

	function remainingMs(a: Approval): number {
		return Math.max(0, a.ttlMs - (nowTick - fetchedAt));
	}

	function fmtTtl(ms: number): string {
		if (ms <= 0) return 'expired';
		const totalMin = Math.floor(ms / 60_000);
		const h = Math.floor(totalMin / 60);
		const m = totalMin % 60;
		if (h > 0) return `expires in ${h}h ${m}m`;
		return `expires in ${m}m`;
	}

	function pct(a: Approval): number {
		if (!a.ceilingUsd || a.ceilingUsd <= 0) return 0;
		return Math.min(100, (a.spentUsd / a.ceilingUsd) * 100);
	}

	function fmtUsd(n: number): string {
		return `$${n.toFixed(2)}`;
	}
</script>

<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
	<div class="max-w-6xl mx-auto">
		<header class="flex items-center justify-between mb-6 gap-4">
			<div>
				<h1 class="text-lg font-semibold text-hub-text">Budget</h1>
				<p class="text-xs text-hub-dim mt-0.5">
					Agents that paused at their budget ceiling, awaiting a decision. Grant more to
					resume, or stop and keep the partial result. Same engine as the Telegram buttons.
				</p>
			</div>
			<button
				onclick={refresh}
				disabled={loading}
				class="px-3 py-1.5 rounded text-xs font-medium bg-hub-card text-hub-text hover:bg-hub-cta hover:text-hub-bg transition-colors cursor-pointer disabled:opacity-50"
			>
				{loading ? '…' : 'Refresh'}
			</button>
		</header>

		{#if error}
			<div
				class="mb-4 px-3 py-2 rounded bg-hub-danger/10 border border-hub-danger/30 text-xs text-hub-danger"
			>
				{error}
			</div>
		{/if}

		{#if approvals.length === 0}
			<div class="p-12 text-center text-hub-muted text-sm">
				No runs are waiting on a budget decision.
			</div>
		{:else}
			<div class="space-y-3">
				{#each approvals as a (a.runId)}
					<!-- TODO: swap to <BudgetMeter> once extracted -->
					<div class="bg-hub-card rounded-xl border border-hub-border p-4">
						<div class="flex items-start justify-between gap-3 mb-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="text-sm font-semibold text-hub-text truncate">{a.agentId}</span>
									<span
										class="px-2 py-0.5 rounded-full text-[11px] bg-hub-info/15 text-hub-info whitespace-nowrap"
									>
										Paused — awaiting budget
									</span>
								</div>
								<p class="text-xs text-hub-dim mt-1">
									{#if a.reason === 'max_turns'}
										Hit its turn ceiling.
									{:else if a.reason === 'max_usd'}
										Hit its spend ceiling.
									{:else}
										Paused at budget ceiling.
									{/if}
									· {a.turns} turns · <span class="font-mono">{a.runId}</span>
								</p>
							</div>
							<span class="text-xs text-hub-muted whitespace-nowrap">{fmtTtl(remainingMs(a))}</span>
						</div>

						<div class="mb-1 flex items-center justify-between text-xs text-hub-muted">
							<span>Spend</span>
							<span class="font-mono">
								{fmtUsd(a.spentUsd)} / {a.ceilingUsd != null ? fmtUsd(a.ceilingUsd) : '—'}
							</span>
						</div>
						<div class="h-1.5 rounded-full bg-hub-bg mb-4 overflow-hidden">
							<div class="h-full bg-hub-warning" style="width:{pct(a)}%"></div>
						</div>

						{#if a.actionable}
							<div class="flex items-center gap-2 flex-wrap">
								<button
									onclick={() => act(a.runId, 'bump_usd', 2)}
									disabled={busy[a.runId]}
									class="min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded text-xs font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
								>
									➕ $2
								</button>
								<button
									onclick={() => act(a.runId, 'bump_usd', 5)}
									disabled={busy[a.runId]}
									class="min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded text-xs font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
								>
									➕ $5
								</button>
								<button
									onclick={() => act(a.runId, 'bump_turns', 10)}
									disabled={busy[a.runId]}
									class="min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded text-xs font-medium bg-hub-info/15 text-hub-info hover:bg-hub-info/25 transition-colors cursor-pointer disabled:opacity-50"
								>
									➕ 10 turns
								</button>
								<button
									onclick={() => clickStop(a.runId)}
									disabled={busy[a.runId]}
									class="min-h-[44px] sm:min-h-0 px-3 py-1.5 rounded text-xs font-medium bg-hub-danger/15 text-hub-danger hover:bg-hub-danger/25 transition-colors cursor-pointer disabled:opacity-50"
								>
									{armedStop === a.runId ? 'Click again to confirm' : '🛑 Stop'}
								</button>
							</div>
						{:else}
							<p class="text-xs text-hub-muted italic">
								Approval window expired — no action available.
							</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
