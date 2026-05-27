<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import {
		computeActionableCounts,
		sumActionable,
		type ActionableCounts,
		type DispositionableKey,
	} from '$lib/vault-hygiene/tile-counts.js';

	// ─── Types (mirror the three source endpoints) ───
	type RunStatus = 'started' | 'success' | 'error' | 'overlap-skipped';

	interface HygieneTotals {
		indexed: number;
		orphans: number;
		unresolved: number;
		staleInbox: number;
		statusContradictions: number;
		governanceViolations: number;
		misplacedNotes: number;
		inboxDecisions: number;
		/** ADR-009 — code merged to main but ADR status still proposed/accepted. */
		adrImplementationDrift: number;
	}
	interface UnresolvedIssue {
		source: string;
		raw: string;
		suggestedFix: string;
	}
	interface OrphanIssue {
		path: string;
		title: string;
		suggestedFix: string;
	}
	interface StaleInboxIssue {
		path: string;
		title: string;
		ageDays: number;
		suggestedFix: string;
	}
	/** ADR-006 P1.2 — status-contradiction bucket (FM done + open tasks). */
	interface StatusContradictionIssue {
		path: string;
		status: string;
		openTaskCount: number;
		suggestedFix: string;
	}
	/** ADR-006 P1.2 — misplaced-note bucket (inbox note in wrong zone). */
	interface MisplacedNoteIssue {
		path: string;
		title: string;
		currentZone: string;
		suggestedZone: string;
		confidence: 'high' | 'low';
		reason: string;
		suggestedFix: string;
	}
	/** ADR-009 — implementation drift: code merged to main but ADR status stale. */
	interface AdrImplementationDriftIssue {
		path: string;
		project: string | null;
		slug: string;
		currentStatus: 'proposed' | 'accepted';
		mergeEvidence: string;
	}
	interface VaultHygiene {
		generatedAt: string;
		healthScore: number;
		totals: HygieneTotals;
		unresolved: UnresolvedIssue[];
		orphans: OrphanIssue[];
		staleInbox: StaleInboxIssue[];
		/** ADR-006 P1.2 — previously rendered only in tiles, now wired into the disposition list. */
		statusContradictions: StatusContradictionIssue[];
		misplacedNotes: MisplacedNoteIssue[];
		/** ADR-009 — code merged to main but ADR status still proposed/accepted. */
		adrImplementationDrift: AdrImplementationDriftIssue[];
	}

	interface AutomationHealth {
		taskId: string;
		label: string;
		category: string;
		purpose: string;
		lastFiredAt: string | null;
		lastStatus: RunStatus | null;
		recentStatuses: RunStatus[];
		anomalyRate: number;
		runsInWindow: number;
		falsifier: 'ok' | 'stale' | 'unknown';
		expectedMaxStaleHours: number;
	}
	interface AutomationsResponse {
		generatedAt: string;
		window: number;
		falsifierInstrumented: boolean;
		automations: AutomationHealth[];
	}

	interface SystemHealth {
		report: {
			timestamp: string;
			totalNotes: number;
			issues: unknown[];
			autoFixed: unknown[];
			notificationsCreated: number;
		} | null;
		activeNotifications: number;
	}

	interface ProjectRow {
		slug: string;
		bucket: string;
		meta?: Record<string, string>;
	}

	let vault = $state<VaultHygiene | null>(null);
	/** ADR-006 P2 — single source of truth: tiles and list both read from this. */
	const actionableCounts = $derived(vault ? computeActionableCounts(vault) : null);
	let automations = $state<AutomationsResponse | null>(null);
	let system = $state<SystemHealth | null>(null);
	let projectRows = $state<ProjectRow[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	async function load() {
		loading = true;
		loadError = null;
		try {
			const [vRes, aRes, sRes, pRes] = await Promise.all([
				fetch('/api/vault/hygiene'),
				fetch('/api/hygiene/automations'),
				fetch('/api/system/health'),
				fetch('/api/hygiene/project-items'),
			]);
			if (!vRes.ok) throw new Error(`vault hygiene: HTTP ${vRes.status}`);
			if (!aRes.ok) throw new Error(`automations: HTTP ${aRes.status}`);
			vault = (await vRes.json()) as VaultHygiene;
			automations = (await aRes.json()) as AutomationsResponse;
			// system health + project items are best-effort — a failure shouldn't blank the page
			system = sRes.ok ? ((await sRes.json()) as SystemHealth) : null;
			projectRows = pRes.ok ? (((await pRes.json()) as { rows: ProjectRow[] }).rows ?? []) : [];
		} catch (err) {
			loadError = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	// ─── Disposition (ADR-005 P2 / ADR-006 P1.2 / ADR-009) ───
	type RemAction = 'unlink' | 'archive-orphan' | 'drop-stale' | 'dismiss' | 'move' | 'reopen-status' | 'mark-shipped';
	let acting = $state<string | null>(null); // the row key currently in-flight
	let actError = $state<string | null>(null);

	// ─── ADR-007 P1: Agent fix state ───────────────────────────────────────────
	/** States per rowKey: dispatching → ready | error | approving */
	type AgentFixState = 'dispatching' | 'ready' | 'error' | 'approving';

	interface LocalProposal {
		bucket: string;
		target: string;
		summary: string;
		confidence: 'high' | 'medium' | 'low';
		edits: { op: string; [k: string]: unknown }[];
		alternatives: { op: string; [k: string]: unknown }[][];
	}

	let agentFixStates = $state<Record<string, AgentFixState>>({});
	let agentProposals = $state<Record<string, LocalProposal>>({});
	let agentErrors = $state<Record<string, string>>({});
	/** -1 = primary; ≥0 = alternatives[index] */
	let selectedAlts = $state<Record<string, number>>({});

	/** Active poll intervals keyed by rowKey. Cleared on onDestroy. */
	const pollIntervals: Record<string, ReturnType<typeof setInterval>> = {};

	function stopPolling(rowKey: string): void {
		if (pollIntervals[rowKey]) {
			clearInterval(pollIntervals[rowKey]);
			delete pollIntervals[rowKey];
		}
	}

	function startPolling(rowKey: string): void {
		stopPolling(rowKey);
		const interval = setInterval(async () => {
			try {
				const res = await fetch(`/api/hygiene/agent-fix/status?rowKey=${encodeURIComponent(rowKey)}`);
				const data = (await res.json()) as { status: string; proposal?: LocalProposal; error?: string };
				if (data.status === 'ready' && data.proposal) {
					stopPolling(rowKey);
					agentFixStates = { ...agentFixStates, [rowKey]: 'ready' };
					agentProposals = { ...agentProposals, [rowKey]: data.proposal };
					agentErrors = Object.fromEntries(Object.entries(agentErrors).filter(([k]) => k !== rowKey));
				} else if (data.status === 'error' || data.status === 'not-found') {
					stopPolling(rowKey);
					agentFixStates = { ...agentFixStates, [rowKey]: 'error' };
					agentErrors = { ...agentErrors, [rowKey]: data.error ?? 'Proposal not found or expired' };
				}
				// else: still dispatching — keep polling
			} catch {
				/* network hiccup — keep polling */
			}
		}, 2000);
		pollIntervals[rowKey] = interval;
	}

	async function dispatchAgentFix(rowKey: string, bucket: string, context: unknown): Promise<void> {
		stopPolling(rowKey);
		agentFixStates = { ...agentFixStates, [rowKey]: 'dispatching' };
		const { [rowKey]: _p, ...restP } = agentProposals;
		agentProposals = restP;
		const { [rowKey]: _e, ...restE } = agentErrors;
		agentErrors = restE;
		selectedAlts = Object.fromEntries(Object.entries(selectedAlts).filter(([k]) => k !== rowKey));
		actError = null;
		try {
			const res = await fetch('/api/hygiene/agent-fix', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rowKey, bucket, context }),
			});
			const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
			if (!res.ok || !result.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
			startPolling(rowKey);
		} catch (err) {
			agentFixStates = { ...agentFixStates, [rowKey]: 'error' };
			agentErrors = { ...agentErrors, [rowKey]: (err as Error).message };
		}
	}

	async function approveProposal(rowKey: string): Promise<void> {
		const alt = selectedAlts[rowKey] ?? -1;
		agentFixStates = { ...agentFixStates, [rowKey]: 'approving' };
		actError = null;
		try {
			const body: Record<string, unknown> = { rowKey };
			if (alt >= 0) body.alternativeIndex = alt;
			const res = await fetch('/api/hygiene/agent-approve', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
			if (res.status === 409) {
				// TOCTOU stale — clear state, refresh report
				const { [rowKey]: _s, ...restS } = agentFixStates;
				agentFixStates = restS;
				const { [rowKey]: _p, ...restP } = agentProposals;
				agentProposals = restP;
				actError = 'Stale — row was already fixed. Refreshing.';
				await load();
				return;
			}
			if (!res.ok || !result.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
			// Success — clear state + refresh
			const { [rowKey]: _s, ...restS } = agentFixStates;
			agentFixStates = restS;
			const { [rowKey]: _p2, ...restP2 } = agentProposals;
			agentProposals = restP2;
			await load();
		} catch (err) {
			agentFixStates = { ...agentFixStates, [rowKey]: 'error' };
			agentErrors = { ...agentErrors, [rowKey]: (err as Error).message };
		}
	}

	function rejectProposal(rowKey: string): void {
		stopPolling(rowKey);
		const { [rowKey]: _s, ...restS } = agentFixStates;
		agentFixStates = restS;
		const { [rowKey]: _p, ...restP } = agentProposals;
		agentProposals = restP;
		const { [rowKey]: _e, ...restE } = agentErrors;
		agentErrors = restE;
		selectedAlts = Object.fromEntries(Object.entries(selectedAlts).filter(([k]) => k !== rowKey));
	}

	function confidenceClass(c: string): string {
		if (c === 'high') return 'text-emerald-300 border-hub-cta/30 bg-hub-cta/10';
		if (c === 'medium') return 'text-amber-300 border-hub-warning/30 bg-hub-warning/10';
		return 'text-red-300 border-hub-danger/30 bg-hub-danger/10';
	}

	function describeOp(op: { op: string; [k: string]: unknown }): string {
		if (op.op === 'retarget-link') return `Retarget [[${op.raw as string}]] → [[${op.newTarget as string}]] in ${op.source as string}`;
		if (op.op === 'add-links') return `Add links to ${op.path as string}: ${(op.targets as string[]).map((t) => `[[${t}]]`).join(', ')}`;
		return JSON.stringify(op);
	}

	/** Pick the canonical "open" status for a Reopen action.
	 *  Project-pair files (projects/<slug>/index|project.md) flip to 'active';
	 *  everything else uses 'proposed' — the canonical open value for ADR notes
	 *  (ADR-006 edge case #7). Both are valid for dispatchStatusFlip: project
	 *  paths use setProjectStatus (accepts /^[a-z][a-z-]*$/), non-project paths
	 *  use setNoteStatus (validates against CANONICAL_STATUSES). */
	function reopenStatusFor(path: string): string {
		return /^projects\/[a-z][a-z0-9-]*\/(?:index|project)\.md$/.test(path)
			? 'active'
			: 'proposed';
	}

	async function remediate(
		rowKey: string,
		body: {
			action: RemAction;
			bucket?: string;
			source: string;
			raw?: string;
			targetZone?: string;
			status?: string;
		},
		confirmMsg?: string,
	) {
		if (confirmMsg && !confirm(confirmMsg)) return;
		acting = rowKey;
		actError = null;
		try {
			const res = await fetch('/api/hygiene/remediate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
			if (!res.ok || !result.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
			await load(); // refresh — the actioned item drops out of the report
		} catch (err) {
			actError = (err as Error).message;
		} finally {
			acting = null;
		}
	}

	// ─── Project-hygiene disposition (ADR-005 2b) ───
	interface ProjAction {
		label: string;
		action: string;
		danger?: boolean;
	}
	/** Bucket → available actions, mirroring the Telegram hyg-* keyboards. */
	function projectActionsFor(bucket: string): ProjAction[] {
		switch (bucket) {
			case 'no_status':
				return [{ label: 'Mark active', action: 'mark-active' }, { label: 'Archive', action: 'archive', danger: true }];
			case 'missing_index':
				return [{ label: 'Scaffold', action: 'scaffold' }, { label: 'Archive', action: 'archive', danger: true }];
			case 'dual_file_disagree':
				return [{ label: 'Use project.md', action: 'use-project' }, { label: 'Use index.md', action: 'use-index' }];
			case 'stale_active_14':
			case 'stale_active_30':
				return [{ label: 'Touch', action: 'touch' }, { label: 'Maintained', action: 'mark-maintained' }, { label: 'Archive', action: 'archive', danger: true }];
			case 'falsifier_due_soon':
				return [{ label: 'Snooze 14d', action: 'snooze-review' }, { label: 'Reviewed +90d', action: 'mark-reviewed' }];
			case 'naming_violation':
				return [];
			default:
				// archive_zone_mismatch, empty_stub, template_only_index
				return [{ label: 'Archive', action: 'archive', danger: true }, { label: 'Pause 30d', action: 'pause' }];
		}
	}

	async function projectRemediate(rowKey: string, action: string, slug: string, bucket: string, danger: boolean) {
		if (danger && !confirm(`${action} project "${slug}"? (git-revertible)`)) return;
		acting = rowKey;
		actError = null;
		try {
			const res = await fetch('/api/hygiene/project-remediate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, slug, bucket }),
			});
			const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
			if (!res.ok || !result.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
			await load();
		} catch (err) {
			actError = (err as Error).message;
		} finally {
			acting = null;
		}
	}

	onMount(() => {
		void load();
	});

	onDestroy(() => {
		// Clean up all active poll intervals on page teardown.
		for (const id of Object.values(pollIntervals)) clearInterval(id);
	});

	// ─── Formatting + status palette ───
	function fmtRelative(iso: string | null): string {
		if (!iso) return 'never';
		const ms = Date.now() - new Date(iso).getTime();
		if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
		return `${Math.floor(ms / 86_400_000)}d ago`;
	}

	const STATUS_DOT: Record<RunStatus, string> = {
		success: 'bg-hub-cta',
		error: 'bg-hub-danger',
		'overlap-skipped': 'bg-hub-warning',
		started: 'bg-hub-info',
	};
	const STATUS_PILL: Record<RunStatus, string> = {
		success: 'bg-hub-cta/15 text-emerald-300 border-hub-cta/30',
		error: 'bg-hub-danger/15 text-red-300 border-hub-danger/30',
		'overlap-skipped': 'bg-hub-warning/15 text-amber-300 border-hub-warning/30',
		started: 'bg-hub-info/15 text-blue-300 border-hub-info/30',
	};

	// ─── Tile grid definitions (ADR-006 P2 — tile honesty) ───────────────────────
	// 'dispositionable' → amber when count > 0; count = actionableCounts[key]
	//   (array .length, post-suppression, same source as the list — never vault.totals)
	// 'informational'   → neutral text; no amber; count = vault.totals[key]
	// 'inbox-link'      → neutral text; no amber; shows an "Open Inbox" deep-link
	type BucketKind = 'dispositionable' | 'informational' | 'inbox-link';
	const BUCKETS: { key: keyof HygieneTotals; label: string; kind: BucketKind; link?: string }[] = [
		{ key: 'governanceViolations', label: 'Governance', kind: 'informational' },
		{ key: 'unresolved', label: 'Broken links', kind: 'dispositionable' },
		{ key: 'statusContradictions', label: 'Status drift', kind: 'dispositionable' },
		{ key: 'adrImplementationDrift', label: 'Impl drift', kind: 'dispositionable' },
		{ key: 'staleInbox', label: 'Stale inbox', kind: 'dispositionable' },
		{ key: 'orphans', label: 'Orphans', kind: 'dispositionable' },
		{ key: 'misplacedNotes', label: 'Misplaced', kind: 'dispositionable' },
		{ key: 'inboxDecisions', label: 'Inbox decisions', kind: 'inbox-link', link: '/inbox' },
		{ key: 'indexed', label: 'Indexed notes', kind: 'informational' },
	];

	function scoreClass(score: number): string {
		if (score >= 85) return 'text-emerald-300';
		if (score >= 70) return 'text-amber-300';
		return 'text-red-300';
	}
</script>

<svelte:head>
	<title>Hygiene · Soul Hub</title>
</svelte:head>

<main class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
	<div class="max-w-6xl mx-auto w-full space-y-4">
		<!-- ─── Header ─── -->
		<header class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h1 class="text-lg font-semibold text-hub-text">Hygiene</h1>
				<p class="text-xs text-hub-muted mt-0.5 max-w-3xl">
					ADR-004 — the health system's own health. Vault drift, per-automation last-fired
					signal, and system self-heal status in one place. AI proposes, human disposes;
					inline disposition lands in Phase 2.
				</p>
			</div>
			<button
				class="text-xs px-3 py-1.5 rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta/40 transition-colors"
				onclick={() => load()}
				disabled={loading}
			>
				{loading ? 'Refreshing…' : 'Refresh'}
			</button>
		</header>

		{#if loadError}
			<div class="rounded border border-hub-danger/40 bg-hub-danger/10 text-red-300 text-sm px-3 py-2">
				{loadError}
			</div>
		{/if}

		<!-- ─── A. Vault hygiene ─── -->
		<section class="rounded-lg border border-hub-border bg-hub-surface/40 p-4">
			<div class="flex items-center justify-between mb-3">
				<h2 class="text-sm font-semibold text-hub-text">Vault hygiene</h2>
				{#if vault}
					<div class="flex items-baseline gap-1.5">
						<span class="text-xs text-hub-muted">health</span>
						<span class="text-xl font-semibold {scoreClass(vault.healthScore)}">{vault.healthScore}</span>
						<span class="text-xs text-hub-muted">/100</span>
					</div>
				{/if}
			</div>
			{#if vault}
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
					{#each BUCKETS as b (b.key)}
						{@const n = b.kind === 'dispositionable'
							? ((actionableCounts as ActionableCounts | null)?.[b.key as DispositionableKey] ?? 0)
							: vault.totals[b.key]}
						<div class="rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
							<div
								class="text-lg font-semibold {b.kind === 'dispositionable' && n > 0 ? 'text-amber-300' : 'text-hub-text'}"
							>
								{n}
							</div>
							<div class="text-[11px] text-hub-muted">{b.label}</div>
							{#if b.kind === 'inbox-link' && b.link}
								<a
									href={b.link}
									class="text-[10px] text-hub-info hover:underline mt-0.5 inline-block"
								>Open Inbox →</a>
							{/if}
						</div>
					{/each}
				</div>
			{:else if !loadError}
				<p class="text-xs text-hub-muted">Loading…</p>
			{/if}
		</section>

		<!-- ─── A2. Needs disposition (ADR-005 P2 / ADR-006 P1.2) ─── -->
		<!-- ADR-006 P2: total derives from the same actionableCounts the tiles use. -->
		{#if vault}
			{@const total = actionableCounts ? sumActionable(actionableCounts) : 0}
			<section class="rounded-lg border border-hub-border bg-hub-surface/40 p-4">
				<div class="flex items-center justify-between mb-3">
					<h2 class="text-sm font-semibold text-hub-text">Needs your call</h2>
					<span class="text-[11px] text-hub-muted">{total} item{total === 1 ? '' : 's'}</span>
				</div>
				{#if actError}
					<div class="rounded border border-hub-danger/40 bg-hub-danger/10 text-red-300 text-xs px-3 py-2 mb-2">
						{actError}
					</div>
				{/if}
				{#if total === 0}
					<p class="text-xs text-hub-muted">Nothing to dispose — the keeper has it clean.</p>
				{:else}
					<ul class="space-y-2">
						{#each vault.unresolved as u (u.source + u.raw)}
							{@const key = `unresolved:${u.source}:${u.raw}`}
							{@const agentState = agentFixStates[key]}
							{@const proposal = agentProposals[key]}
							<li class="rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2 space-y-2">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<div class="min-w-0">
										<div class="text-xs text-hub-text truncate">🔗 Broken link in <code class="text-hub-info">{u.source}</code></div>
										<div class="text-[11px] text-hub-muted truncate">→ <code>{u.raw}</code></div>
									</div>
									<div class="flex gap-1.5 shrink-0flex-wrap">
										<!-- Quick actions (ADR-006) -->
										<button class="text-[11px] px-2 py-1 rounded border border-hub-danger/30 text-red-300 hover:bg-hub-danger/10 disabled:opacity-40" disabled={acting === key || !!agentState} onclick={() => remediate(key, { action: 'unlink', bucket: 'unresolved', source: u.source, raw: u.raw }, `Remove the broken wikilink \`${u.raw}\` from ${u.source}? (git-revertible)`)}>
											{acting === key ? '…' : 'Unlink'}
										</button>
										<button class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40" disabled={acting === key || !!agentState} onclick={() => remediate(key, { action: 'dismiss', bucket: 'unresolved', source: u.source, raw: u.raw })}>
											Dismiss 30d
										</button>
										<!-- ADR-007: Agent fix affordance -->
										{#if !agentState}
											<button
												class="text-[11px] px-2 py-1 rounded border border-hub-info/30 text-blue-300 hover:bg-hub-info/10 disabled:opacity-40"
												disabled={acting === key}
												onclick={() => dispatchAgentFix(key, 'unresolved', { source: u.source, raw: u.raw, suggestedFix: u.suggestedFix })}
											>🤖 Agent fix</button>
										{:else if agentState === 'dispatching'}
											<span class="text-[11px] px-2 py-1 rounded border border-hub-info/30 text-blue-300 opacity-70 animate-pulse">🔍 Investigating…</span>
											<button class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text" onclick={() => rejectProposal(key)}>Cancel</button>
										{:else if agentState === 'error'}
											<span class="text-[11px] text-red-300" title={agentErrors[key]}>⚠ Agent failed</span>
											<button class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text" onclick={() => rejectProposal(key)}>Clear</button>
										{/if}
									</div>
								</div>
								<!-- Proposal card (ADR-007) -->
								{#if agentState === 'ready' && proposal}
									<div class="rounded border border-hub-info/30 bg-hub-info/5 px-3 py-2 space-y-2">
										<div class="flex items-start justify-between gap-2">
											<div class="text-[11px] text-hub-text">{proposal.summary}</div>
											<span class="text-[10px] px-1.5 py-0.5 rounded border {confidenceClass(proposal.confidence)} shrink-0">{proposal.confidence}</span>
										</div>
										<!-- Primary edits -->
										<div class="text-[11px] text-hub-muted">
											{#if (selectedAlts[key] ?? -1) < 0}
												{#each proposal.edits as edit}
													<div class="font-mono truncate">→ {describeOp(edit)}</div>
												{/each}
											{:else}
												{#each (proposal.alternatives[selectedAlts[key]] ?? []) as edit}
													<div class="font-mono truncate">→ {describeOp(edit)}</div>
												{/each}
											{/if}
										</div>
										<!-- Alternative picker -->
										{#if proposal.alternatives.length > 0}
											<div class="flex items-center gap-2 flex-wrap">
												<span class="text-[10px] text-hub-muted">Use:</span>
												<button
													class="text-[10px] px-1.5 py-0.5 rounded border {(selectedAlts[key] ?? -1) < 0 ? 'border-hub-cta/50 text-emerald-300' : 'border-hub-border text-hub-muted'}"
													onclick={() => { selectedAlts = { ...selectedAlts, [key]: -1 }; }}
												>Primary</button>
												{#each proposal.alternatives as _alt, i}
													<button
														class="text-[10px] px-1.5 py-0.5 rounded border {selectedAlts[key] === i ? 'border-hub-cta/50 text-emerald-300' : 'border-hub-border text-hub-muted'}"
														onclick={() => { selectedAlts = { ...selectedAlts, [key]: i }; }}
													>Alt {i + 1}</button>
												{/each}
											</div>
										{/if}
										<!-- Approve / Reject -->
										<div class="flex gap-2">
											<button
												class="text-[11px] px-2 py-1 rounded border border-hub-cta/40 text-emerald-300 hover:bg-hub-cta/10 disabled:opacity-40"
												disabled={agentFixStates[key] === 'approving'}
												onclick={() => approveProposal(key)}
											>{agentFixStates[key] === 'approving' ? '…' : '✓ Approve'}</button>
											<button
												class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40"
												disabled={agentFixStates[key] === 'approving'}
												onclick={() => rejectProposal(key)}
											>✗ Reject</button>
										</div>
									</div>
								{/if}
							</li>
						{/each}
						{#each vault.orphans as o (o.path)}
							{@const key = `orphan:${o.path}`}
							{@const agentState = agentFixStates[key]}
							{@const proposal = agentProposals[key]}
							<li class="rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2 space-y-2">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<div class="min-w-0">
										<div class="text-xs text-hub-text truncate">🪨 Orphan: <code class="text-hub-info">{o.path}</code></div>
										<div class="text-[11px] text-hub-muted truncate">{o.suggestedFix}</div>
									</div>
									<div class="flex gap-1.5 shrink-0 flex-wrap">
										<!-- Quick actions (ADR-006) -->
										<button class="text-[11px] px-2 py-1 rounded border border-hub-warning/30 text-amber-300 hover:bg-hub-warning/10 disabled:opacity-40" disabled={acting === key || !!agentState} onclick={() => remediate(key, { action: 'archive-orphan', bucket: 'orphan_note', source: o.path }, `Archive orphan note ${o.path}? (git-revertible)`)}>
											{acting === key ? '…' : 'Archive'}
										</button>
										<button class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40" disabled={acting === key || !!agentState} onclick={() => remediate(key, { action: 'dismiss', bucket: 'orphan_note', source: o.path })}>
											Dismiss 30d
										</button>
										<!-- ADR-007: Agent fix affordance -->
										{#if !agentState}
											<button
												class="text-[11px] px-2 py-1 rounded border border-hub-info/30 text-blue-300 hover:bg-hub-info/10 disabled:opacity-40"
												disabled={acting === key}
												onclick={() => dispatchAgentFix(key, 'orphan_note', { path: o.path, title: o.title, suggestedFix: o.suggestedFix })}
											>🤖 Agent fix</button>
										{:else if agentState === 'dispatching'}
											<span class="text-[11px] px-2 py-1 rounded border border-hub-info/30 text-blue-300 opacity-70 animate-pulse">🔍 Investigating…</span>
											<button class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text" onclick={() => rejectProposal(key)}>Cancel</button>
										{:else if agentState === 'error'}
											<span class="text-[11px] text-red-300" title={agentErrors[key]}>⚠ Agent failed</span>
											<button class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text" onclick={() => rejectProposal(key)}>Clear</button>
										{/if}
									</div>
								</div>
								<!-- Proposal card (ADR-007) -->
								{#if agentState === 'ready' && proposal}
									<div class="rounded border border-hub-info/30 bg-hub-info/5 px-3 py-2 space-y-2">
										<div class="flex items-start justify-between gap-2">
											<div class="text-[11px] text-hub-text">{proposal.summary}</div>
											<span class="text-[10px] px-1.5 py-0.5 rounded border {confidenceClass(proposal.confidence)} shrink-0">{proposal.confidence}</span>
										</div>
										<div class="text-[11px] text-hub-muted">
											{#if (selectedAlts[key] ?? -1) < 0}
												{#each proposal.edits as edit}
													<div class="font-mono truncate">→ {describeOp(edit)}</div>
												{/each}
											{:else}
												{#each (proposal.alternatives[selectedAlts[key]] ?? []) as edit}
													<div class="font-mono truncate">→ {describeOp(edit)}</div>
												{/each}
											{/if}
										</div>
										{#if proposal.alternatives.length > 0}
											<div class="flex items-center gap-2 flex-wrap">
												<span class="text-[10px] text-hub-muted">Use:</span>
												<button
													class="text-[10px] px-1.5 py-0.5 rounded border {(selectedAlts[key] ?? -1) < 0 ? 'border-hub-cta/50 text-emerald-300' : 'border-hub-border text-hub-muted'}"
													onclick={() => { selectedAlts = { ...selectedAlts, [key]: -1 }; }}
												>Primary</button>
												{#each proposal.alternatives as _alt, i}
													<button
														class="text-[10px] px-1.5 py-0.5 rounded border {selectedAlts[key] === i ? 'border-hub-cta/50 text-emerald-300' : 'border-hub-border text-hub-muted'}"
														onclick={() => { selectedAlts = { ...selectedAlts, [key]: i }; }}
													>Alt {i + 1}</button>
												{/each}
											</div>
										{/if}
										<div class="flex gap-2">
											<button
												class="text-[11px] px-2 py-1 rounded border border-hub-cta/40 text-emerald-300 hover:bg-hub-cta/10 disabled:opacity-40"
												disabled={agentFixStates[key] === 'approving'}
												onclick={() => approveProposal(key)}
											>{agentFixStates[key] === 'approving' ? '…' : '✓ Approve'}</button>
											<button
												class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40"
												disabled={agentFixStates[key] === 'approving'}
												onclick={() => rejectProposal(key)}
											>✗ Reject</button>
										</div>
									</div>
								{/if}
							</li>
						{/each}
						{#each vault.staleInbox as s (s.path)}
							{@const key = `stale:${s.path}`}
							<li class="flex flex-wrap items-center justify-between gap-2 rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
								<div class="min-w-0">
									<div class="text-xs text-hub-text truncate">📥 Stale inbox ({s.ageDays}d): <code class="text-hub-info">{s.path}</code></div>
									<div class="text-[11px] text-hub-muted truncate">{s.suggestedFix}</div>
								</div>
								<div class="flex gap-1.5 shrink-0">
									<button class="text-[11px] px-2 py-1 rounded border border-hub-danger/30 text-red-300 hover:bg-hub-danger/10 disabled:opacity-40" disabled={acting === key} onclick={() => remediate(key, { action: 'drop-stale', bucket: 'stale_inbox_item', source: s.path }, `Drop stale inbox item ${s.path}? (git-revertible)`)}>
										{acting === key ? '…' : 'Drop'}
									</button>
									<button class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40" disabled={acting === key} onclick={() => remediate(key, { action: 'dismiss', bucket: 'stale_inbox_item', source: s.path })}>
										Dismiss 30d
									</button>
								</div>
							</li>
						{/each}
						<!-- ADR-006 P1.2: Status-drift rows -->
						{#each (vault.statusContradictions ?? []) as sc (sc.path)}
							{@const key = `status-drift:${sc.path}`}
							<li class="flex flex-wrap items-center justify-between gap-2 rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
								<div class="min-w-0">
									<div class="text-xs text-hub-text truncate">&#9888;&#65039; Status drift: <code class="text-hub-info">{sc.path}</code></div>
									<div class="text-[11px] text-hub-muted truncate">status=<code>{sc.status}</code> with {sc.openTaskCount} open task{sc.openTaskCount === 1 ? '' : 's'}</div>
								</div>
								<div class="flex gap-1.5 shrink-0">
									<a
										href={`/vault?note=${encodeURIComponent(sc.path)}`}
										target="_blank"
										rel="noopener noreferrer"
										class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text"
									>Open &#8599;</a>
									<button
										class="text-[11px] px-2 py-1 rounded border border-hub-cta/30 text-emerald-300 hover:bg-hub-cta/10 disabled:opacity-40"
										disabled={acting === key}
										onclick={() => remediate(key, { action: 'reopen-status', source: sc.path, status: reopenStatusFor(sc.path) })}
									>
										{acting === key ? '...' : `Reopen → ${reopenStatusFor(sc.path)}`}
									</button>
									<button
										class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40"
										disabled={acting === key}
										onclick={() => remediate(key, { action: 'dismiss', bucket: 'status_contradiction', source: sc.path })}
									>
										Dismiss 30d
									</button>
								</div>
							</li>
						{/each}
						<!-- ADR-009: Implementation drift rows -->
						{#each (vault.adrImplementationDrift ?? []) as d (d.path)}
							{@const key = `impl-drift:${d.path}`}
							<li class="flex flex-wrap items-center justify-between gap-2 rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
								<div class="min-w-0">
									<div class="text-xs text-hub-text truncate">&#128256; Impl drift: <code class="text-hub-info">{d.path}</code></div>
									<div class="text-[11px] text-hub-muted truncate">status=<code>{d.currentStatus}</code> — merged: <code>{d.mergeEvidence}</code></div>
								</div>
								<div class="flex gap-1.5 shrink-0">
									<a
										href={`/vault?note=${encodeURIComponent(d.path)}`}
										target="_blank"
										rel="noopener noreferrer"
										class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text"
									>Open &#8599;</a>
									<button
										class="text-[11px] px-2 py-1 rounded border border-hub-cta/30 text-emerald-300 hover:bg-hub-cta/10 disabled:opacity-40"
										disabled={acting === key}
										onclick={() => remediate(
											key,
											{ action: 'mark-shipped', source: d.path },
											`Mark "${d.slug}" as shipped?\n\nEvidence: ${d.mergeEvidence}\n\n(Multi-phase ADRs: use "Not yet" if more code is pending. git-revertible.)`,
										)}
									>
										{acting === key ? '...' : 'Mark shipped'}
									</button>
									<button
										class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40"
										disabled={acting === key}
										onclick={() => remediate(key, { action: 'dismiss', bucket: 'adr_implementation_drift', source: d.path })}
									>
										Not yet (30d)
									</button>
								</div>
							</li>
						{/each}
						<!-- ADR-006 P1.2: Misplaced-note rows -->
						{#each (vault.misplacedNotes ?? []) as m (m.path)}
							{@const key = `misplaced:${m.path}`}
							<li class="flex flex-wrap items-center justify-between gap-2 rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
								<div class="min-w-0">
									<div class="text-xs text-hub-text truncate">&#128194; Misplaced: <code class="text-hub-info">{m.path}</code></div>
									<div class="text-[11px] text-hub-muted truncate">→ {m.suggestedZone} ({m.confidence} confidence) — {m.reason}</div>
								</div>
								<div class="flex gap-1.5 shrink-0">
									<button
										class="text-[11px] px-2 py-1 rounded border border-hub-warning/30 text-amber-300 hover:bg-hub-warning/10 disabled:opacity-40"
										disabled={acting === key}
										onclick={() => remediate(
											key,
											{ action: 'move', source: m.path, targetZone: m.suggestedZone },
											`Move "${m.path}" → ${m.suggestedZone}/?

High confidence ≠ correct — confirm the destination is right. (git-revertible)`,
										)}
									>
										{acting === key ? '...' : `Move → ${m.suggestedZone}`}
									</button>
									<button
										class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40"
										disabled={acting === key}
										onclick={() => remediate(key, { action: 'dismiss', bucket: 'misplaced_note', source: m.path })}
									>
										Dismiss 30d
									</button>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}

		<!-- ─── A3. Project anomalies (ADR-005 2b) ─── -->
		{#if projectRows.length > 0}
			<section class="rounded-lg border border-hub-border bg-hub-surface/40 p-4">
				<div class="flex items-center justify-between mb-3">
					<h2 class="text-sm font-semibold text-hub-text">Project anomalies</h2>
					<span class="text-[11px] text-hub-muted">{projectRows.length} item{projectRows.length === 1 ? '' : 's'}</span>
				</div>
				<ul class="space-y-2">
					{#each projectRows as p (p.slug + p.bucket)}
						{@const key = `proj:${p.slug}:${p.bucket}`}
						<li class="flex flex-wrap items-center justify-between gap-2 rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
							<div class="min-w-0">
								<div class="text-xs text-hub-text truncate">📁 <code class="text-hub-info">{p.slug}</code></div>
								<div class="text-[11px] text-hub-muted truncate">{p.bucket.replace(/_/g, ' ')}</div>
							</div>
							<div class="flex flex-wrap gap-1.5 shrink-0">
								{#each projectActionsFor(p.bucket) as a (a.action)}
									<button
										class="text-[11px] px-2 py-1 rounded border disabled:opacity-40 {a.danger ? 'border-hub-danger/30 text-red-300 hover:bg-hub-danger/10' : 'border-hub-cta/30 text-emerald-300 hover:bg-hub-cta/10'}"
										disabled={acting === key}
										onclick={() => projectRemediate(key, a.action, p.slug, p.bucket, a.danger ?? false)}
									>
										{acting === key ? '…' : a.label}
									</button>
								{/each}
								<button
									class="text-[11px] px-2 py-1 rounded border border-hub-border text-hub-muted hover:text-hub-text disabled:opacity-40"
									disabled={acting === key}
									onclick={() => projectRemediate(key, 'dismiss', p.slug, p.bucket, false)}
								>
									Dismiss 30d
								</button>
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<!-- ─── B. Automation health ─── -->
		<section class="rounded-lg border border-hub-border bg-hub-surface/40 p-4">
			<div class="flex items-center justify-between mb-3">
				<h2 class="text-sm font-semibold text-hub-text">Automation health</h2>
				<span class="text-[11px] text-hub-muted">
					falsifier = ran within its expected window?
				</span>
			</div>
			{#if automations}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-[11px] uppercase tracking-wide text-hub-muted border-b border-hub-border/60">
								<th class="py-2 pr-3 font-medium">Automation</th>
								<th class="py-2 px-3 font-medium">Last fired</th>
								<th class="py-2 px-3 font-medium">Status</th>
								<th class="py-2 px-3 font-medium">Recent</th>
								<th class="py-2 px-3 font-medium">Anomaly</th>
								<th class="py-2 px-3 font-medium">Falsifier</th>
							</tr>
						</thead>
						<tbody>
							{#each automations.automations as a (a.taskId)}
								<tr class="border-b border-hub-border/30 align-top">
									<td class="py-2 pr-3">
										<div class="text-hub-text">{a.label}</div>
										<div class="text-[11px] text-hub-muted">{a.purpose}</div>
									</td>
									<td class="py-2 px-3 whitespace-nowrap text-hub-muted">{fmtRelative(a.lastFiredAt)}</td>
									<td class="py-2 px-3">
										{#if a.lastStatus}
											<span class="inline-block text-[11px] px-2 py-0.5 rounded-full border {STATUS_PILL[a.lastStatus]}">
												{a.lastStatus}
											</span>
										{:else}
											<span class="text-[11px] text-hub-muted">no runs</span>
										{/if}
									</td>
									<td class="py-2 px-3">
										<div class="flex gap-1 items-center">
											{#each a.recentStatuses as s, i (i)}
												<span class="inline-block w-2 h-2 rounded-full {STATUS_DOT[s]}" title={s}></span>
											{/each}
											{#if a.recentStatuses.length === 0}
												<span class="text-[11px] text-hub-muted">—</span>
											{/if}
										</div>
									</td>
									<td class="py-2 px-3 whitespace-nowrap {a.anomalyRate > 0 ? 'text-amber-300' : 'text-hub-muted'}">
										{Math.round(a.anomalyRate * 100)}%
									</td>
									<td class="py-2 px-3 whitespace-nowrap">
										{#if a.falsifier === 'ok'}
											<span class="text-emerald-300" title="Ran within {a.expectedMaxStaleHours}h window">✓ live</span>
										{:else if a.falsifier === 'stale'}
											<span class="text-red-300" title="No run in {a.expectedMaxStaleHours}h — silently stopped">⚠ stale</span>
										{:else}
											<span class="text-hub-muted" title="Never ran">—</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else if !loadError}
				<p class="text-xs text-hub-muted">Loading…</p>
			{/if}
		</section>

		<!-- ─── C. System health ─── -->
		<section class="rounded-lg border border-hub-border bg-hub-surface/40 p-4">
			<h2 class="text-sm font-semibold text-hub-text mb-3">System self-heal</h2>
			{#if system?.report}
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
					<div class="rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
						<div class="text-lg font-semibold text-hub-text">{system.report.issues.length}</div>
						<div class="text-[11px] text-hub-muted">Issues found</div>
					</div>
					<div class="rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
						<div class="text-lg font-semibold text-hub-text">{system.report.autoFixed.length}</div>
						<div class="text-[11px] text-hub-muted">Auto-fixed</div>
					</div>
					<div class="rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
						<div class="text-lg font-semibold {system.activeNotifications > 0 ? 'text-amber-300' : 'text-hub-text'}">
							{system.activeNotifications}
						</div>
						<div class="text-[11px] text-hub-muted">Active notifications</div>
					</div>
					<div class="rounded border border-hub-border/60 bg-hub-bg/30 px-3 py-2">
						<div class="text-sm font-medium text-hub-muted pt-1">{fmtRelative(system.report.timestamp)}</div>
						<div class="text-[11px] text-hub-muted">Last check</div>
					</div>
				</div>
			{:else if !loadError}
				<p class="text-xs text-hub-muted">System health not initialized.</p>
			{/if}
		</section>
	</div>
</main>
