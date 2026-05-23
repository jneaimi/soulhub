<script lang="ts">
	/** Shape returned by GET /api/secrets — produced by getMaskedSecrets(). */
	interface ApiSecret {
		key: string;
		set: boolean;
		source: 'platform' | 'shell';
		declared: boolean;
		required: boolean;
		declaredBy: string[];
		link?: string;
	}

	/** Local descriptions for env vars that aren't yet declared by an adapter
	 *  (skills, etc.). When/if these consumers register via the channel/provider
	 *  registry, these rows can be removed. */
	interface KnownVar {
		key: string;
		description: string;
		usedBy: string[];
		/** Optional setup URL — rendered as a help link next to the field.
		 *  Falls through to adapter-declared link (api?.link) if omitted. */
		link?: string;
	}

	const KNOWN_VARS: KnownVar[] = [
		{ key: 'TELEGRAM_BOT_TOKEN', description: 'Telegram Bot API token', usedBy: ['telegram channel'] },
		{ key: 'TELEGRAM_CHAT_ID', description: 'Telegram chat ID for notifications', usedBy: ['telegram channel'] },
		{ key: 'APIDIRECT_API_KEY', description: 'API key for Twitter, Reddit, TikTok, Instagram, LinkedIn', usedBy: ['collect skill', 'research skill', 'recipe skill'] },
		{ key: 'YOUTUBE_API_KEY', description: 'YouTube Data API key', usedBy: ['collect skill', 'research skill'] },
		{ key: 'GEMINI_API_KEY', description: 'Gemini API for image + Veo video generation', usedBy: ['generate skill', 'media-creator agent'] },
		{ key: 'ELEVENLABS_API_KEY', description: 'ElevenLabs text-to-speech', usedBy: ['generate skill', 'media-creator agent'] },
		{ key: 'RESEND_API_KEY', description: 'Resend email API for newsletters', usedBy: ['newsletter skill'] },
		{ key: 'GOOGLE_API_KEY', description: 'Google Cloud Platform (Geocoding, Places, Maps)', usedBy: ['google maps/places integrations'] },
		// Gmail/Outlook OAuth client_id/secret pairs are now managed in
		// Settings → Connections (see ADR
		// 2026-05-11-oauth-clients-as-first-class-connections). Migration #5
		// seeded the Default row from legacy GOOGLE_CLIENT_ID/SECRET env vars
		// on first run; those vars are no longer read at runtime.
		{ key: 'HF_API_TOKEN', description: 'Hugging Face Inference API (optional)', usedBy: ['research skill'] },
		{ key: 'EODHD_API_KEY', description: 'EODHD financial data API', usedBy: ['market skill'] },
		// Inbox Layer 2 filter switches — set to "1" to disable the matching
		// behavior. PM2 reload required for changes to take effect.
		{ key: 'INBOX_FILTER_DISABLED', description: 'Set to 1 to disable the Layer 2 inbox filter worker entirely', usedBy: ['inbox-filter worker'] },
		{ key: 'INBOX_FILTER_LLM_DISABLED', description: 'Set to 1 to run rules-only (no claude -p classifier calls)', usedBy: ['inbox-filter worker'] },
		{ key: 'INBOX_FILTER_COLDSTART_SKIP', description: 'Set to 1 to skip the historical sweep on fresh installs', usedBy: ['inbox-filter worker'] },
	];
	const knownByKey = new Map(KNOWN_VARS.map((v) => [v.key, v]));

	/** Final merged row consumed by the template. */
	interface EnvRow {
		key: string;
		description: string;
		usedBy: string[];
		set: boolean;
		source: 'platform' | 'shell';
		required: boolean;
		declared: boolean;
		declaredBy: string[];
		link?: string;
	}

	let secrets = $state<ApiSecret[]>([]);
	let loading = $state(true);

	// Edit state
	let editingKey = $state<string | null>(null);
	let editValue = $state('');
	let saving = $state(false);
	let saveResult = $state<{ ok: boolean; key: string } | null>(null);

	// Test state — keyed by env var so multiple tests can be in flight
	type TestStatus =
		| 'ok'
		| 'unauthorized'
		| 'invalid'
		| 'ratelimit'
		| 'network'
		| 'unconfigured'
		| 'unsupported';
	interface TestState {
		status: 'pending' | TestStatus;
		message?: string;
		ok?: boolean;
	}
	let testStates = $state<Record<string, TestState>>({});

	// Sync from shell
	let syncing = $state(false);
	let syncResult = $state<{ count: number } | null>(null);

	// Add new secret
	let addingNew = $state(false);
	let newKey = $state('');
	let newValue = $state('');

	/** Merge locally documented vars with the API's declared/on-disk view.
	 *  Order: KNOWN_VARS first (stable display order), then any extras from
	 *  the API that aren't in KNOWN_VARS (declared by an adapter we don't
	 *  document locally, or already on disk as a custom key). */
	let envList = $derived.by<EnvRow[]>(() => {
		const apiByKey = new Map(secrets.map((s) => [s.key, s]));
		const seen = new Set<string>();
		const rows: EnvRow[] = [];

		const buildRow = (key: string): EnvRow => {
			const api = apiByKey.get(key);
			const known = knownByKey.get(key);
			return {
				key,
				description: known?.description ?? (api?.declared ? '' : 'Custom secret'),
				usedBy: known?.usedBy ?? [],
				set: api?.set ?? false,
				source: api?.source ?? 'platform',
				required: api?.required ?? false,
				declared: api?.declared ?? false,
				declaredBy: api?.declaredBy ?? [],
				link: api?.link ?? known?.link,
			};
		};

		for (const known of KNOWN_VARS) {
			rows.push(buildRow(known.key));
			seen.add(known.key);
		}
		for (const s of secrets) {
			if (seen.has(s.key)) continue;
			rows.push(buildRow(s.key));
			seen.add(s.key);
		}
		return rows;
	});

	async function loadSecrets() {
		loading = true;
		try {
			const res = await fetch('/api/secrets');
			if (res.ok) secrets = await res.json();
		} catch { /* ignore */ }
		loading = false;
	}

	// Load on mount
	import { onMount } from 'svelte';
	onMount(loadSecrets);

	function startEditing(key: string) {
		editingKey = key;
		editValue = '';
	}

	function cancelEditing() {
		editingKey = null;
		editValue = '';
	}

	async function saveSecret(key: string) {
		if (!editValue.trim()) return;
		saving = true;
		try {
			const res = await fetch('/api/secrets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key, value: editValue.trim() }),
			});
			const data = await res.json();
			if (data.ok) {
				editingKey = null;
				editValue = '';
				saveResult = { ok: true, key };
				await loadSecrets();
				setTimeout(() => { saveResult = null; }, 3000);
			}
		} catch { /* ignore */ }
		saving = false;
	}

	async function removeSecret(key: string) {
		try {
			await fetch('/api/secrets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'remove', key }),
			});
			await loadSecrets();
		} catch { /* ignore */ }
	}

	async function testSecret(key: string) {
		testStates = { ...testStates, [key]: { status: 'pending' } };
		try {
			const res = await fetch('/api/secrets/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key }),
			});
			const data = await res.json();
			testStates = {
				...testStates,
				[key]: {
					status: (data.status as TestStatus) ?? 'invalid',
					message: data.message,
					ok: !!data.ok,
				},
			};
		} catch (err) {
			testStates = {
				...testStates,
				[key]: { status: 'network', ok: false, message: (err as Error).message },
			};
		}
		// Auto-clear after a while so the row settles back to neutral
		const captured = key;
		setTimeout(() => {
			if (testStates[captured]?.status !== 'pending') {
				const next = { ...testStates };
				delete next[captured];
				testStates = next;
			}
		}, 8000);
	}

	function testLabel(state: TestState | undefined): string {
		if (!state) return '';
		switch (state.status) {
			case 'pending':
				return 'Testing…';
			case 'ok':
				return 'OK';
			case 'unauthorized':
				return 'Unauthorized';
			case 'invalid':
				return 'Invalid';
			case 'ratelimit':
				return 'Rate-limited';
			case 'network':
				return 'Network';
			case 'unconfigured':
				return 'Not set';
			case 'unsupported':
				return 'No test';
		}
	}

	function startAddNew() {
		addingNew = true;
		newKey = '';
		newValue = '';
	}

	function cancelAddNew() {
		addingNew = false;
		newKey = '';
		newValue = '';
	}

	async function syncFromShell() {
		syncing = true;
		try {
			// Sync every key the UI displays — both locally documented vars
			// (KNOWN_VARS) and adapter-declared vars from the API.
			const keys = Array.from(new Set(envList.map((r) => r.key)));
			const res = await fetch('/api/secrets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'sync-from-shell', keys }),
			});
			const data = await res.json();
			if (data.ok) {
				syncResult = { count: data.synced };
				await loadSecrets();
				setTimeout(() => { syncResult = null; }, 4000);
			}
		} catch { /* ignore */ }
		syncing = false;
	}

	async function saveNewSecret() {
		if (!newKey.trim() || !newValue.trim()) return;
		saving = true;
		try {
			const res = await fetch('/api/secrets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key: newKey.trim(), value: newValue.trim() }),
			});
			const data = await res.json();
			if (data.ok) {
				addingNew = false;
				newKey = '';
				newValue = '';
				await loadSecrets();
			}
		} catch { /* ignore */ }
		saving = false;
	}
