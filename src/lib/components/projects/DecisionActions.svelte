<script lang="ts">
	/** Inline accept / reject / park buttons for a proposed ADR.
	 *
	 *  projects-graph ADR-025 D5 — Legible dispatch UX.
	 *
	 *  Used by the Decision Queue (/projects/queue) and the project detail page
	 *  (/projects/[slug]). Wraps POST /api/vault/decisions/transition and emits
	 *  a typed callback when the transition lands so the parent can drop or
	 *  refresh the row.
	 *
	 *  Button layout (D5 — two named buttons):
	 *  - Agent resolved  → primary "Accept → 🤖 {agent}" (confirm → accept + dispatch)
	 *                     + secondary "Accept (I'll handle it)" (plain human accept)
	 *                     + Reject  + Park
	 *  - No agent routes → plain "Accept" + Reject + Park (no AI affordance)
	 *
	 *  The confirm dialog shows agent / mode / cost estimate before dispatching,
	 *  eliminating blind-spend risk (D5 finding #4).  On confirm the component
	 *  accepts the decision (sets assignee to the agent) then signals the page
	 *  via `onDispatch` so the page opens the AdrDrawer with autoDispatch=true
	 *  and reuses the existing stream + code-review card (no duplicate UI).
	 */

	import { decisionActionModel, buildConfirmMessage } from '$lib/projects/decision-actions-model.js';

	type Action = 'accept' | 'reject' | 'park';

	interface Props {
		path: string;
		size?: 'sm' | 'md';
		onTransition?: (info: { path: string; action: Action; newStatus: string }) => void;
		/** projects-graph ADR-025 D5 — routing inputs.
		 *  Passed from the page which loads the roster ONCE and has full row meta.
		 *  All optional so existing call sites without routing context get a plain
		 *  Accept button (safe fallback). */
		work_type?: string | null;
		assignee?: string | null;
		tags?: string[];
		agentIds?: Set<string>;
		/** ADR-014 D1 — repo map from the roster load (agent-id → repo path).
		 *  When provided, coding candidates without a repo are skipped so the AI
		 *  button is hidden rather than showing a dispatch that would fail. */
		agentRepos?: Map<string, string | undefined>;
		/** ADR-011 D2 — true when the artifact's project has a `repo:` binding
		 *  on its `index.md`. Opens the carve-out for `implementer` specifically:
		 *  a project-bound repo satisfies ADR-014's isolation requirement for the
		 *  general implementer. Default false (safe: no AI button for unbound projects). */
		subjectHasProjectRepo?: boolean;
		/** Called after a successful accept+dispatch confirm.
		 *  The page opens the AdrDrawer for `path` with autoDispatch=true,
		 *  reusing the drawer's existing stream + code-review card. */
		onDispatch?: (path: string) => void;
	}

	let {
		path,
		size = 'md',
		onTransition,
		work_type = null,
		assignee = null,
		tags = [],
		agentIds = new Set<string>(),
		agentRepos,
		subjectHasProjectRepo = false,
		onDispatch,
	}: Props = $props();

	type Mode = null | 'reject' | 'park' | 'confirm-ai';

	let acting = $state<Action | null>(null);
	let mode = $state<Mode>(null);
	let rejectReason = $state('');
	let parkReviewAfter = $state('');
	let result = $state<{ status: 'ok' | 'error'; message: string } | null>(null);

	const padding = $derived(size === 'sm' ? 'px-2.5 py-1' : 'px-3 py-1.5');
	const textSize = $derived(size === 'sm' ? 'text-[11px]' : 'text-xs');

	/** D5 — resolved agent + showAiButton flag. Recomputed when roster or
	 *  metadata changes (agentIds is a Set, so reassignment triggers reactivity).
	 *  ADR-014 D1 — agentRepos passed so repo-less coding agents are hidden.
	 *  ADR-011 D2 — subjectHasProjectRepo opens the implementer carve-out. */
	const actionModel = $derived(decisionActionModel(work_type, assignee, tags, agentIds, agentRepos, subjectHasProjectRepo));
	const resolvedAgent = $derived(actionModel.resolvedAgent);
	const showAiButton = $derived(actionModel.showAiButton);
	/** ADR-025 D2 — the specialist agent expected but not in the live roster.
	 *  Null when nothing is expected or when the roster is populated correctly.
	 *  Drives the "no `<agent>` installed" hint so users know why AI is absent. */
	const missingSpecialist = $derived(actionModel.missingSpecialist);
	/** ADR-025 D3 — true when coding work is blocked only because the project
	 *  has no repo binding. Surface a "Bind / scaffold a repo" affordance. */
	const needsScaffold = $derived(actionModel.needsScaffold);
	const confirmMessage = $derived(resolvedAgent ? buildConfirmMessage(resolvedAgent) : '');

	async function transition(action: Action, body: Record<string, unknown> = {}) {
		acting = action;
		result = null;
		try {
			const res = await fetch('/api/vault/decisions/transition', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, action, ...body }),
			});
			const data = await res.json();
			if (!res.ok || !data.success) {
				result = { status: 'error', message: data.error ?? `HTTP ${res.status}` };
				return;
			}
			result = { status: 'ok', message: `${action} → ${data.newStatus}` };
			mode = null;
			rejectReason = '';
			parkReviewAfter = '';
			onTransition?.({ path, action, newStatus: data.newStatus });
		} catch (e) {
			result = { status: 'error', message: e instanceof Error ? e.message : 'Network error' };
		} finally {
			acting = null;
		}
	}

	/** D5 confirm path — accept the decision with the resolved agent as assignee,
	 *  then signal the page to open the AdrDrawer with autoDispatch=true.
	 *  The drawer reuses its existing dispatchToAI() + stream + code-review card. */
	async function confirmDispatch() {
		if (!resolvedAgent) return;
		const agent = resolvedAgent;
		mode = null;
		await transition('accept', { assignee: agent });
		// Signal the page AFTER the transition completes so the row has been
		// removed / refreshed before the drawer is (re-)opened.
		onDispatch?.(path);
	}

	/** Move a node to <body> so a `position: fixed` overlay escapes any ancestor
	 *  with a transform / filter / overflow (which would otherwise become its
	 *  containing block and trap it). The confirm modal renders in both the
	 *  constrained list row and the drawer, so it must be portal-safe. */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy() { node.parentNode?.removeChild(node); } };
	}
