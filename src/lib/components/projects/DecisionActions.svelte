<script lang="ts">
	/** Inline accept / reject / park buttons for a proposed ADR.
	 *
	 *  Used by the Decision Queue (/projects/queue) and the project detail page
	 *  (/projects/[slug]). Wraps POST /api/vault/decisions/transition and emits
	 *  a typed callback when the transition lands so the parent can drop or
	 *  refresh the row.
	 */

	type Action = 'accept' | 'reject' | 'park';

	interface Props {
		path: string;
		size?: 'sm' | 'md';
		onTransition?: (info: { path: string; action: Action; newStatus: string }) => void;
	}

	let { path, size = 'md', onTransition }: Props = $props();

	/** Default executor for the "Accept → AI" handoff (soul-hub-governance
	 *  dispose→execute step). The conductor coordinates + dispatches to the right
	 *  specialist; reassign in the drawer for a specific agent. */
	const HANDOFF_AGENT = 'conductor';

	let acting = $state<Action | null>(null);
	let mode = $state<null | 'reject' | 'park'>(null);
	let rejectReason = $state('');
	let parkReviewAfter = $state('');
	let result = $state<{ status: 'ok' | 'error'; message: string } | null>(null);

	const padding = $derived(size === 'sm' ? 'px-2.5 py-1' : 'px-3 py-1.5');
	const textSize = $derived(size === 'sm' ? 'text-[11px]' : 'text-xs');

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
</script>

<div class="flex items-center gap-1 flex-shrink-0">
	<button
		onclick={() => transition('accept')}
		disabled={acting !== null}
		class="{padding} rounded {textSize} font-medium bg-hub-info/15 text-hub-info hover:bg-hub-info/25 transition-colors cursor-pointer disabled:opacity-50"
	>
		{acting === 'accept' ? '…' : 'Accept'}
	</button>
	<button
		onclick={() => transition('accept', { assignee: HANDOFF_AGENT })}
		disabled={acting !== null}
		title="Accept and hand to AI ({HANDOFF_AGENT}) — moves to Ready for AI. Reassign in the drawer for a specific agent."
		class="{padding} rounded {textSize} font-medium bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50"
	>
		{acting === 'accept' ? '…' : 'Accept → AI'}
	</button>
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
