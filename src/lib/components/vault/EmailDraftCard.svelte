<script lang="ts">
	/**
	 * ADR-044 Phase B — In-page card for saved email notes that dispatches
	 * the mailwright agent to compose a reply draft.
	 *
	 * Mounts on vault notes whose frontmatter carries `inbox_message_id`
	 * (added by saveInboxToVault as of Phase A; existing notes backfilled
	 * via scripts/backfill-inbox-message-id.mjs). Without that field, the
	 * card returns null — non-email-save notes don't render this.
	 *
	 * Three visible states:
	 *   - idle    → "↩️ Draft reply via mailwright" button
	 *   - drafting → button disabled, spinner shown (mailwright is 30–60s)
	 *   - done    → green pill linking to the produced draft note +
	 *               "Re-draft" link to overwrite (idempotency in the
	 *               handler protects against accidental re-clicks anyway)
	 *
	 * Reuses POST /api/inbox/messages/[id]/draft so behavior matches the
	 * Telegram callback + /inbox web button — same handler, same idempotency.
	 */

	interface Props {
		meta: Record<string, unknown>;
	}

	let { meta }: Props = $props();

	const messageId = $derived(
		typeof meta.inbox_message_id === 'number'
			? meta.inbox_message_id
			: typeof meta.inbox_message_id === 'string'
				? Number(meta.inbox_message_id)
				: null,
	);

	type CardState = 'probing' | 'idle' | 'drafting' | 'done' | 'error';
	// 'probing' is the initial state — we hit /draft-status on mount to
	// reflect any pre-existing draft (created via Telegram or /inbox, or
	// by this card in a previous tab the operator already closed). Without
	// this, the card always renders "idle" and the operator has no way to
	// see that a draft already exists — they'd click again, hit the
	// idempotency path, and only THEN see the existing draft.
	// Named `cardState`, not `state`: a `state` variable collides with the
	// `$state` rune for svelte-check (parses `$state` as a store read of the
	// var being declared → "used before declaration").
	let cardState = $state<CardState>('probing');
	let resultPath = $state<string | null>(null);
	let resultDetail = $state<string | null>(null);
	let errorMsg = $state<string | null>(null);

	$effect(() => {
		if (!messageId) return;
		void (async () => {
			try {
				const res = await fetch(`/api/inbox/messages/${messageId}/draft-status`);
				if (!res.ok) {
					// Probe failure isn't fatal — fall back to idle so the
					// operator can still dispatch. Most common cause: the
					// source inbox row was pruned after retention window.
					cardState = 'idle';
					return;
				}
				const data = (await res.json()) as {
					drafted?: boolean;
					vaultPath?: string;
				};
				if (data.drafted && data.vaultPath) {
					resultPath = data.vaultPath;
					resultDetail = 'previously drafted';
					cardState = 'done';
				} else {
					cardState = 'idle';
				}
			} catch {
				cardState = 'idle';
			}
		})();
	});

	async function dispatchDraft() {
		if (!messageId || cardState === 'drafting') return;
		cardState = 'drafting';
		errorMsg = null;
		try {
			const res = await fetch(`/api/inbox/messages/${messageId}/draft`, {
				method: 'POST',
			});
			const data = (await res.json()) as {
				ok?: boolean;
				vaultPath?: string;
				detail?: string;
				error?: string;
			};
			if (!res.ok || !data.ok) {
				cardState = 'error';
				errorMsg = data.detail ?? data.error ?? `HTTP ${res.status}`;
				return;
			}
			resultPath = data.vaultPath ?? null;
			resultDetail = data.detail ?? null;
			cardState = 'done';
		} catch (err) {
			cardState = 'error';
			errorMsg = err instanceof Error ? err.message : String(err);
		}
	}

	function resetForReDraft() {
		cardState = 'idle';
		resultPath = null;
		resultDetail = null;
		errorMsg = null;
	}
</script>

{#if messageId}
	<div
		class="email-draft-card rounded-md border border-hub-border bg-hub-card p-3 space-y-2"
	>
		{#if cardState === 'probing'}
			<div class="flex items-center gap-2 text-sm text-hub-dim">
				<span class="text-base leading-none opacity-50">↩️</span>
				<span>Checking draft status…</span>
			</div>
		{:else if cardState === 'idle'}
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-2 text-sm">
					<span class="text-base leading-none">↩️</span>
					<span class="font-medium text-hub-text">Draft reply</span>
					<span class="text-hub-dim text-xs">
						— mailwright composes a reply (~30–60s), saved to <code>email/drafts/</code>
					</span>
				</div>
				<button
					type="button"
					onclick={dispatchDraft}
					class="rounded bg-hub-accent text-hub-bg px-3 py-1 text-xs font-medium hover:bg-hub-accent/90"
				>
					Draft via mailwright
				</button>
			</div>
		{:else if cardState === 'drafting'}
			<div class="flex items-center gap-2 text-sm text-hub-muted">
				<span class="text-base leading-none">🤖</span>
				<span>
					<span class="font-medium text-hub-text">Drafting reply</span> — mailwright is composing
					(30–60s). Hold tight.
				</span>
			</div>
		{:else if cardState === 'done' && resultPath}
			<div class="flex items-center justify-between gap-3 text-sm">
				<div class="flex items-center gap-2 min-w-0">
					<span class="text-base leading-none">✅</span>
					<span class="text-hub-muted">Draft saved →</span>
					<a
						href={`/vault?note=${encodeURIComponent(resultPath)}`}
						class="text-hub-info hover:underline font-medium truncate"
						title={resultPath}
					>
						{resultPath.split('/').pop()}
					</a>
				</div>
				<button
					type="button"
					onclick={resetForReDraft}
					class="text-xs text-hub-dim hover:text-hub-text underline-offset-2 hover:underline"
					title="Reset the card so you can dispatch mailwright again. Vault dedup will catch identical re-drafts."
				>
					Re-draft
				</button>
			</div>
			{#if resultDetail}
				<div class="text-xs text-hub-dim">{resultDetail}</div>
			{/if}
		{:else if cardState === 'error'}
			<div class="flex items-center justify-between gap-3">
				<div class="flex items-center gap-2 text-sm min-w-0">
					<span class="text-base leading-none">❌</span>
					<span class="text-hub-danger truncate" title={errorMsg ?? undefined}>
						Draft failed: {errorMsg}
					</span>
				</div>
				<button
					type="button"
					onclick={dispatchDraft}
					class="rounded border border-hub-border text-hub-text px-2 py-1 text-xs hover:bg-hub-surface"
				>
					Retry
				</button>
			</div>
		{/if}
	</div>
{/if}
