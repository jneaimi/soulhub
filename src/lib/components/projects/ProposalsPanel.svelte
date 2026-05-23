<script lang="ts">
	/**
	 * project-phases ADR-005 S3 — AI proposals review panel.
	 *
	 *  Sits on `/projects/[slug]`. Lists AI-drafted edit proposals from
	 *  `projects/<slug>/proposals/`. Operator reviews them and decides
	 *  to apply (paste into the target ADR), edit, or reject. v1 surfaces
	 *  the proposals + provides quick links to the proposal note and the
	 *  target ADR — the apply / reject actions happen via the AdrDrawer
	 *  on the target ADR, kept out of v1 to avoid scope creep.
	 *
	 *  Panel ONLY renders when there is at least one proposal of any
	 *  status. Silent otherwise — the project page already has plenty
	 *  of zero-state surface.
	 */
	import { onMount } from 'svelte';

	interface Proposal {
		path: string;
		filename: string;
		target_adr: string;
		target_adr_slug: string;
		proposed_section: string;
		title: string;
		rationale_summary: string;
		status: string;
		created: string;
		source_agent: string;
	}
	interface ProposalsResponse {
		open: Proposal[];
		applied: Proposal[];
		rejected: Proposal[];
		counts: { open: number; applied: number; rejected: number; total: number };
	}

	const { slug }: { slug: string } = $props();

	let data = $state<ProposalsResponse | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let showHistory = $state(false);
	let expanded = $state<Set<string>>(new Set());

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch(`/api/vault/projects/${encodeURIComponent(slug)}/proposals`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = (await res.json()) as ProposalsResponse;
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function toggle(path: string) {
		const next = new Set(expanded);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		expanded = next;
	}

	function vaultLink(path: string): string {
		return `/vault/${path.replace(/\.md$/, '')}`;
	}

	function adrLink(targetAdrSlug: string): string {
		if (!targetAdrSlug) return '#';
		return `/projects/${slug}#${targetAdrSlug}`;
	}
</script>

{#if loading}
	<!-- silent during load -->
{:else if loadError}
	<section class="mb-6">
		<div class="border border-hub-error/30 rounded-lg bg-hub-error/5 p-3 text-xs text-hub-error">
			Proposals load failed: {loadError}
		</div>
	</section>
{:else if data && data.counts.total > 0}
	<section class="mb-6">
		<div class="mb-3 flex items-center justify-between">
			<h2 class="text-sm font-semibold text-hub-info">
				AI proposals ({data.counts.open} open
				{#if data.counts.applied + data.counts.rejected > 0}
					· {data.counts.applied + data.counts.rejected} historical
				{/if})
			</h2>
			{#if data.counts.applied + data.counts.rejected > 0}
				<button
					class="text-xs text-hub-info hover:text-hub-text transition-colors cursor-pointer"
					onclick={() => (showHistory = !showHistory)}
				>
					{showHistory ? 'Hide history' : 'Show history'}
				</button>
			{/if}
		</div>

		<div class="space-y-3">
			{#each data.open as p (p.path)}
				<div class="border border-hub-info/25 rounded-lg bg-hub-info/5 p-4">
					<div class="flex items-start justify-between gap-3 mb-2">
						<button
							class="flex items-center gap-2 text-left flex-1 min-w-0 hover:text-hub-text transition-colors"
							onclick={() => toggle(p.path)}
						>
							<span class="text-hub-muted">{expanded.has(p.path) ? '▾' : '▸'}</span>
							<span class="font-medium text-hub-text truncate">{p.title}</span>
						</button>
						<div class="flex items-center gap-2 flex-shrink-0 text-xs">
							<span class="text-hub-muted">{p.created}</span>
							<span class="rounded bg-hub-info/15 px-2 py-0.5 text-hub-info">
								{p.proposed_section}
							</span>
						</div>
					</div>

					<div class="text-xs text-hub-muted ml-6">
						Target: <a
							href={adrLink(p.target_adr_slug)}
							class="text-hub-info hover:text-hub-text transition-colors"
						>
							{p.target_adr_slug || p.target_adr}
						</a>
						· by <span class="text-hub-text">{p.source_agent}</span>
					</div>

					{#if expanded.has(p.path)}
						<div class="ml-6 mt-3 space-y-2">
							{#if p.rationale_summary}
								<div>
									<div class="text-[11px] uppercase tracking-wide text-hub-muted mb-1">
										Rationale
									</div>
									<div class="text-xs text-hub-text whitespace-pre-wrap">
										{p.rationale_summary}
									</div>
								</div>
							{/if}
							<div class="flex gap-3 pt-1 text-xs">
								<a
									href={vaultLink(p.path)}
									class="text-hub-info hover:text-hub-text transition-colors"
								>
									Open proposal note →
								</a>
								<a
									href={adrLink(p.target_adr_slug)}
									class="text-hub-info hover:text-hub-text transition-colors"
								>
									Open target ADR →
								</a>
							</div>
							<div class="text-[11px] text-hub-muted italic pt-1">
								Apply / reject via the AdrDrawer once you've reviewed the proposed text.
							</div>
						</div>
					{/if}
				</div>
			{/each}

			{#if showHistory}
				{#each [...data.applied, ...data.rejected] as p (p.path)}
					<div
						class="border border-hub-muted/20 rounded-lg bg-hub-bg-elev/30 p-3 text-xs opacity-70"
					>
						<div class="flex items-center justify-between gap-2">
							<a
								href={vaultLink(p.path)}
								class="font-medium text-hub-text hover:text-hub-info transition-colors truncate"
							>
								{p.title}
							</a>
							<div class="flex items-center gap-2 flex-shrink-0">
								<span class="text-hub-muted">{p.created}</span>
								<span
									class="rounded px-2 py-0.5 {p.status === 'applied'
										? 'bg-hub-success/15 text-hub-success'
										: 'bg-hub-muted/15 text-hub-muted'}"
								>
									{p.status}
								</span>
							</div>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</section>
{/if}
