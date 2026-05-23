<script lang="ts">
	/**
	 * ADR-044.E — In-page card for email-save vault notes.
	 *
	 * Renders ONE of two states based on `note.meta.crm_sender_status`:
	 *   - 'in-crm'     → muted summary link to the existing CRM contact
	 *   - 'not-in-crm' → editable form (displayName, email, company)
	 *                    that POSTs /api/inbox/save-sender-to-crm
	 *
	 * On successful add: optimistic flip to in-crm state, then parent's
	 * `onPatched` callback (if provided) refetches the note to surface
	 * any other server-side changes (e.g., contact stage/source).
	 *
	 * Returns null when the note has no `crm_sender_status` field —
	 * non-email-save notes don't render this card.
	 */

	interface Props {
		notePath: string;
		meta: Record<string, unknown>;
		onPatched?: () => void;
	}

	let { notePath, meta, onPatched }: Props = $props();

	// Local optimistic state — flipped on success so the UI doesn't
	// require a refetch round-trip to look right.
	let localStatus = $state(meta.crm_sender_status as string | undefined);
	let localContactId = $state(meta.crm_contact_id as string | undefined);
	let localContactStage = $state(meta.crm_contact_stage as string | undefined);
	let localContactName = $state(meta.crm_contact_display_name as string | undefined);

	// Form fields (only used in not-in-crm state).
	let formName = $state((meta.crm_candidate_name as string) ?? '');
	let formEmail = $state((meta.crm_candidate_email as string) ?? '');
	let formCompany = $state('');

	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);

	// Live CRM check — the frontmatter is a snapshot from save-time. If
	// the operator added this sender via a sibling note's card later,
	// THIS note's frontmatter still says not-in-crm even though the
	// contact now exists. Re-check on mount so the card reflects the
	// current CRM state, not the stale frontmatter.
	$effect(() => {
		if (localStatus !== 'not-in-crm' || !formEmail || !formEmail.includes('@')) return;
		void (async () => {
			try {
				const response = await fetch(
					`/api/crm/contacts/by-email?email=${encodeURIComponent(formEmail)}`,
				);
				if (!response.ok) return;
				const data = (await response.json()) as {
					contact?: { id: string; displayName: string; stage: string } | null;
				};
				if (data.contact) {
					localStatus = 'in-crm';
					localContactId = data.contact.id;
					localContactStage = data.contact.stage;
					localContactName = data.contact.displayName;
				}
			} catch {
				// Swallow — silently fall back to the form. The card is
				// non-critical; a network blip shouldn't break the note view.
			}
		})();
	});

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (submitting) return;
		errorMsg = null;

		const displayName = formName.trim();
		const email = formEmail.trim();
		if (!displayName) {
			errorMsg = 'Name is required.';
			return;
		}
		if (!email || !email.includes('@')) {
			errorMsg = 'Valid email is required.';
			return;
		}

		submitting = true;
		try {
			const response = await fetch('/api/inbox/save-sender-to-crm', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					notePath,
					displayName,
					email,
					company: formCompany.trim() || undefined,
				}),
			});
			const result = (await response.json()) as {
				contactId?: string;
				stage?: string;
				displayName?: string;
				notePatched?: boolean;
				error?: string;
				detail?: string;
			};
			if (!response.ok) {
				errorMsg = result.error || result.detail || `HTTP ${response.status}`;
				return;
			}
			// Optimistic flip.
			localStatus = 'in-crm';
			localContactId = result.contactId;
			localContactStage = result.stage;
			localContactName = result.displayName;
			onPatched?.();
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}
</script>

{#if localStatus === 'in-crm' && localContactId}
	<div
		class="crm-card crm-card-in flex items-center gap-2 text-sm rounded-md border border-hub-border bg-hub-card px-3 py-2"
	>
		<span class="text-base leading-none">🤝</span>
		<span class="text-hub-muted">Sender in CRM:</span>
		<a
			href={`/crm/${localContactId}`}
			class="text-hub-info hover:underline font-medium"
		>
			{localContactName ?? localContactId}
		</a>
		{#if localContactStage}
			<span class="text-hub-dim">·</span>
			<span class="text-hub-muted">{localContactStage}</span>
		{/if}
	</div>
{:else if localStatus === 'not-in-crm'}
	<div class="crm-card crm-card-out rounded-md border border-hub-border bg-hub-card p-3 space-y-2">
		<div class="flex items-center gap-2 text-sm">
			<span class="text-base leading-none">➕</span>
			<span class="font-medium text-hub-text">Save sender to CRM</span>
			<span class="text-hub-dim text-xs">— new Lead from this email</span>
		</div>
		<form onsubmit={handleSubmit} class="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
			<input
				type="text"
				placeholder="Display name"
				bind:value={formName}
				class="rounded border border-hub-border bg-hub-bg px-2 py-1 text-hub-text placeholder:text-hub-dim"
				required
			/>
			<input
				type="email"
				placeholder="Email"
				bind:value={formEmail}
				class="rounded border border-hub-border bg-hub-bg px-2 py-1 text-hub-text placeholder:text-hub-dim"
				required
			/>
			<input
				type="text"
				placeholder="Company (optional)"
				bind:value={formCompany}
				class="rounded border border-hub-border bg-hub-bg px-2 py-1 text-hub-text placeholder:text-hub-dim"
			/>
			<div class="sm:col-span-3 flex items-center gap-3">
				<button
					type="submit"
					disabled={submitting}
					class="rounded bg-hub-accent text-hub-bg px-3 py-1 text-xs font-medium hover:bg-hub-accent/90 disabled:opacity-50"
				>
					{submitting ? 'Adding…' : 'Add to CRM as Lead'}
				</button>
				{#if errorMsg}
					<span class="text-xs text-hub-danger">{errorMsg}</span>
				{/if}
			</div>
		</form>
	</div>
{/if}
