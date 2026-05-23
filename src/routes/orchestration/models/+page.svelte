<script lang="ts">
	/** ADR-036 Phase 1 — read-only consolidated view of every LLM-selection
	 *  surface. Four sections (BRANCHES, ROUTES, AGENT DEFAULTS, CODE-MANAGED).
	 *  Data fetched from /api/orchestration/models. Refresh on demand. */

	import { onMount } from 'svelte';

	interface BranchRow {
		name: string;
		model: string;
		assignments: number;
		costUsd14d: number;
		turns14d: number;
		overBudget: boolean;
	}

	interface RouteRow {
		name: string;
		default: string;
		failover: string[];
		timeoutMs: number;
		retries: number;
		onError: string[];
		description: string | null;
	}

	interface AgentRow {
		name: string;
		model: string;
		path: string;
	}

	interface CodeManagedRow {
		label: string;
		value: string;
		path: string;
		note: string;
	}

	interface Payload {
		branches: {
			rows: BranchRow[];
			override: string | null;
			costCapUsd: number;
			windowDays: number;
			sourcePath: string;
		};
		routes: { rows: RouteRow[]; sourcePath: string };
		agents: { rows: AgentRow[]; sourceDir: string; totalScanned: number };
		codeManaged: { rows: CodeManagedRow[] };
		generatedAt: string;
	}

	let data = $state<Payload | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			const res = await fetch('/api/orchestration/models');
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error ?? `HTTP ${res.status}`);
			}
			data = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function fmtUsd(n: number): string {
		return `$${n.toFixed(2)}`;
	}

	function fmtMs(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
		return `${n}ms`;
	}
</script>

