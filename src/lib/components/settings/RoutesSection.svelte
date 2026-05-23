<script lang="ts">
	import { onMount } from 'svelte';

	interface RouteRow {
		name: string;
		description?: string;
		default: string;
		failover: string[];
		timeoutMs: number;
		retries: number;
		onError: string[];
	}

	interface CircuitRow {
		ref: string;
		state: 'closed' | 'open' | 'half-open';
		failureCount: number;
		openedAt?: number;
		nextRetryAt?: number;
	}

	let routes = $state<RouteRow[]>([]);
	let circuit = $state<CircuitRow[]>([]);
	let loading = $state(true);
	let testing = $state<Record<string, boolean>>({});
	let testResults = $state<
		Record<
			string,
			{
				ok: boolean;
				status: string;
				latencyMs: number;
				answeredBy?: string;
				text?: string;
				error?: string;
			}
		>
	>({});

	async function load() {
		loading = true;
		try {
			const res = await fetch('/api/routes/list');
			if (res.ok) {
				const data = await res.json();
				routes = data.routes ?? [];
				circuit = data.circuit ?? [];
			}
		} catch {
			/* silent — section renders empty */
		} finally {
			loading = false;
		}
	}

	function circuitFor(ref: string): CircuitRow | undefined {
		return circuit.find((c) => c.ref === ref);
	}

	async function runTest(name: string) {
		testing = { ...testing, [name]: true };
		testResults = { ...testResults, [name]: undefined as never };
		try {
			const res = await fetch('/api/routes/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name }),
			});
			const data = await res.json();
			testResults = { ...testResults, [name]: data };
		} catch (err) {
			testResults = {
				...testResults,
				[name]: {
					ok: false,
					status: 'network',
					latencyMs: 0,
					error: (err as Error).message,
				},
			};
		} finally {
			testing = { ...testing, [name]: false };
			// Refresh circuit-breaker snapshot — a failed test may have parked
			// a provider that we want to surface.
			void load();
		}
	}

	function badgeClass(status: string, ok: boolean): string {
		if (ok) return 'border-hub-cta text-hub-cta';
		if (status === 'unconfigured') return 'border-hub-warning text-hub-warning';
		if (status === 'unauthorized') return 'border-hub-danger text-hub-danger';
		return 'border-hub-danger text-hub-danger';
	}

	onMount(load);
</script>

<section class="mb-6">
	<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Routes</h2>
			<button
				onclick={load}
				class="text-[10px] text-hub-dim hover:text-hub-muted transition-colors cursor-pointer"
			>
				Refresh
			</button>
		</div>

		{#if loading}
			<div class="text-sm text-hub-dim">Loading routes…</div>
		{:else if routes.length === 0}
			<div class="text-sm text-hub-dim">
				No routes configured. Add them under <code class="text-hub-muted">routes</code> in
				<code class="text-hub-muted">~/.soul-hub/settings.json</code>.
			</div>
		{:else}
			<div class="space-y-3">
				{#each routes as r (r.name)}
					{@const result = testResults[r.name]}
					{@const isBusy = testing[r.name]}
					{@const primaryBreaker = circuitFor(r.default)}
					<div class="border border-hub-border rounded-md p-3 bg-hub-bg">
						<div class="flex items-center justify-between gap-3 mb-2">
							<div class="flex items-center gap-2 min-w-0">
								<code class="text-sm font-mono text-hub-text truncate">{r.name}</code>
								{#if r.description}
									<span class="text-[11px] text-hub-dim truncate">— {r.description}</span>
								{/if}
							</div>
							<button
								onclick={() => runTest(r.name)}
								disabled={isBusy}
								class="px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors cursor-pointer
									{result
										? badgeClass(result.status, result.ok)
										: 'border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta'}"
							>
								{#if isBusy}
									<span class="inline-flex items-center gap-1.5">
										<svg class="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											<path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
										</svg>
										Testing…
									</span>
								{:else if result?.ok}
									pong · {result.latencyMs}ms
								{:else if result && !result.ok}
									{result.status}
								{:else}
									Test
								{/if}
							</button>
						</div>

						<div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
							<div class="flex items-center gap-2">
								<span class="text-hub-dim">primary</span>
								<code class="font-mono text-hub-text truncate">{r.default}</code>
								{#if primaryBreaker && primaryBreaker.state !== 'closed'}
									<span class="text-hub-warning text-[10px]">[{primaryBreaker.state}]</span>
								{/if}
							</div>
							<div class="flex items-center gap-2">
								<span class="text-hub-dim">timeout</span>
								<span class="text-hub-text">{r.timeoutMs}ms</span>
								<span class="text-hub-dim">retries</span>
								<span class="text-hub-text">{r.retries}</span>
							</div>
							{#if r.failover.length > 0}
								<div class="flex items-start gap-2 sm:col-span-2">
									<span class="text-hub-dim mt-0.5">failover</span>
									<div class="flex flex-wrap gap-1">
										{#each r.failover as ref (ref)}
											{@const breaker = circuitFor(ref)}
											<code class="px-1.5 py-0.5 rounded bg-hub-card font-mono text-hub-text">
												{ref}{#if breaker && breaker.state !== 'closed'}
													<span class="text-hub-warning ml-1">[{breaker.state}]</span>
												{/if}
											</code>
										{/each}
									</div>
								</div>
							{/if}
						</div>

						{#if result}
							<div class="mt-2 text-[11px] {result.ok ? 'text-hub-muted' : 'text-hub-danger'}">
								{#if result.ok}
									answered by <code class="text-hub-cta">{result.answeredBy}</code>
									{#if result.text}
										· <span class="italic">"{result.text}"</span>
									{/if}
								{:else}
									{result.error ?? 'failed'}
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</section>
