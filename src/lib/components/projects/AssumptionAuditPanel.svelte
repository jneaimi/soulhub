<script lang="ts">
	/**
	 * project-phases ADR-008 S4 — Assumption-rate audit panel.
	 *
	 *  Sits below the falsifier alerts on `/projects/[slug]`. Renders
	 *  high + medium-score audits whose `linked_projects` array contains
	 *  the current project slug. Operator can:
	 *
	 *    - Expand an audit row to see Layer A signals + sample claims +
	 *      Layer B LLM claims (if graded) + LLM rationale
	 *    - Dismiss as false positive — POSTs to /dismiss endpoint,
	 *      which writes dismissed_at + reason. Drives F4 measurement.
	 *
	 *  Empty state is informative: explains the 6h cron cadence + that
	 *  audits only appear here when the original session touched
	 *  ~/vault/projects/<this slug>/ paths.
	 *
	 *  Panel ONLY renders when there is signal — either active audits
	 *  OR a dismissed-but-recoverable history. Silent on empty corpus.
	 */
	import { onMount } from 'svelte';

	interface ScorerSignals {
		hedge: number;
		claim_no_verify: number;
		post_hoc_corrections: number;
	}
	interface SampleClaim {
		text: string;
		turn_index: number;
		kind: 'hedge' | 'claim_no_verify' | 'post_hoc_correction';
	}
	interface LlmClaim {
		text: string;
		classification: 'verified' | 'inferred' | 'assumed';
	}
	interface AuditRow {
		id: number;
		session_id: string;
		transcript_path: string;
		audited_at: number;
		transcript_mtime: number;
		score: number;
		deterministic_score: number;
		llm_score: number | null;
		signals: ScorerSignals;
		sample_claims: SampleClaim[];
		llm_claims: LlmClaim[] | null;
		llm_cost_usd: number | null;
		llm_model: string | null;
		linked_projects: string[];
		dismissed_at: number | null;
		dismissed_reason: string | null;
	}
	interface AuditResponse {
		audits: AuditRow[];
		counts: { high_score: number; medium_score: number; low_score: number };
	}

	const {
		slug,
		descendantSlugs = [],
	}: {
		slug: string;
		/** projects-graph ADR-004 — when the parent project has descendants,
		 *  pass them in to widen the audit query (OR-match across slug +
		 *  descendants). Header explicitly labels the rolled-up mode. */
		descendantSlugs?: string[];
	} = $props();

	let data = $state<AuditResponse | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let expanded = $state<Set<number>>(new Set());
	let showDismissed = $state(false);
	let showLow = $state(false);
	let pendingDismiss = $state<number | null>(null);

	async function load() {
		loading = true;
		loadError = null;
		try {
			// projects-graph ADR-004 — when descendants are passed, switch
			// to the `?projects=` OR-match query so the panel surfaces
			// high-severity claims from the whole subtree. Otherwise, keep
			// the single-project filter (today's behaviour).
			let url: string;
			if (descendantSlugs.length > 0) {
				const allSlugs = [slug, ...descendantSlugs].map(encodeURIComponent).join(',');
				url = `/api/audit/assumption-rate?projects=${allSlugs}&include_dismissed=true&limit=100`;
			} else {
				url = `/api/audit/assumption-rate?project=${encodeURIComponent(slug)}&include_dismissed=true&limit=100`;
			}
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = (await res.json()) as AuditResponse;
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(load);

	// projects-graph ADR-004 — re-fetch when the parent's descendant set
	// changes (e.g. detail page swaps slug, or descendants become known
	// after the initial fetch). $effect already tracks reactive deps.
	let prevKey = $state(`${slug}|${descendantSlugs.join(',')}`);
	$effect(() => {
		const nextKey = `${slug}|${descendantSlugs.join(',')}`;
		if (nextKey !== prevKey) {
			prevKey = nextKey;
			load();
		}
	});

	function toggleExpand(id: number): void {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	async function dismiss(id: number): Promise<void> {
		const reason = window.prompt(
			'Dismiss this audit as a false positive?\n\nReason (optional, will be recorded):'
		);
		if (reason === null) return; // operator cancelled
		pendingDismiss = id;
		try {
			const res = await fetch(`/api/audit/assumption-rate/${id}/dismiss`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: reason || null })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await load();
		} catch (e) {
			alert(`Dismiss failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			pendingDismiss = null;
		}
	}

	function scoreClass(score: number): string {
		if (score > 70) return 'text-hub-danger';
		if (score >= 40) return 'text-hub-warning';
		return 'text-hub-dim';
	}

	function scoreLabel(score: number): string {
		if (score > 70) return 'high';
		if (score >= 40) return 'medium';
		return 'low';
	}

	function classificationClass(c: LlmClaim['classification']): string {
		if (c === 'assumed') return 'text-hub-danger';
		if (c === 'inferred') return 'text-hub-warning';
		return 'text-hub-dim';
	}

	function fmtDate(ms: number): string {
		const d = new Date(ms);
		return d.toISOString().slice(0, 16).replace('T', ' ');
	}

	// Filter + sort: high+medium by default, low gated, dismissed gated.
	const visible = $derived.by(() => {
		if (!data) return [] as AuditRow[];
		return data.audits
			.filter((a) => {
				if (!showDismissed && a.dismissed_at !== null) return false;
				if (!showLow && a.score < 40) return false;
				return true;
			})
			.sort((a, b) => b.score - a.score || b.audited_at - a.audited_at);
	});

	const dismissedCount = $derived(
		data ? data.audits.filter((a) => a.dismissed_at !== null).length : 0
	);
	const lowCount = $derived(
		data ? data.audits.filter((a) => a.score < 40 && a.dismissed_at === null).length : 0
	);
</script>

{#if loading}
	<div class="mb-6 p-3 rounded-lg border border-hub-card bg-hub-bg-secondary/40">
		<div class="text-xs text-hub-dim">Loading assumption-rate audits…</div>
	</div>
{:else if loadError}
	<div class="mb-6 p-3 rounded-lg border border-hub-danger/30 bg-hub-danger/5">
		<div class="text-xs text-hub-danger">
			Failed to load assumption audits: {loadError}
		</div>
	</div>
{:else if data}
	<div class="mb-6 p-3 rounded-lg border border-hub-info/30 bg-hub-info/5">
		<div class="flex items-center justify-between gap-3 mb-2 flex-wrap">
			<div class="text-xs font-medium text-hub-info">
				Assumption-rate audits{#if descendantSlugs.length > 0} <span class="text-[10px] uppercase tracking-wider text-hub-info">· rollup across {descendantSlugs.length} descendant{descendantSlugs.length === 1 ? '' : 's'}</span>{/if}
				<span class="text-hub-dim font-normal">
					({data.counts.high_score} high / {data.counts.medium_score} medium{lowCount > 0 ? ` / ${lowCount} low` : ''}{dismissedCount > 0 ? ` · ${dismissedCount} dismissed` : ''})
				</span>
			</div>
			<div class="flex items-center gap-2 text-[10px] text-hub-dim">
				{#if lowCount > 0}
					<label class="inline-flex items-center gap-1 cursor-pointer">
						<input type="checkbox" bind:checked={showLow} class="accent-hub-info" />
						<span>show low</span>
					</label>
				{/if}
				{#if dismissedCount > 0}
					<label class="inline-flex items-center gap-1 cursor-pointer">
						<input type="checkbox" bind:checked={showDismissed} class="accent-hub-info" />
						<span>show dismissed</span>
					</label>
				{/if}
				<span title="ADR-008 — assumption-rate audit (Layer A + Layer B Haiku 4.5 grader)">ⓘ</span>
			</div>
		</div>

		{#if visible.length === 0}
			<div class="text-[11px] text-hub-dim italic px-1 py-2">
				No high or medium-score audits for <span class="font-mono">{slug}</span> yet.
				{#if data.audits.length === 0}
					Scanner runs every 6h via the <span class="font-mono">audit-assumption-rate-scan</span> cron;
					audits only appear here when the original Claude Code session touched
					<span class="font-mono">~/vault/projects/{slug}/</span> paths.
				{/if}
			</div>
		{:else}
			<div class="space-y-1">
				{#each visible as a (a.id)}
					<div class="text-xs rounded transition-colors {a.dismissed_at ? 'opacity-60' : ''}">
						<div class="flex items-center justify-between gap-2 px-1 py-0.5 hover:bg-hub-card/60 rounded">
							<button
								onclick={() => toggleExpand(a.id)}
								class="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
								aria-expanded={expanded.has(a.id)}
							>
								<svg class="w-3 h-3 text-hub-dim transition-transform flex-shrink-0" style:transform={expanded.has(a.id) ? 'rotate(90deg)' : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<polyline points="9 18 15 12 9 6" />
								</svg>
								<span class="{scoreClass(a.score)} font-mono font-semibold w-8 flex-shrink-0">{a.score}</span>
								<span class="text-hub-dim w-12 flex-shrink-0">{scoreLabel(a.score)}</span>
								<span class="font-mono text-hub-text truncate">{a.session_id.slice(0, 8)}</span>
								{#if a.llm_score !== null}
									<span class="text-[10px] text-hub-info flex-shrink-0" title="composite = 0.6*llm + 0.4*det">det:{a.deterministic_score} · llm:{a.llm_score}</span>
								{:else}
									<span class="text-[10px] text-hub-dim flex-shrink-0" title="Layer A only — LLM grading skipped">det only</span>
								{/if}
								<span class="text-[10px] text-hub-dim ml-auto flex-shrink-0 hidden sm:inline">{fmtDate(a.audited_at)}</span>
							</button>
							{#if !a.dismissed_at}
								<button
									onclick={() => dismiss(a.id)}
									disabled={pendingDismiss === a.id}
									class="text-[10px] text-hub-dim hover:text-hub-danger px-1 cursor-pointer disabled:cursor-wait"
									title="Mark as false positive (writes dismissed_at + reason)"
								>
									{pendingDismiss === a.id ? '…' : '✕'}
								</button>
							{:else}
								<span class="text-[10px] text-hub-dim italic px-1" title={a.dismissed_reason ?? 'no reason given'}>dismissed</span>
							{/if}
						</div>

						{#if expanded.has(a.id)}
							<div class="ml-5 mt-1 mb-2 pl-3 border-l border-hub-card space-y-2 text-[11px]">
								<div class="text-hub-dim">
									<span class="font-mono text-hub-text">signals:</span>
									hedge={a.signals.hedge}, claim_no_verify={a.signals.claim_no_verify}, post_hoc={a.signals.post_hoc_corrections}
								</div>
								<div class="text-hub-dim font-mono break-all">{a.transcript_path}</div>

								{#if a.sample_claims.length > 0}
									<div>
										<div class="text-hub-dim mb-0.5">Layer A flagged ({a.sample_claims.length}):</div>
										<ul class="space-y-0.5">
											{#each a.sample_claims.slice(0, 6) as c}
												<li class="flex gap-2">
													<span class="text-[9px] uppercase w-16 flex-shrink-0 text-hub-dim">{c.kind.replace('_', ' ')}</span>
													<span class="text-hub-text">{c.text}</span>
												</li>
											{/each}
										</ul>
									</div>
								{/if}

								{#if a.llm_claims && a.llm_claims.length > 0}
									<div>
										<div class="text-hub-dim mb-0.5">
											Layer B (<span class="font-mono">{a.llm_model}</span>) — {a.llm_claims.length} claims:
										</div>
										<ul class="space-y-0.5">
											{#each a.llm_claims.slice(0, 8) as c}
												<li class="flex gap-2">
													<span class="text-[9px] uppercase w-14 flex-shrink-0 {classificationClass(c.classification)}">{c.classification}</span>
													<span class="text-hub-text">{c.text}</span>
												</li>
											{/each}
										</ul>
									</div>
								{/if}

								{#if a.dismissed_at && a.dismissed_reason}
									<div class="text-hub-dim italic">
										dismissed {fmtDate(a.dismissed_at)} — {a.dismissed_reason}
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