<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
	<div class="max-w-5xl mx-auto">
		<header class="flex items-center justify-between mb-6 gap-4">
			<div>
				<h1 class="text-lg font-semibold text-hub-text">Models</h1>
				<p class="text-xs text-hub-dim mt-0.5">
					Every LLM-selection decision in one place. Read-only (Phase 1). See
					<a
						href="/vault?path=projects%2Fsoul-hub-whatsapp%2Fadr-036-orchestration-model-registry.md"
						class="text-hub-info hover:text-hub-text transition-colors">ADR-036</a
					>.
				</p>
			</div>
			<button
				onclick={load}
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

		{#if !data && loading}
			<div class="flex items-center justify-center py-20">
				<p class="text-hub-muted text-sm">Loading…</p>
			</div>
		{:else if data}
			<!-- BRANCHES -->
			<section class="mb-8">
				<div class="flex items-baseline justify-between mb-2 gap-4">
					<h2 class="text-sm font-semibold text-hub-text">
						Orchestrator-v2 branches
						<span class="text-[11px] text-hub-dim ml-2">agent-loop brain rotation</span>
					</h2>
					<p class="text-[11px] text-hub-dim font-mono">{data.branches.sourcePath}</p>
				</div>

				{#if data.branches.override}
					<div
						class="mb-2 px-3 py-2 rounded bg-hub-warning/10 border border-hub-warning/30 text-xs text-hub-warning"
					>
						Env override active:
						<span class="font-mono">ORCHESTRATOR_V2_BRANCH_OVERRIDE={data.branches.override}</span>
						— all keys forced to this branch.
					</div>
				{/if}

				<div class="rounded-md border border-hub-border bg-hub-card/40 overflow-x-auto">
					<table class="w-full text-xs">
						<thead class="bg-hub-card text-hub-dim text-[11px] uppercase tracking-wider">
							<tr>
								<th class="text-left px-3 py-2 font-medium">Name</th>
								<th class="text-left px-3 py-2 font-medium">Model</th>
								<th class="text-right px-3 py-2 font-medium">Assigned</th>
								<th class="text-right px-3 py-2 font-medium">Turns {data.branches.windowDays}d</th>
								<th class="text-right px-3 py-2 font-medium">Cost {data.branches.windowDays}d</th>
								<th class="text-left px-3 py-2 font-medium">Status</th>
							</tr>
						</thead>
						<tbody>
							{#each data.branches.rows as row, i}
								<tr
									class="border-t border-hub-border/40"
									class:bg-hub-cta={i === 0 && !data.branches.override}
									class:bg-opacity-5={i === 0 && !data.branches.override}
								>
									<td class="px-3 py-2 font-medium text-hub-text">
										{row.name}
										{#if i === 0 && !data.branches.override}
											<span class="ml-1 text-[10px] text-hub-cta">primary</span>
										{/if}
										{#if data.branches.override === row.name}
											<span class="ml-1 text-[10px] text-hub-warning">override</span>
										{/if}
									</td>
									<td class="px-3 py-2 font-mono text-hub-dim">{row.model}</td>
									<td class="px-3 py-2 text-right text-hub-text tabular-nums">{row.assignments}</td>
									<td class="px-3 py-2 text-right text-hub-text tabular-nums">{row.turns14d}</td>
									<td class="px-3 py-2 text-right text-hub-text tabular-nums">
										{fmtUsd(row.costUsd14d)}
										<span class="text-[10px] text-hub-dim">/ {fmtUsd(data.branches.costCapUsd)}</span>
									</td>
									<td class="px-3 py-2">
										{#if row.overBudget}
											<span class="text-hub-danger text-[11px]">over budget</span>
										{:else}
											<span class="text-hub-dim text-[11px]">ok</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<!-- ROUTES -->
			<section class="mb-8">
				<div class="flex items-baseline justify-between mb-2 gap-4">
					<h2 class="text-sm font-semibold text-hub-text">
						Routes
						<span class="text-[11px] text-hub-dim ml-2">intent → model + failover</span>
					</h2>
					<p class="text-[11px] text-hub-dim font-mono">{data.routes.sourcePath}</p>
				</div>

				{#if data.routes.rows.length === 0}
					<p class="text-xs text-hub-dim italic px-3 py-3 rounded-md border border-hub-border/60 bg-hub-card/40">
						No routes configured. Defaults from schema apply at dispatch time.
					</p>
				{:else}
					<div class="rounded-md border border-hub-border bg-hub-card/40 overflow-x-auto">
						<table class="w-full text-xs">
							<thead class="bg-hub-card text-hub-dim text-[11px] uppercase tracking-wider">
								<tr>
									<th class="text-left px-3 py-2 font-medium">Route</th>
									<th class="text-left px-3 py-2 font-medium">Default</th>
									<th class="text-left px-3 py-2 font-medium">Failover</th>
									<th class="text-right px-3 py-2 font-medium">Timeout</th>
									<th class="text-right px-3 py-2 font-medium">Retries</th>
								</tr>
							</thead>
							<tbody>
								{#each data.routes.rows as row}
									<tr class="border-t border-hub-border/40">
										<td class="px-3 py-2 font-medium text-hub-text" title={row.description ?? ''}>
											{row.name}
										</td>
										<td class="px-3 py-2 font-mono text-hub-dim">{row.default || '—'}</td>
										<td class="px-3 py-2 font-mono text-hub-dim">
											{row.failover.length ? row.failover.join(', ') : '—'}
										</td>
										<td class="px-3 py-2 text-right text-hub-text tabular-nums">
											{row.timeoutMs ? fmtMs(row.timeoutMs) : '—'}
										</td>
										<td class="px-3 py-2 text-right text-hub-text tabular-nums">{row.retries}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>

			<!-- AGENT DEFAULTS -->
			<section class="mb-8">
				<div class="flex items-baseline justify-between mb-2 gap-4">
					<h2 class="text-sm font-semibold text-hub-text">
						Agent defaults
						<span class="text-[11px] text-hub-dim ml-2">
							{data.agents.rows.length} agents with model — {data.agents.totalScanned} scanned
						</span>
					</h2>
					<p class="text-[11px] text-hub-dim font-mono">{data.agents.sourceDir}</p>
				</div>

				<div class="rounded-md border border-hub-border bg-hub-card/40 overflow-x-auto">
					<table class="w-full text-xs">
						<thead class="bg-hub-card text-hub-dim text-[11px] uppercase tracking-wider">
							<tr>
								<th class="text-left px-3 py-2 font-medium">Agent</th>
								<th class="text-left px-3 py-2 font-medium">Model</th>
								<th class="text-left px-3 py-2 font-medium">Source</th>
							</tr>
						</thead>
						<tbody>
							{#each data.agents.rows as row}
								<tr class="border-t border-hub-border/40">
									<td class="px-3 py-2 font-medium text-hub-text">{row.name}</td>
									<td class="px-3 py-2 font-mono text-hub-dim">{row.model}</td>
									<td class="px-3 py-2 font-mono text-[11px] text-hub-dim">{row.path}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<!-- CODE-MANAGED DEFAULTS -->
			<section class="mb-8">
				<div class="flex items-baseline justify-between mb-2 gap-4">
					<h2 class="text-sm font-semibold text-hub-text">
						Code-managed defaults
						<span class="text-[11px] text-hub-dim ml-2">edit via source — no UI write surface yet</span>
					</h2>
				</div>

				<div class="rounded-md border border-hub-border bg-hub-card/40 overflow-x-auto">
					<table class="w-full text-xs">
						<thead class="bg-hub-card text-hub-dim text-[11px] uppercase tracking-wider">
							<tr>
								<th class="text-left px-3 py-2 font-medium">Surface</th>
								<th class="text-left px-3 py-2 font-medium">Model</th>
								<th class="text-left px-3 py-2 font-medium">Source</th>
							</tr>
						</thead>
						<tbody>
							{#each data.codeManaged.rows as row}
								<tr class="border-t border-hub-border/40">
									<td class="px-3 py-2">
										<div class="font-medium text-hub-text">{row.label}</div>
										<div class="text-[11px] text-hub-dim">{row.note}</div>
									</td>
									<td class="px-3 py-2 font-mono text-hub-dim">{row.value}</td>
									<td class="px-3 py-2 font-mono text-[11px] text-hub-dim">{row.path}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>

			<footer class="text-[11px] text-hub-dim mt-6">
				Generated {new Date(data.generatedAt).toLocaleTimeString()}
			</footer>
		{/if}
	</div>
</div>