</script>

<!-- Button row -->
<div class="flex items-center gap-1 flex-shrink-0">
	{#if showAiButton}
		<!-- D5 primary: Accept → 🤖 {agent} — opens the confirm panel -->
		<button
			onclick={() => { mode = mode === 'confirm-ai' ? null : 'confirm-ai'; }}
			disabled={acting !== null}
			class="{padding} rounded {textSize} font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
		>
			{acting === 'accept' ? '…' : `Accept → 🤖 ${resolvedAgent}`}
		</button>
		<!-- D5 secondary: human-owned accept (no AI) -->
		<button
			onclick={() => transition('accept')}
			disabled={acting !== null}
			class="{padding} rounded {textSize} font-medium bg-hub-info/15 text-hub-info hover:bg-hub-info/25 transition-colors cursor-pointer disabled:opacity-50"
		>
			{acting === 'accept' ? '…' : "Accept (I'll handle it)"}
		</button>
	{:else}
		<!-- No agent routes — plain accept, no AI affordance -->
		<button
			onclick={() => transition('accept')}
			disabled={acting !== null}
			class="{padding} rounded {textSize} font-medium bg-hub-info/15 text-hub-info hover:bg-hub-info/25 transition-colors cursor-pointer disabled:opacity-50"
		>
			{acting === 'accept' ? '…' : 'Accept'}
		</button>
		<!-- ADR-025 D2 — "no `<agent>` installed" hint when a non-coding specialist
		     is expected but absent from the live roster. Shown inline beside the
		     Accept button so the operator understands why the AI action is missing. -->
		{#if missingSpecialist}
			<span
				class="{padding} rounded {textSize} text-hub-dim italic"
				title="Install {missingSpecialist} agent in Lane A (~/.claude/agents/{missingSpecialist}.md) to enable AI dispatch for this work type"
			>
				no {missingSpecialist} installed
			</span>
		{/if}
		<!-- ADR-025 D3 — "no repo bound" hint for coding work without a project
		     repo. Directs the operator to bind or scaffold a repo on the project's
		     index.md so the implementer carve-out opens and AI dispatch becomes
		     available. Links to the project detail page (which hosts the bind UI). -->
		{#if needsScaffold}
			<span
				class="{padding} rounded {textSize} text-hub-warning italic"
				title="This project has no repo binding — add `repo: ~/dev/<slug>` to the project's index.md to enable coding AI dispatch. Visit the project page to scaffold or bind a repo."
			>
				bind a repo first
			</span>
		{/if}
	{/if}
	<button
		onclick={() => { mode = mode === 'reject' ? null : 'reject'; }}
		disabled={acting !== null}
		class="{padding} rounded {textSize} font-medium bg-hub-danger/15 text-hub-danger hover:bg-hub-danger/25 transition-colors cursor-pointer disabled:opacity-50"
	>
		Reject
	</button>
	<button
		onclick={() => { mode = mode === 'park' ? null : 'park'; }}
		disabled={acting !== null}
		class="{padding} rounded {textSize} font-medium bg-hub-dim/15 text-hub-dim hover:bg-hub-dim/25 transition-colors cursor-pointer disabled:opacity-50"
	>
		Park
	</button>
</div>

<!-- D5 confirm — centered modal overlay so it never competes with the
     constrained list-row / drawer layout (a sibling inline panel squished
     the row + wrapped the title; live walkthrough 2026-05-26). -->
{#if mode === 'confirm-ai' && resolvedAgent}
	<div use:portal class="fixed inset-0 z-[60] flex items-center justify-center p-4">
		<button
			type="button"
			aria-label="Cancel dispatch"
			class="absolute inset-0 bg-black/50 cursor-default"
			onclick={() => { mode = null; }}
		></button>
		<div class="relative w-full max-w-md p-4 rounded-lg bg-hub-surface border border-hub-cta/30 shadow-xl">
			<p class="text-sm text-hub-text font-medium mb-1">Dispatch to AI?</p>
			<p class="text-xs text-hub-dim mb-4">{confirmMessage}</p>
			<div class="flex items-center justify-end gap-2">
				<button
					onclick={() => { mode = null; }}
					class="px-3 py-1.5 rounded text-xs text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
				>
					Cancel
				</button>
				<button
					onclick={confirmDispatch}
					disabled={acting !== null}
					class="px-3 py-1.5 rounded text-xs font-medium bg-hub-cta text-hub-bg hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-50"
				>
					{acting === 'accept' ? '…' : 'Dispatch'}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if mode === 'reject'}
	<div class="mt-3 p-3 rounded-lg bg-hub-surface border border-hub-danger/30">
		<label class="block text-[11px] font-medium text-hub-danger mb-1">
			Reason for reject (required)
		</label>
		<textarea
			bind:value={rejectReason}
			rows="2"
			placeholder="Why is this rejected? Any context for future-you."
			class="w-full bg-transparent border border-hub-border rounded px-2 py-1.5 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-danger/50 transition-colors resize-none"
		></textarea>
		<div class="flex items-center gap-2 mt-2">
			<button
				onclick={() => transition('reject', { reason: rejectReason })}
				disabled={!rejectReason.trim() || acting !== null}
				class="px-3 py-1 rounded text-[11px] font-medium bg-hub-danger text-white hover:bg-hub-danger/90 transition-colors cursor-pointer disabled:opacity-50"
			>
				Confirm reject
			</button>
			<button
				onclick={() => { mode = null; rejectReason = ''; }}
				class="px-3 py-1 rounded text-[11px] text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
			>
				Cancel
			</button>
		</div>
	</div>
{/if}

{#if mode === 'park'}
	<div class="mt-3 p-3 rounded-lg bg-hub-surface border border-hub-dim/30">
		<label class="block text-[11px] font-medium text-hub-dim mb-1">
			Review after (optional, YYYY-MM-DD)
		</label>
		<input
			bind:value={parkReviewAfter}
			type="text"
			placeholder="2026-06-30"
			pattern="\d{'{4}'}-\d{'{2}'}-\d{'{2}'}"
			class="w-full bg-transparent border border-hub-border rounded px-2 py-1.5 text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 transition-colors"
		/>
		<div class="flex items-center gap-2 mt-2">
			<button
				onclick={() => transition('park', parkReviewAfter ? { reviewAfter: parkReviewAfter } : {})}
				disabled={acting !== null}
				class="px-3 py-1 rounded text-[11px] font-medium bg-hub-dim text-hub-text hover:bg-hub-dim/80 transition-colors cursor-pointer disabled:opacity-50"
			>
				Confirm park
			</button>
			<button
				onclick={() => { mode = null; parkReviewAfter = ''; }}
				class="px-3 py-1 rounded text-[11px] text-hub-dim hover:text-hub-text transition-colors cursor-pointer"
			>
				Cancel
			</button>
		</div>
	</div>
{/if}

{#if result}
	<div
		class="mt-2 px-2 py-1 rounded text-[11px]"
		class:bg-hub-info={result.status === 'ok'}
		class:text-white={result.status === 'ok'}
		class:bg-hub-danger={result.status === 'error'}
	>
		{result.message}
	</div>
{/if}