</script>

<section class="mb-4">
	<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Platform Environment</h2>
			<div class="flex items-center gap-3">
				{#if syncResult}
					<span class="text-[10px] text-hub-cta font-medium">{syncResult.count} keys synced</span>
				{/if}
				<button
					onclick={syncFromShell}
					disabled={syncing}
					class="px-2 py-0.5 text-[10px] font-medium rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta transition-colors cursor-pointer disabled:opacity-40"
					title="Import API keys from shell environment into Soul Hub"
				>
					{syncing ? 'Syncing...' : 'Sync from shell'}
				</button>
				<span class="text-[10px] text-hub-dim font-medium">
					{envList.filter((e) => e.set).length}/{envList.length} configured
				</span>
			</div>
		</div>

		{#if loading}
			<div class="text-sm text-hub-dim">Loading...</div>
		{:else}
			<div class="space-y-2">
				{#each envList as entry (entry.key)}
					<div class="flex items-start gap-3 py-2 {entry !== envList[envList.length - 1] ? 'border-b border-hub-border/50' : ''}">
						<!-- Status dot -->
						<span class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0 {entry.set ? 'bg-hub-cta' : 'bg-hub-border'}"></span>

						<!-- Info -->
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2 flex-wrap">
								<span class="text-sm font-mono text-hub-text">{entry.key}</span>
								{#if entry.required}
									<span
										class="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border border-hub-cta/40 text-hub-cta"
										title={entry.declaredBy.length ? `Required by: ${entry.declaredBy.join(', ')}` : 'Required'}
									>
										Required
									</span>
								{/if}
								{#if entry.set && entry.source === 'shell'}
									<span class="text-[9px] uppercase tracking-wider text-hub-muted" title="Loaded from your shell — not yet stored in ~/.soul-hub/.env">
										via shell
									</span>
								{/if}
								{#if saveResult?.ok && saveResult.key === entry.key}
									<span class="text-[10px] text-hub-cta">Saved</span>
								{/if}
							</div>
							{#if entry.description}
								<div class="text-[11px] text-hub-dim mt-0.5">{entry.description}</div>
							{/if}
							{#if entry.declaredBy.length > 0}
								<div class="text-[10px] text-hub-muted mt-0.5">
									Required for: {entry.declaredBy.join(', ')}
								</div>
							{:else if entry.usedBy.length > 0}
								<div class="text-[10px] text-hub-muted mt-0.5">
									Used by: {entry.usedBy.join(', ')}
								</div>
							{/if}
							{#if entry.link}
								<a
									href={entry.link}
									target="_blank"
									rel="noopener noreferrer"
									class="text-[10px] text-hub-muted hover:text-hub-cta mt-0.5 inline-block"
								>
									Get key →
								</a>
							{/if}

							<!-- Inline edit -->
							{#if editingKey === entry.key}
								<div class="flex items-center gap-2 mt-2">
									<input
										type="password"
										bind:value={editValue}
										placeholder="Paste value..."
										class="flex-1 bg-hub-bg border border-hub-cta/50 rounded-md px-2.5 py-1 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
										onkeydown={(e) => { if (e.key === 'Enter') saveSecret(entry.key); if (e.key === 'Escape') cancelEditing(); }}
									/>
									<button
										onclick={() => saveSecret(entry.key)}
										disabled={saving || !editValue.trim()}
										class="px-2 py-1 text-xs font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer disabled:opacity-40"
									>
										{saving ? '...' : 'Save'}
									</button>
									<button
										onclick={cancelEditing}
										class="px-2 py-1 text-xs text-hub-muted hover:text-hub-text cursor-pointer"
									>
										Cancel
									</button>
								</div>
							{/if}
						</div>

						<!-- Actions -->
						{#if editingKey !== entry.key}
							<div class="flex items-center gap-1 flex-shrink-0">
								{#if entry.declared && entry.set}
									{@const ts = testStates[entry.key]}
									<button
										onclick={() => testSecret(entry.key)}
										disabled={ts?.status === 'pending'}
										class="px-2 py-1 text-[11px] font-medium rounded border transition-colors cursor-pointer disabled:opacity-60 {ts?.ok
											? 'border-hub-cta/60 text-hub-cta'
											: ts && ts.status !== 'pending'
												? 'border-hub-danger/60 text-hub-danger'
												: 'border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta'}"
										title={ts?.message ?? 'Verify the credential against the upstream API.'}
									>
										{ts ? testLabel(ts) : 'Test'}
									</button>
								{/if}
								<button
									onclick={() => startEditing(entry.key)}
									class="px-2 py-1 text-[11px] font-medium rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta transition-colors cursor-pointer"
								>
									{entry.set ? 'Change' : 'Set'}
								</button>
								{#if entry.set}
									<button
										onclick={() => removeSecret(entry.key)}
										class="px-2 py-1 text-[11px] font-medium rounded border border-hub-border text-hub-muted hover:text-hub-danger hover:border-hub-danger transition-colors cursor-pointer"
										aria-label="Remove {entry.key}"
									>
										<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
										</svg>
									</button>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Add new secret -->
			{#if addingNew}
				<div class="mt-3 pt-3 border-t border-hub-border space-y-2">
					<input
						type="text"
						bind:value={newKey}
						placeholder="SECRET_NAME (UPPER_SNAKE_CASE)"
						class="w-full bg-hub-bg border border-hub-border rounded-md px-2.5 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
					/>
					<input
						type="password"
						bind:value={newValue}
						placeholder="Value..."
						class="w-full bg-hub-bg border border-hub-border rounded-md px-2.5 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						onkeydown={(e) => { if (e.key === 'Enter') saveNewSecret(); if (e.key === 'Escape') cancelAddNew(); }}
					/>
					<div class="flex items-center gap-2">
						<button
							onclick={saveNewSecret}
							disabled={saving || !newKey.trim() || !newValue.trim()}
							class="px-2.5 py-1 text-xs font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer disabled:opacity-40"
						>
							{saving ? '...' : 'Add'}
						</button>
						<button
							onclick={cancelAddNew}
							class="px-2.5 py-1 text-xs text-hub-muted hover:text-hub-text cursor-pointer"
						>
							Cancel
						</button>
					</div>
				</div>
			{:else}
				<button
					onclick={startAddNew}
					class="mt-3 flex items-center gap-1.5 text-xs text-hub-muted hover:text-hub-cta transition-colors cursor-pointer"
				>
					<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
					</svg>
					Add secret
				</button>
			{/if}
		{/if}
	</div>
</section>
