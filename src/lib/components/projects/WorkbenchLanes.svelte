<script lang="ts">
	/** projects-graph ADR-018 (Handoff Workbench) S1 — renders the five
	 *  readiness lanes returned by /api/vault/projects/[slug]/worklist. Each
	 *  row opens the artifact in the AdrDrawer (via onSelect). Read surface;
	 *  the dispatch loop (S2) populates `in_flight` and adds row actions.
	 *  ADR-026 P2b — `waiting_on_you` items with `awaitingOperator` show an
	 *  inline answer box that resumes the paused agent run.
	 *  ADR-013 — `noArtifact` cards gain an inline Re-dispatch button that
	 *  routes to the same agent resolveAgentForWork picks for the drawer. */
	import { onMount } from 'svelte';
	import { resolveAgentForWork } from '$lib/projects/dispatch-routing.js';
	type Owner = 'ai' | 'human' | 'unassigned';
	type AwaitingOperator = {
		question: string;
		sessionId: string;
		branch: string;
		agentId: string;
	};
	type ReviewHandoff = {
		branch: string;
		summary: string;
		followUps: string[];
		gatesGreen: boolean;
		costUsd: number;
	};
	type NoArtifact = {
		summary: string;
		costUsd: number;
		numTurns: number;
	};
	type Item = {
		id: string;
		slug: string;
		title: string;
		type: string;
		status: string;
		assignee: string | null;
		owner: Owner;
		work_type: string | null;
		blockedBy: string[];
		blockedByUnmet: string[];
		/** projects-graph ADR-026 — live run telemetry (in_flight items only). */
		progress?: { costUsd: number; numTurns: number; startedAt: number };
		/** ADR-026 P2b — paused run awaiting operator answer. */
		awaitingOperator?: AwaitingOperator;
		/** ADR-026 D3 — finished, un-merged coding run awaiting review. */
		reviewHandoff?: ReviewHandoff;
		/** ADR-012 P1 — success-like run that left no reviewable artifact. */
		noArtifact?: NoArtifact;
	};
	type Lane = 'ready_for_ai' | 'waiting_on_you' | 'ready_for_you' | 'waiting_on_ai' | 'in_flight';

	// `lanes` arrives as untyped JSON from /worklist; cast each lane's rows to
	// Item[] at the render boundary (below) rather than claim the shape upstream.
	let {
		lanes,
		loading = false,
		error = '',
		onSelect,
	}: {
		lanes: Record<string, unknown[]> | null;
		loading?: boolean;
		error?: string;
		onSelect: (path: string) => void;
	} = $props();

	// Ordered lane metadata. `accent` is a left-border + dot color token.
	const LANES: { key: Lane; label: string; hint: string; accent: string }[] = [
		{ key: 'ready_for_ai', label: 'Ready for AI', hint: 'AI-owned, unblocked', accent: 'bg-hub-cta' },
		{ key: 'waiting_on_you', label: 'Waiting on you', hint: 'AI blocked by an upstream', accent: 'bg-hub-warning' },
		{ key: 'ready_for_you', label: 'Ready for you', hint: 'yours, unblocked', accent: 'bg-hub-info' },
		{ key: 'waiting_on_ai', label: 'Waiting on AI', hint: 'blocked by an upstream', accent: 'bg-hub-dim' },
		{ key: 'in_flight', label: 'In flight', hint: 'agent run active', accent: 'bg-hub-muted' },
	];

	function statusClass(status: string): string {
		switch (status) {
			case 'proposed': return 'bg-hub-warning/15 text-hub-warning';
			case 'accepted': return 'bg-hub-info/15 text-hub-info';
			default: return 'bg-hub-dim/15 text-hub-dim';
		}
	}
	function ownerLabel(it: Item): string {
		if (it.owner === 'ai') return `AI · ${it.assignee}`;
		if (it.owner === 'human') return it.assignee ?? 'you';
		return 'unassigned';
	}

	// ADR-026 P2b — per-item answer-box state. Keyed by item.id so cards
	// never share answer text or sending flags even if rendered in the same lane.
	let answerText = $state<Record<string, string>>({});
	let sending = $state<Record<string, boolean>>({});
	let sendError = $state<Record<string, string>>({});

	// ADR-013 — live roster for resolveAgentForWork. Loaded once on mount,
	// mirrors AdrDrawer.loadAgentIds() so routing stays consistent.
	let agentIds = $state<Set<string>>(new Set());
	// ADR-014 D1 — parallel repo map; populated alongside agentIds.
	let agentRepos = $state<Map<string, string | undefined>>(new Map());
	// ADR-013 — per-item re-dispatch state for the noArtifact card.
	let redispatching = $state<Record<string, boolean>>({});
	let redispatchError = $state<Record<string, string>>({});

	async function sendAnswer(it: Item) {
		if (!it.awaitingOperator) return;
		const answer = (answerText[it.id] ?? '').trim();
		if (!answer) return;
		sending = { ...sending, [it.id]: true };
		sendError = { ...sendError, [it.id]: '' };
		try {
			const res = await fetch(`/api/agents/${encodeURIComponent(it.awaitingOperator.agentId)}/test?mode=production`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					task: answer,
					subject: it.id,
					resume: it.awaitingOperator.sessionId,
					branch: it.awaitingOperator.branch,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
			}
			// Drain the NDJSON stream (fire-and-forget; the 4s poll picks up in_flight).
			await res.body?.cancel();
			// Optimistic: clear answer so the card reads "Resuming…" until the poll fires.
			answerText = { ...answerText, [it.id]: '' };
		} catch (e) {
			sendError = { ...sendError, [it.id]: e instanceof Error ? e.message : 'Failed to send' };
			sending = { ...sending, [it.id]: false };
		}
		// Leave sending=true: the 4s poller will replace this card with in_flight.
	}

	// ADR-013 — load the live roster ONCE so resolveAgentForWork can validate
	// assignee-as-agent and the work_type→agent map. Mirrors AdrDrawer.loadAgentIds().
	// ADR-014 D1 — also captures repo so routing refuses repo-less coding agents.
	async function loadAgentIds() {
		if (agentIds.size > 0) return;
		try {
			const res = await fetch('/api/agents');
			if (!res.ok) return;
			const data = await res.json();
			const list = Array.isArray(data) ? data : (data.agents ?? data.results ?? []);
			const newIds = new Set<string>();
			const newRepos = new Map<string, string | undefined>();
			for (const a of list as Array<{ id?: string; repo?: string }>) {
				const id = (a.id ?? '').toLowerCase();
				if (!id) continue;
				newIds.add(id);
				newRepos.set(
					id,
					typeof a.repo === 'string' && a.repo.trim() ? a.repo.trim() : undefined,
				);
			}
			agentIds = newIds;
			agentRepos = newRepos;
		} catch {
			/* roster unavailable — Re-dispatch button will surface an error on click */
		}
	}

	/** ADR-013 — Re-dispatch a completed-no-artifact item to its resolved agent.
	 *
	 *  Resolves the target via resolveAgentForWork (same function the drawer uses)
	 *  so the lane button and the drawer route to the same executor. Fetches the
	 *  note content first so the task body mirrors AdrDrawer.dispatchToAI().
	 *  Posts to /api/agents/<agentId>/test?mode=production (same endpoint as
	 *  sendAnswer, no new endpoint). On success leaves redispatching[it.id]=true
	 *  so the card reads "Re-dispatching…" until the 4s poller replaces it with
	 *  the in_flight card — identical to sendAnswer's fire-and-forget pattern. */
	async function redispatch(it: Item) {
		// ADR-014 D1 — pass agentRepos so repo-less coding candidates are refused.
		const agentId = resolveAgentForWork(it.work_type, it.assignee, agentIds, null, agentRepos);
		if (!agentId) {
			redispatchError = {
				...redispatchError,
				[it.id]: 'No agent resolved — set work_type or assignee on this artifact first.',
			};
			return;
		}
		redispatching = { ...redispatching, [it.id]: true };
		redispatchError = { ...redispatchError, [it.id]: '' };
		try {
			// Best-effort: fetch the note so the task includes the full ADR body,
			// mirroring AdrDrawer.dispatchToAI(). Degrades gracefully on failure.
			let task = `Work on this decision: "${it.title}".\n\nProduce the deliverable and return it as your final output.`;
			try {
				const nr = await fetch(`/api/vault/notes/${it.id}`);
				if (nr.ok) {
					const nd = await nr.json() as { meta?: { type?: unknown }; content?: string };
					const noteType = typeof nd.meta?.type === 'string' ? nd.meta.type : 'decision';
					task = `Work on this ${noteType}: "${it.title}".\n\n${nd.content ?? ''}\n\nProduce the deliverable and return it as your final output.`;
				}
			} catch {
				/* task proceeds with minimal context */
			}

			const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/test?mode=production`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// ADR-014 D2 — pass work_type so the server guard can refuse repo-less
				// coding dispatches (belt-and-suspenders behind D1).
				body: JSON.stringify({ task: task.slice(0, 4000), subject: it.id, work_type: it.work_type }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
			}
			// Drain the NDJSON stream (fire-and-forget; the 4s poll picks up in_flight).
			await res.body?.cancel();
			// Leave redispatching=true: the 4s poller will replace this card with in_flight.
		} catch (e) {
			redispatchError = {
				...redispatchError,
				[it.id]: e instanceof Error ? e.message : 'Failed to re-dispatch',
			};
			redispatching = { ...redispatching, [it.id]: false };
		}
	}

	onMount(() => {
		loadAgentIds();
	});
</script>

{#if loading}
	<p class="text-sm text-hub-dim py-6 text-center">Loading worklist…</p>
{:else if error}
	<p class="text-sm text-hub-danger py-6 text-center">{error}</p>
{:else if lanes}
	<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
		{#each LANES as lane (lane.key)}
			{@const items = (lanes[lane.key] ?? []) as Item[]}
			<div class="rounded-lg border border-hub-border bg-hub-card/30 overflow-hidden">
				<div class="flex items-center gap-2 px-3 py-2 border-b border-hub-border/60">
					<span class="w-1.5 h-1.5 rounded-full {lane.accent}"></span>
					<span class="text-xs font-semibold text-hub-text">{lane.label}</span>
					<span class="text-[10px] text-hub-dim ml-auto">{items.length}</span>
				</div>
				{#if items.length === 0}
					<p class="px-3 py-3 text-[11px] text-hub-dim italic">{lane.hint}</p>
				{:else}
					<div class="p-1.5 space-y-0.5">
						{#each items as it (it.id)}
							<!-- ADR-026 D3: review hand-off card — finished branch awaiting operator merge. -->
							{#if it.reviewHandoff}
								<div class="px-2 py-1.5 rounded border border-hub-info/30 bg-hub-info/5">
									<button
										type="button"
										class="w-full text-left group mb-1"
										onclick={() => onSelect(it.id)}
									>
										<div class="flex items-center gap-2">
											<span class="text-[12px] text-hub-text group-hover:text-hub-cta transition-colors truncate flex-1">{it.title}</span>
											<span class="shrink-0 px-1 py-0.5 rounded text-[9px] font-medium {statusClass(it.status)}">{it.status}</span>
										</div>
										<div class="flex items-center gap-2 mt-0.5 text-[10px] text-hub-dim">
											<span class="font-mono uppercase">{it.type}</span>
											<span>· {ownerLabel(it)}</span>
										</div>
									</button>
									<!-- Review-ready label + gate badge -->
									<div class="flex items-center gap-2 mt-1">
										<span class="text-[10px] text-hub-info font-medium">🔵 Review ready</span>
										{#if it.reviewHandoff.gatesGreen}
											<span class="px-1 py-0.5 rounded text-[9px] font-medium bg-hub-success/15 text-hub-success">gates ✓</span>
										{:else}
											<span class="px-1 py-0.5 rounded text-[9px] font-medium bg-hub-danger/15 text-hub-danger">gates ✗</span>
										{/if}
										<span class="text-[9px] text-hub-dim">${it.reviewHandoff.costUsd.toFixed(2)}</span>
									</div>
									<!-- Branch (mono, truncated) -->
									<p class="mt-0.5 text-[10px] font-mono text-hub-dim truncate" title={it.reviewHandoff.branch}>{it.reviewHandoff.branch}</p>
									<!-- Summary (clamped) -->
									{#if it.reviewHandoff.summary}
										<p class="mt-0.5 text-[11px] text-hub-text leading-snug line-clamp-3">{it.reviewHandoff.summary}</p>
									{/if}
									<!-- Next steps / follow-ups -->
									{#if it.reviewHandoff.followUps.length > 0}
										<div class="mt-1">
											<p class="text-[10px] font-semibold text-hub-dim">Next steps</p>
											<ul class="mt-0.5 space-y-0.5 list-none">
												{#each it.reviewHandoff.followUps as fu (fu)}
													<li class="text-[10px] text-hub-text leading-snug before:content-['·'] before:mr-1 before:text-hub-dim">{fu}</li>
												{/each}
											</ul>
										</div>
									{/if}
								</div>
							<!-- ADR-012 P1: completed-no-artifact card — a success-like run
							     that left no branch + no hand-back. Surface it (don't hide it
							     in ready_for_ai) so the operator knows to re-dispatch or check. -->
							{:else if it.noArtifact}
								<div class="px-2 py-1.5 rounded border border-hub-warning/40 bg-hub-warning/5">
									<button
										type="button"
										class="w-full text-left group mb-1"
										onclick={() => onSelect(it.id)}
									>
										<div class="flex items-center gap-2">
											<span class="text-[12px] text-hub-text group-hover:text-hub-cta transition-colors truncate flex-1">{it.title}</span>
											<span class="shrink-0 px-1 py-0.5 rounded text-[9px] font-medium {statusClass(it.status)}">{it.status}</span>
										</div>
										<div class="flex items-center gap-2 mt-0.5 text-[10px] text-hub-dim">
											<span class="font-mono uppercase">{it.type}</span>
											<span>· {ownerLabel(it)}</span>
										</div>
									</button>
									<div class="flex items-center gap-2 mt-1">
										<span class="text-[10px] text-hub-warning font-medium">⚠ Completed — no artifact</span>
										<span class="text-[9px] text-hub-dim">${it.noArtifact.costUsd.toFixed(2)} · {it.noArtifact.numTurns} turns</span>
									</div>
									<p class="mt-0.5 text-[10px] text-hub-dim leading-snug">No branch or hand-back — re-dispatch or review manually.</p>
									{#if it.noArtifact.summary}
										<p class="mt-0.5 text-[11px] text-hub-text leading-snug line-clamp-3">{it.noArtifact.summary}</p>
									{/if}
									<!-- ADR-013 — inline Re-dispatch button. Routes to the same
									     agent resolveAgentForWork picks for the drawer so there is
									     no second source of truth. Mirrors sendAnswer's fire-and-
									     forget pattern: leaves redispatching=true on success and
									     lets the 4s poller replace the card with in_flight. -->
									<div class="flex items-center gap-2 mt-1.5">
										<button
											type="button"
											class="px-2 py-0.5 rounded text-[10px] font-medium bg-hub-warning/20 text-hub-warning hover:bg-hub-warning/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
											disabled={redispatching[it.id]}
											onclick={() => redispatch(it)}
										>
											{redispatching[it.id] ? 'Re-dispatching…' : 'Re-dispatch'}
										</button>
										{#if redispatchError[it.id]}
											<p class="text-[10px] text-hub-danger">{redispatchError[it.id]}</p>
										{/if}
									</div>
								</div>
							<!-- ADR-026 P2b: awaiting-operator cards get their own layout
							     with an inline answer box; regular cards stay a plain button. -->
							{:else if it.awaitingOperator}
								<div class="px-2 py-1.5 rounded border border-hub-warning/30 bg-hub-warning/5">
									<button
										type="button"
										class="w-full text-left group mb-1"
										onclick={() => onSelect(it.id)}
									>
										<div class="flex items-center gap-2">
											<span class="text-[12px] text-hub-text group-hover:text-hub-cta transition-colors truncate flex-1">{it.title}</span>
											<span class="shrink-0 px-1 py-0.5 rounded text-[9px] font-medium {statusClass(it.status)}">{it.status}</span>
										</div>
										<div class="flex items-center gap-2 mt-0.5 text-[10px] text-hub-dim">
											<span class="font-mono uppercase">{it.type}</span>
											<span>· {ownerLabel(it)}</span>
										</div>
									</button>
									<!-- Question + answer box -->
									<div class="mt-1 text-[10px] text-hub-warning font-medium">🟡 Waiting on you</div>
									<p class="mt-0.5 text-[11px] text-hub-text leading-snug">{it.awaitingOperator.question}</p>
									<textarea
										class="mt-1.5 w-full text-[11px] rounded border border-hub-border bg-hub-card/60 text-hub-text px-2 py-1 resize-none focus:outline-none focus:border-hub-warning/60 disabled:opacity-50"
										rows={3}
										placeholder="Your answer…"
										disabled={sending[it.id]}
										value={answerText[it.id] ?? ''}
										oninput={(e) => { answerText = { ...answerText, [it.id]: (e.currentTarget as HTMLTextAreaElement).value }; }}
									></textarea>
									{#if sendError[it.id]}
										<p class="text-[10px] text-hub-danger mt-0.5">{sendError[it.id]}</p>
									{/if}
									<button
										type="button"
										class="mt-1 px-2 py-0.5 rounded text-[10px] font-medium bg-hub-warning/20 text-hub-warning hover:bg-hub-warning/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
										disabled={sending[it.id] || !(answerText[it.id] ?? '').trim()}
										onclick={() => sendAnswer(it)}
									>
										{sending[it.id] ? 'Resuming…' : 'Send answer'}
									</button>
								</div>
							{:else}
								<button
									type="button"
									class="w-full text-left px-2 py-1.5 rounded hover:bg-hub-card/70 transition-colors cursor-pointer group"
									onclick={() => onSelect(it.id)}
								>
									<div class="flex items-center gap-2">
										<span class="text-[12px] text-hub-text group-hover:text-hub-cta transition-colors truncate flex-1">{it.title}</span>
										<span class="shrink-0 px-1 py-0.5 rounded text-[9px] font-medium {statusClass(it.status)}">{it.status}</span>
									</div>
									<div class="flex items-center gap-2 mt-0.5 text-[10px] text-hub-dim">
										<span class="font-mono uppercase">{it.type}</span>
										<span>· {ownerLabel(it)}</span>
										{#if it.blockedByUnmet.length > 0}
											<span class="text-hub-warning">· blocked ×{it.blockedByUnmet.length}</span>
										{/if}
									</div>
									{#if it.progress}
										<div class="mt-0.5 text-[10px] text-hub-warning font-mono">
											🟡 working · {it.progress.numTurns}t · ${it.progress.costUsd.toFixed(2)} · {Math.round((Date.now() - it.progress.startedAt) / 60000)}m
										</div>
									{/if}
								</button>
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
