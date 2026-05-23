<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type ConnectionState =
		| 'disconnected'
		| 'connecting'
		| 'qr-required'
		| 'connected'
		| 'reconnecting'
		| 'logged-out';

	interface IntentMapping {
		route: string;
		description?: string;
	}

	interface Props {
		/** Current per-channel config (full object including label/defaultFor + the
		 *  WhatsApp-specific fields that pass through the channels schema). */
		config: Record<string, unknown> & {
			enabled?: boolean;
			label?: string;
			access?: { allowFrom?: string[] };
			intentMap?: Record<string, IntentMapping & { dynamic?: boolean }>;
			worker?: { enabled?: boolean; url?: string; mainAppUrl?: string };
		};
		/** Patches are typed as `Record<string, unknown>` so the parent's
		 *  generic deep-merge handler can accept us without a typed
		 *  cross-import. The shapes we actually send are documented in the
		 *  call-sites below: `{ enabled }`, `{ access: { allowFrom } }`,
		 *  `{ intentMap }`, `{ worker: { enabled?, url?, mainAppUrl? } }`. */
		onchange: (patch: Record<string, unknown>) => void;
	}

	let { config, onchange }: Props = $props();

	// --- Live status (polled while pairing) ---

	let connState = $state<ConnectionState>('disconnected');
	let qrDataUrl = $state<string>('');
	let linkedNumber = $state<string | undefined>(undefined);
	let lastError = $state<string | undefined>(undefined);
	let mode = $state<'in-process' | 'worker'>('in-process');
	let workerError = $state<string | undefined>(undefined);
	let pollHandle: ReturnType<typeof setInterval> | null = null;

	async function fetchStatus() {
		try {
			const res = await fetch('/api/channels/whatsapp/status');
			if (!res.ok) return;
			const data = await res.json();
			connState = data.status?.state ?? 'disconnected';
			qrDataUrl = data.status?.qrDataUrl ?? '';
			linkedNumber = data.status?.linkedNumber;
			lastError = data.status?.lastError;
			mode = data.mode ?? 'in-process';
			workerError = data.workerError;
		} catch {
			/* keep last value */
		}
	}

	function shouldPollFast(): boolean {
		return connState === 'connecting' || connState === 'qr-required' || connState === 'reconnecting';
	}

	function startPolling() {
		stopPolling();
		// Fast poll while pairing, slow while idle/connected.
		const interval = shouldPollFast() ? 1500 : 8000;
		pollHandle = setInterval(() => {
			void fetchStatus().then(() => {
				const nextInterval = shouldPollFast() ? 1500 : 8000;
				if (pollHandle && nextInterval !== interval) {
					stopPolling();
					startPolling();
				}
			});
		}, interval);
	}

	function stopPolling() {
		if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
		}
	}

	let busy = $state<'login' | 'logout' | null>(null);
	let actionError = $state<string | null>(null);

	async function login() {
		busy = 'login';
		actionError = null;
		try {
			const res = await fetch('/api/channels/whatsapp/login', { method: 'POST' });
			const data = await res.json();
			// Two failure shapes: top-level `ok:false` (real error) OR `ok:true`
			// with `status.state: disconnected` carrying a `lastError` (the
			// adapter swallows config-validation failures into the status
			// object). Surface both so the user isn't left wondering why
			// nothing happened — a stale settings cache or unsaved Enable
			// toggle would otherwise look like a dead button.
			if (!data.ok) {
				actionError = data.error ?? 'Login failed.';
			} else if (data.status?.state === 'disconnected' && data.status?.lastError) {
				actionError = data.status.lastError;
			}
			await fetchStatus();
			startPolling();
		} catch (err) {
			actionError = (err as Error).message;
		} finally {
			busy = null;
		}
	}

	async function logout() {
		busy = 'logout';
		actionError = null;
		try {
			const res = await fetch('/api/channels/whatsapp/logout', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ wipeAuth: true }),
			});
			const data = await res.json();
			if (!data.ok) actionError = data.error ?? 'Logout failed.';
			await fetchStatus();
		} catch (err) {
			actionError = (err as Error).message;
		} finally {
			busy = null;
		}
	}

	onMount(() => {
		void fetchStatus();
		startPolling();
	});

	onDestroy(stopPolling);

	// --- Allowlist editor ---

	let allowFromInput = $state('');
	$effect(() => {
		// Sync from config when parent passes new config (e.g. after save).
		if (config?.access?.allowFrom) {
			allowFromInput = config.access.allowFrom.join(', ');
		}
	});

	function commitAllowFrom() {
		const list = allowFromInput
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		onchange({ access: { allowFrom: list } });
	}

	// --- Intent map editor ---

	let intentRows = $state<Array<{ token: string; route: string; description: string }>>([]);
	let intentSyncedFrom = '';

	$effect(() => {
		const incoming = JSON.stringify(config?.intentMap ?? {});
		if (incoming === intentSyncedFrom) return;
		intentSyncedFrom = incoming;
		intentRows = Object.entries(config?.intentMap ?? {}).map(([token, m]) => ({
			token,
			route: m.route ?? '',
			description: m.description ?? '',
		}));
	});

	function commitIntentMap() {
		const next: Record<string, IntentMapping & { dynamic?: boolean }> = {};
		for (const row of intentRows) {
			const token = row.token.trim();
			if (!token) continue;
			next[token] = { route: row.route.trim() };
			if (row.description.trim()) next[token].description = row.description.trim();
			// Preserve `dynamic` (Slice 1.5 smart-router opt-in) — only meaningful
			// on the `default` row, but a row-edit shouldn't silently drop it.
			const prior = config?.intentMap?.[token];
			if (prior && typeof prior.dynamic === 'boolean') next[token].dynamic = prior.dynamic;
		}
		intentSyncedFrom = JSON.stringify(next);
		onchange({ intentMap: next });
	}

	function toggleDynamicRouter(enabled: boolean) {
		// Send only the changed nested field — the server's deep-merge keeps
		// the rest of `intentMap` and the rest of `channels.whatsapp` intact.
		onchange({ intentMap: { default: { route: 'vault-chat', dynamic: enabled } } });
	}

	function addIntentRow() {
		intentRows = [...intentRows, { token: '', route: '', description: '' }];
	}

	function removeIntentRow(i: number) {
		intentRows = intentRows.filter((_, idx) => idx !== i);
		commitIntentMap();
	}

	// --- Worker toggle ---

	function toggleWorker() {
		const current = config?.worker?.enabled === true;
		onchange({
			worker: {
				...(config?.worker ?? {}),
				enabled: !current,
			},
		});
	}

	function updateWorkerUrl(value: string) {
		onchange({
			worker: { ...(config?.worker ?? {}), url: value },
		});
	}

	function updateMainAppUrl(value: string) {
		onchange({
			worker: { ...(config?.worker ?? {}), mainAppUrl: value },
		});
	}

	// --- Display helpers ---

	const stateLabel = $derived.by(() => {
		switch (connState) {
			case 'connected':
				return 'Connected';
			case 'qr-required':
				return 'Scan QR';
			case 'connecting':
				return 'Connecting…';
			case 'reconnecting':
				return 'Reconnecting…';
			case 'logged-out':
				return 'Logged out';
			default:
				return 'Disconnected';
		}
	});

	const stateColor = $derived(
		connState === 'connected'
			? 'bg-hub-cta'
			: connState === 'qr-required' || connState === 'connecting' || connState === 'reconnecting'
				? 'bg-hub-warning'
				: 'bg-hub-dim',
	);

	const stateTextColor = $derived(
		connState === 'connected'
			? 'text-hub-cta'
			: connState === 'qr-required' || connState === 'connecting' || connState === 'reconnecting'
				? 'text-hub-warning'
				: 'text-hub-dim',
	);
