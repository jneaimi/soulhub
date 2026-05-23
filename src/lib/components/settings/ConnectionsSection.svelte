<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * Connections — first-class OAuth client management.
	 * See ADR 2026-05-11-oauth-clients-as-first-class-connections.
	 *
	 * Per provider, an operator can register one or more OAuth clients.
	 * Accounts in the inbox reference these by FK. Exactly one client per
	 * provider may be marked Default.
	 */

	interface ClientDto {
		id: string;
		provider: 'gmail' | 'outlook';
		label: string;
		clientId: string;
		isDefault: boolean;
		accountCount: number;
		createdAt: number;
		lastUsedAt: number | null;
	}

	let clients = $state<ClientDto[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Add modal state
	let addOpen = $state(false);
	let addProvider = $state<'gmail' | 'outlook'>('gmail');
	let addLabel = $state('');
	let addClientId = $state('');
	let addClientSecret = $state('');
	let addIsDefault = $state(false);
	let adding = $state(false);
	let addError = $state<string | null>(null);

	// Edit modal state
	let editId = $state<string | null>(null);
	let editLabel = $state('');
	let editClientSecret = $state('');
	let editIsDefault = $state(false);
	let editing = $state(false);
	let editError = $state<string | null>(null);

	// Delete confirm state
	let deletingId = $state<string | null>(null);

	function mask(clientId: string): string {
		// "123456-abc.apps.googleusercontent.com" → "1234…leusercontent.com"
		if (clientId.length <= 12) return clientId;
		return clientId.slice(0, 4) + '…' + clientId.slice(-16);
	}

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/inbox/oauth/clients');
			const data = await res.json();
			if (!res.ok) {
				error = data.error || `HTTP ${res.status}`;
				return;
			}
			clients = data.clients;
		} catch (e) {
			error = (e as Error).message;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function openAdd(): void {
		addOpen = true;
		addProvider = 'gmail';
		addLabel = '';
		addClientId = '';
		addClientSecret = '';
		addIsDefault = clients.filter((c) => c.provider === 'gmail').length === 0; // auto-default the first one
		addError = null;
	}

	function closeAdd(): void {
		addOpen = false;
	}

	async function submitAdd() {
		const label = addLabel.trim();
		const clientId = addClientId.trim();
		const clientSecret = addClientSecret.trim();
		if (!label || !clientId || !clientSecret) {
			addError = 'Label, Client ID, and Client Secret are all required.';
			return;
		}
		adding = true;
		addError = null;
		try {
			const res = await fetch('/api/inbox/oauth/clients', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: addProvider,
					label,
					clientId,
					clientSecret,
					isDefault: addIsDefault,
				}),
			});
			const data = await res.json();
			if (!res.ok) {
				addError = data.error || `HTTP ${res.status}`;
				return;
			}
			await load();
			closeAdd();
		} catch (e) {
			addError = (e as Error).message;
		} finally {
			adding = false;
		}
	}

	function openEdit(client: ClientDto) {
		editId = client.id;
		editLabel = client.label;
		editClientSecret = '';
		editIsDefault = client.isDefault;
		editError = null;
	}

	function closeEdit() {
		editId = null;
	}

	async function submitEdit() {
		if (!editId) return;
		const label = editLabel.trim();
		if (!label) {
			editError = 'Label cannot be empty.';
			return;
		}
		const patch: Record<string, unknown> = { label };
		if (editClientSecret.trim()) patch.clientSecret = editClientSecret.trim();
		patch.isDefault = editIsDefault;
		editing = true;
		editError = null;
		try {
			const res = await fetch(`/api/inbox/oauth/clients/${editId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(patch),
			});
			const data = await res.json();
			if (!res.ok) {
				editError = data.error || `HTTP ${res.status}`;
				return;
			}
			await load();
			closeEdit();
		} catch (e) {
			editError = (e as Error).message;
		} finally {
			editing = false;
		}
	}

	async function confirmDelete(client: ClientDto) {
		if (deletingId === client.id) {
			// second click confirms
			try {
				const res = await fetch(`/api/inbox/oauth/clients/${client.id}`, { method: 'DELETE' });
				const data = await res.json();
				if (!res.ok) {
					error = data.error || `HTTP ${res.status}`;
					return;
				}
				await load();
			} catch (e) {
				error = (e as Error).message;
			} finally {
				deletingId = null;
			}
		} else {
			deletingId = client.id;
			// auto-cancel after 4s
			setTimeout(() => {
				if (deletingId === client.id) deletingId = null;
			}, 4000);
		}
	}

	function providerLabel(p: string): string {
		if (p === 'gmail') return 'Gmail';
		if (p === 'outlook') return 'Outlook';
		return p;
	}

	const gmailClients = $derived(clients.filter((c) => c.provider === 'gmail'));
	const outlookClients = $derived(clients.filter((c) => c.provider === 'outlook'));
</script>

<section id="connections" class="mb-6 scroll-mt-4">
	<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-1">
			<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Connections</h2>
			<button
				type="button"
				onclick={openAdd}
				class="text-[11px] text-hub-cta hover:underline cursor-pointer"
			>+ Add OAuth client</button>
		</div>
		<p class="text-xs text-hub-muted mb-4 leading-relaxed">
			OAuth clients for Gmail and Outlook. Each client maps to a Google Cloud (or Microsoft Entra)
			project's OAuth credential pair. Inbox accounts reference these by name. The Default client
			(one per provider) is used when no specific client is chosen at Add time.
		</p>

		{#if error}
			<div class="mb-3 px-3 py-2 rounded-md bg-hub-danger/10 border border-hub-danger/30 text-xs text-hub-danger">
				{error}
			</div>
		{/if}

		{#if loading}
			<div class="text-xs text-hub-dim py-3">Loading…</div>
		{:else}
			<!-- Gmail group -->
			<div class="mb-4">
				<h3 class="text-[11px] font-medium text-hub-muted uppercase tracking-wider mb-2">Google OAuth clients</h3>
				{#if gmailClients.length === 0}
					<div class="text-xs text-hub-dim italic py-2">
						No Gmail OAuth clients configured. Click <strong>+ Add OAuth client</strong> above to register one.
					</div>
				{:else}
					<div class="space-y-1.5">
						{#each gmailClients as c (c.id)}
							<div class="px-3 py-2.5 rounded-md bg-hub-bg border border-hub-border hover:border-hub-cta/30 transition-colors">
								<div class="flex items-start gap-3">
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-sm font-medium text-hub-text truncate">{c.label}</span>
											{#if c.isDefault}
												<span class="text-[9px] px-1.5 py-0.5 rounded bg-hub-cta/10 text-hub-cta border border-hub-cta/30 uppercase tracking-wider">Default</span>
											{/if}
										</div>
										<div class="text-[11px] text-hub-dim font-mono truncate mt-0.5" title={c.clientId}>{mask(c.clientId)}</div>
										<div class="text-[10px] text-hub-dim mt-0.5">
											Used by {c.accountCount} account{c.accountCount === 1 ? '' : 's'}
											{#if c.lastUsedAt}
												· last used {new Date(c.lastUsedAt).toLocaleDateString()}
											{/if}
										</div>
									</div>
									<div class="flex items-center gap-1 shrink-0">
										<button
											type="button"
											onclick={() => openEdit(c)}
											class="text-[10px] px-2 py-1 rounded bg-hub-card text-hub-muted border border-hub-border hover:text-hub-text hover:border-hub-cta/30 transition-colors cursor-pointer"
										>Edit</button>
										<button
											type="button"
											onclick={() => confirmDelete(c)}
											class="text-[10px] px-2 py-1 rounded {deletingId === c.id ? 'bg-hub-danger/15 text-hub-danger border border-hub-danger/40' : 'bg-hub-card text-hub-dim border border-hub-border hover:text-hub-danger hover:border-hub-danger/30'} transition-colors cursor-pointer"
											aria-label={deletingId === c.id ? 'Confirm delete' : 'Delete OAuth client'}
										>{deletingId === c.id ? 'Confirm?' : 'Delete'}</button>
									</div>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Outlook group (only render when at least one exists; otherwise hide to keep UI tight) -->
			{#if outlookClients.length > 0}
				<div class="mb-2">
					<h3 class="text-[11px] font-medium text-hub-muted uppercase tracking-wider mb-2">Microsoft OAuth clients</h3>
					<div class="space-y-1.5">
						{#each outlookClients as c (c.id)}
							<div class="px-3 py-2.5 rounded-md bg-hub-bg border border-hub-border hover:border-hub-cta/30 transition-colors">
								<div class="flex items-start gap-3">
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-sm font-medium text-hub-text truncate">{c.label}</span>
											{#if c.isDefault}
												<span class="text-[9px] px-1.5 py-0.5 rounded bg-hub-cta/10 text-hub-cta border border-hub-cta/30 uppercase tracking-wider">Default</span>
											{/if}
										</div>
										<div class="text-[11px] text-hub-dim font-mono truncate mt-0.5" title={c.clientId}>{mask(c.clientId)}</div>
										<div class="text-[10px] text-hub-dim mt-0.5">
											Used by {c.accountCount} account{c.accountCount === 1 ? '' : 's'}
										</div>
									</div>
									<div class="flex items-center gap-1 shrink-0">
										<button type="button" onclick={() => openEdit(c)} class="text-[10px] px-2 py-1 rounded bg-hub-card text-hub-muted border border-hub-border hover:text-hub-text hover:border-hub-cta/30 transition-colors cursor-pointer">Edit</button>
										<button type="button" onclick={() => confirmDelete(c)} class="text-[10px] px-2 py-1 rounded {deletingId === c.id ? 'bg-hub-danger/15 text-hub-danger border border-hub-danger/40' : 'bg-hub-card text-hub-dim border border-hub-border hover:text-hub-danger hover:border-hub-danger/30'} transition-colors cursor-pointer">{deletingId === c.id ? 'Confirm?' : 'Delete'}</button>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</div>
</section>

<!-- Add modal -->
{#if addOpen}
	<div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) closeAdd(); }} onkeydown={(e) => { if (e.key === 'Escape') closeAdd(); }}>
		<div class="bg-hub-surface border border-hub-border rounded-lg w-full max-w-md p-5 space-y-4">
			<div>
				<h3 class="text-sm font-medium text-hub-text mb-1">Add OAuth client</h3>
				<p class="text-[11px] text-hub-muted leading-relaxed">
					Register an OAuth client from a Google Cloud or Microsoft Entra project. Make sure
					<code class="text-[10px] text-hub-text">{`${typeof window !== 'undefined' ? window.location.origin : ''}/api/inbox/oauth/callback`}</code>
					is registered as an authorized redirect URI in that project before signing in.
				</p>
			</div>

			{#if addError}
				<div class="px-3 py-2 rounded-md bg-hub-danger/10 border border-hub-danger/30 text-xs text-hub-danger">
					{addError}
				</div>
			{/if}

			<div class="space-y-3">
				<label class="block">
					<span class="block text-[10px] text-hub-dim uppercase tracking-wider mb-1">Provider</span>
					<select bind:value={addProvider} class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs text-hub-text focus:outline-none focus:border-hub-cta/50">
						<option value="gmail">Gmail</option>
						<option value="outlook">Outlook</option>
					</select>
				</label>
				<label class="block">
					<span class="block text-[10px] text-hub-dim uppercase tracking-wider mb-1">Label</span>
					<input type="text" bind:value={addLabel} placeholder="e.g. Personal Workspace" class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50" />
				</label>
				<label class="block">
					<span class="block text-[10px] text-hub-dim uppercase tracking-wider mb-1">Client ID</span>
					<input type="text" bind:value={addClientId} placeholder="123456-abc.apps.googleusercontent.com" class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 font-mono" />
				</label>
				<label class="block">
					<span class="block text-[10px] text-hub-dim uppercase tracking-wider mb-1">Client Secret</span>
					<input type="password" autocomplete="new-password" bind:value={addClientSecret} placeholder="GOCSPX-…" class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 font-mono" />
				</label>
				<label class="flex items-center gap-2 cursor-pointer">
					<input type="checkbox" bind:checked={addIsDefault} class="rounded border-hub-border bg-hub-bg" />
					<span class="text-xs text-hub-muted">Make this the default for new {providerLabel(addProvider)} accounts</span>
				</label>
			</div>

			<div class="flex justify-end gap-2 pt-1">
				<button type="button" onclick={closeAdd} class="text-xs px-3 py-1.5 rounded text-hub-muted hover:text-hub-text transition-colors cursor-pointer">Cancel</button>
				<button type="button" onclick={submitAdd} disabled={adding} class="text-xs px-3 py-1.5 rounded bg-hub-cta/15 text-hub-cta border border-hub-cta/30 hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50">{adding ? 'Adding…' : 'Add client'}</button>
			</div>
		</div>
	</div>
{/if}

<!-- Edit modal -->
{#if editId}
	{@const current = clients.find((c) => c.id === editId)}
	{#if current}
	<div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) closeEdit(); }} onkeydown={(e) => { if (e.key === 'Escape') closeEdit(); }}>
		<div class="bg-hub-surface border border-hub-border rounded-lg w-full max-w-md p-5 space-y-4">
			<div>
				<h3 class="text-sm font-medium text-hub-text mb-1">Edit OAuth client</h3>
				<p class="text-[11px] text-hub-muted">
					<span class="font-mono text-hub-dim">{mask(current.clientId)}</span>
					<span class="block mt-1">Client ID is immutable. To change it, add a new client and reassign accounts.</span>
				</p>
			</div>

			{#if editError}
				<div class="px-3 py-2 rounded-md bg-hub-danger/10 border border-hub-danger/30 text-xs text-hub-danger">
					{editError}
				</div>
			{/if}

			<div class="space-y-3">
				<label class="block">
					<span class="block text-[10px] text-hub-dim uppercase tracking-wider mb-1">Label</span>
					<input type="text" bind:value={editLabel} class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs text-hub-text focus:outline-none focus:border-hub-cta/50" />
				</label>
				<label class="block">
					<span class="block text-[10px] text-hub-dim uppercase tracking-wider mb-1">Replace Client Secret (optional)</span>
					<input type="password" autocomplete="new-password" bind:value={editClientSecret} placeholder="Leave blank to keep existing" class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs text-hub-text placeholder:text-hub-dim focus:outline-none focus:border-hub-cta/50 font-mono" />
				</label>
				<label class="flex items-center gap-2 cursor-pointer">
					<input type="checkbox" bind:checked={editIsDefault} class="rounded border-hub-border bg-hub-bg" />
					<span class="text-xs text-hub-muted">Default for new {providerLabel(current.provider)} accounts</span>
				</label>
			</div>

			<div class="flex justify-end gap-2 pt-1">
				<button type="button" onclick={closeEdit} class="text-xs px-3 py-1.5 rounded text-hub-muted hover:text-hub-text transition-colors cursor-pointer">Cancel</button>
				<button type="button" onclick={submitEdit} disabled={editing} class="text-xs px-3 py-1.5 rounded bg-hub-cta/15 text-hub-cta border border-hub-cta/30 hover:bg-hub-cta/25 transition-colors cursor-pointer disabled:opacity-50">{editing ? 'Saving…' : 'Save'}</button>
			</div>
		</div>
	</div>
	{/if}
{/if}