</script>

<section class="mb-6">
	<div class="bg-hub-surface border border-hub-border rounded-lg overflow-hidden">
		<!-- Header -->
		<div class="flex items-center justify-between p-4">
			<div class="flex items-center gap-3 min-w-0">
				<svg class="w-5 h-5 text-hub-muted flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
				</svg>
				<span class="text-sm font-medium text-hub-text">WhatsApp</span>
				<span class="flex items-center gap-1.5 text-[11px] {stateTextColor}">
					<span class="w-1.5 h-1.5 rounded-full {stateColor}"></span>
					{stateLabel}
					{#if linkedNumber}
						<span class="text-hub-dim">· +{linkedNumber}</span>
					{/if}
					{#if mode === 'worker'}
						<span class="text-hub-dim">· worker</span>
					{/if}
				</span>
			</div>

			<button
				type="button"
				role="switch"
				aria-checked={!!config.enabled}
				aria-label="Enable WhatsApp"
				onclick={() => onchange({ enabled: !config.enabled })}
				class="relative w-9 h-5 rounded-full transition-colors cursor-pointer
					{config.enabled ? 'bg-hub-cta' : 'bg-hub-border'}"
			>
				<span
					class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform
						{config.enabled ? 'translate-x-4' : 'translate-x-0'}"
				></span>
			</button>
		</div>

		{#if config.enabled}
			<div class="border-t border-hub-border px-4 pb-4 pt-3 space-y-4">
				<!-- Worker error banner -->
				{#if workerError}
					<div class="flex items-start gap-2 bg-hub-danger/10 border border-hub-danger/20 rounded-md px-3 py-2">
						<svg class="w-4 h-4 text-hub-danger flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
						</svg>
						<span class="text-xs text-hub-danger">{workerError}</span>
					</div>
				{:else if lastError && connState !== 'connected'}
					<div class="text-xs text-hub-warning">{lastError}</div>
				{/if}

				<!-- Pairing controls -->
				<div class="flex flex-wrap items-center gap-3">
					{#if connState === 'connected'}
						<button
							onclick={logout}
							disabled={busy !== null}
							class="px-3 py-1.5 text-xs font-medium rounded-md border border-hub-border text-hub-muted hover:text-hub-danger hover:border-hub-danger transition-colors cursor-pointer"
						>
							{busy === 'logout' ? 'Unlinking…' : 'Unlink device'}
						</button>
					{:else}
						<button
							onclick={login}
							disabled={busy !== null}
							class="px-3 py-1.5 text-xs font-medium rounded-md border border-hub-cta text-hub-cta hover:bg-hub-cta/10 transition-colors cursor-pointer"
						>
							{busy === 'login' ? 'Starting…' : connState === 'qr-required' ? 'Refresh QR' : 'Link via QR'}
						</button>
					{/if}
					{#if actionError}
						<span class="text-[11px] text-hub-danger">{actionError}</span>
					{/if}
				</div>

				<!-- QR display -->
				{#if connState === 'qr-required' && qrDataUrl}
					<div class="flex flex-col items-center gap-2 bg-hub-bg border border-hub-border rounded-md p-3">
						<img src={qrDataUrl} alt="WhatsApp QR" class="w-48 h-48" />
						<span class="text-[11px] text-hub-dim">
							Open WhatsApp → Settings → Linked Devices → Link a Device, then scan.
						</span>
					</div>
				{/if}

				<!-- Allowlist -->
				<div>
					<label for="wa-allow-from" class="block text-xs text-hub-muted mb-1">
						Allowed numbers (E.164, comma- or space-separated; <code>*</code> for all)
					</label>
					<input
						id="wa-allow-from"
						type="text"
						bind:value={allowFromInput}
						onblur={commitAllowFrom}
						placeholder="+9715xxxxxxxx, +1xxxxxxxxxx"
						class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
					/>
					<span class="block text-[10px] text-hub-dim mt-1">
						DMs from these numbers reach the routes layer; everything else is dropped silently.
					</span>
				</div>

				<!-- Smart router (Slice 1.5) — opt-in dynamic routing for free-form messages -->
				<div class="border-t border-hub-border pt-3">
					<label class="flex items-start justify-between gap-3 cursor-pointer">
						<div class="flex flex-col">
							<span class="text-xs text-hub-muted">Smart router for free-form messages</span>
							<span class="text-[10px] text-hub-dim leading-relaxed">
								When on, non-slash messages run through a regex pre-filter and a Gemini Flash
								fallback so phrases like "save this idea …" or "find my heartbeat notes" route
								to <code>vault-save-note</code> / <code>vault-find</code> without the slash.
								Sub-threshold confidence falls back to <code>vault-chat</code>. Decisions are
								surfaced at <code>recentRouterDecisions[]</code> on the status endpoint.
							</span>
						</div>
						<input
							type="checkbox"
							checked={config?.intentMap?.default?.dynamic === true}
							onchange={(e) => toggleDynamicRouter(e.currentTarget.checked)}
							class="mt-0.5 w-4 h-4 cursor-pointer accent-hub-cta"
						/>
					</label>
				</div>

				<!-- Intent map -->
				<div>
					<div class="flex items-center justify-between mb-2">
						<span class="block text-xs text-hub-muted">
							Intent map — slash commands route to named routes
						</span>
						<button
							onclick={addIntentRow}
							class="text-[10px] text-hub-cta hover:underline cursor-pointer"
						>
							+ add row
						</button>
					</div>
					<div class="space-y-2">
						{#each intentRows as row, i (i)}
							<div class="grid grid-cols-[1fr_1fr_2fr_auto] gap-2 items-center">
								<input
									type="text"
									bind:value={row.token}
									onblur={commitIntentMap}
									placeholder="/save or default"
									class="bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-xs text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
								/>
								<input
									type="text"
									bind:value={row.route}
									onblur={commitIntentMap}
									placeholder="route name"
									class="bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-xs text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
								/>
								<input
									type="text"
									bind:value={row.description}
									onblur={commitIntentMap}
									placeholder="optional description (shown in /help)"
									class="bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-xs text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
								/>
								<button
									onclick={() => removeIntentRow(i)}
									aria-label="Remove row"
									class="text-hub-dim hover:text-hub-danger transition-colors p-1 cursor-pointer"
								>
									<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
									</svg>
								</button>
							</div>
						{/each}
					</div>
				</div>

				<!-- Worker mode -->
				<div class="border-t border-hub-border pt-3">
					<div class="flex items-center justify-between mb-2">
						<div class="flex flex-col">
							<span class="text-xs text-hub-muted">Crash-isolated worker mode</span>
							<span class="text-[10px] text-hub-dim">
								Run Baileys in the separate <code>soul-hub-whatsapp</code> PM2 app so a Baileys
								crash doesn't take down the web UI.
							</span>
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={!!config.worker?.enabled}
							aria-label="Worker mode"
							onclick={toggleWorker}
							class="relative w-9 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0
								{config.worker?.enabled ? 'bg-hub-cta' : 'bg-hub-border'}"
						>
							<span
								class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform
									{config.worker?.enabled ? 'translate-x-4' : 'translate-x-0'}"
							></span>
						</button>
					</div>
					{#if config.worker?.enabled}
						<div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
							<div>
								<label for="wa-worker-url" class="block text-[10px] text-hub-dim mb-1">Worker URL</label>
								<input
									id="wa-worker-url"
									type="text"
									value={config.worker?.url ?? 'http://127.0.0.1:2401'}
									oninput={(e) => updateWorkerUrl((e.target as HTMLInputElement).value)}
									class="w-full bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-xs text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
								/>
							</div>
							<div>
								<label for="wa-main-url" class="block text-[10px] text-hub-dim mb-1">
									Main app URL (worker callback)
								</label>
								<input
									id="wa-main-url"
									type="text"
									value={config.worker?.mainAppUrl ?? 'http://127.0.0.1:2400'}
									oninput={(e) => updateMainAppUrl((e.target as HTMLInputElement).value)}
									class="w-full bg-hub-bg border border-hub-border rounded-md px-2 py-1 text-xs text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
								/>
							</div>
						</div>
						<span class="block text-[10px] text-hub-warning mt-2">
							Restart PM2 (<code>npm run prod:restart</code>) after toggling so the main app
							re-reads settings.json and the worker reflects the new mode.
						</span>
					{/if}
				</div>
			</div>
		{:else}
			<div class="border-t border-hub-border px-4 py-3">
				<span class="text-xs text-hub-dim">Enable to configure WhatsApp pairing.</span>
			</div>
		{/if}
	</div>
</section>
