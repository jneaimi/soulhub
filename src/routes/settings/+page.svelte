<script lang="ts">
	import { onMount } from 'svelte';
	import ChannelCard from '$lib/components/ChannelCard.svelte';
	import PlatformEnv from '$lib/components/PlatformEnv.svelte';
	import ConnectionsSection from '$lib/components/settings/ConnectionsSection.svelte';
	import ExplorerRootsSection from '$lib/components/settings/ExplorerRootsSection.svelte';
	import InboxFilterSection from '$lib/components/settings/InboxFilterSection.svelte';
	import RoutesSection from '$lib/components/settings/RoutesSection.svelte';
	import WhatsAppSection from '$lib/components/settings/WhatsAppSection.svelte';
	import TelegramSection from '$lib/components/settings/TelegramSection.svelte';
	import HeartbeatSection from '$lib/components/settings/HeartbeatSection.svelte';

	type ChannelAction = 'send' | 'prompt' | 'listen';

	interface ChannelMetaItem {
		id: string;
		name: string;
		icon: string;
		fields: { key: string; label: string; type: string; env: string }[];
		actions: ChannelAction[];
		configured: boolean;
		missingEnv: string[];
	}

	interface ChannelConfigItem {
		enabled: boolean;
		label: string;
		defaultFor: ChannelAction[];
		// WhatsApp passthrough — generic channels don't carry these so the
		// type stays optional. The save POST round-trips arbitrary fields
		// because the server-side schema uses `passthrough()` per channel.
		[extra: string]: unknown;
	}

	// Settings state
	let fontSize = $state(13);
	let cols = $state(120);
	let rows = $state(40);
	let cursorBlink = $state(true);

	let defaultPanel = $state<'code' | 'closed'>('code');
	let panelWidth = $state(260);

	let devDir = $state('~/dev');
	let catalogDir = $state('~/dev/soul-hub/catalog');
	let claudeBinary = $state('~/.local/bin/claude');

	// Channels state
	let channelMetas = $state<ChannelMetaItem[]>([]);
	let channelConfigs = $state<Record<string, ChannelConfigItem>>({});

	// Heartbeat — top-level orchestration config (ADR-001 P3), no longer nested
	// under the WhatsApp channel.
	let heartbeatConfig = $state<Record<string, unknown>>({});

	// Operator-notification channels (which channels notifyOperator fans out to).
	let operatorChannels = $state<('telegram' | 'whatsapp')[]>(['telegram']);
	// WhatsApp is only deliverable when the operator number (heartbeat delivery
	// target) is set — gate the toggle on it so we never offer a dead channel.
	const whatsappTarget = $derived(
		(heartbeatConfig?.delivery as { target?: string } | undefined)?.target ?? '',
	);
	const whatsappNotifyReady = $derived(whatsappTarget.length > 0);

	// System health (read-only)
	let serverHealth = $state<{
		nodeRunning: boolean;
		tunnelRunning: boolean;
		port: number;
		domain: string;
	} | null>(null);

	// UI state
	let saving = $state(false);
	let toast = $state<{ message: string; type: 'success' | 'error' } | null>(null);
	let dirty = $state(false);

	// Vault digest preview state
	let digestPreview = $state<string | null>(null);
	let digestLoading = $state<'preview' | 'check' | null>(null);
	let digestLoaded = $state(false);
	let digestError = $state<string | null>(null);

	async function loadDigestPreview(forceCheck: boolean) {
		digestLoading = forceCheck ? 'check' : 'preview';
		digestError = null;
		try {
			const res = await fetch('/api/system/health', { method: forceCheck ? 'POST' : 'GET' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			digestPreview = data.digestPreview ?? null;
			digestLoaded = true;
		} catch (err) {
			digestError = (err as Error).message;
		} finally {
			digestLoading = null;
		}
	}

	function markDirty() {
		dirty = true;
	}

	onMount(async () => {
		// Load settings from server
		try {
			const res = await fetch('/api/settings');
			if (res.ok) {
				const data = await res.json();
				if (data.terminal) {
					fontSize = data.terminal.fontSize ?? 13;
					cols = data.terminal.cols ?? 120;
					rows = data.terminal.rows ?? 40;
					cursorBlink = data.terminal.cursorBlink ?? true;
				}
				if (data.interface) {
					defaultPanel = data.interface.defaultPanel ?? 'code';
					panelWidth = data.interface.panelWidth ?? 260;
				}
				if (data.paths) {
					devDir = data.paths.devDir ?? '~/dev';
					catalogDir = data.paths.catalogDir ?? '~/dev/soul-hub/catalog';
					claudeBinary = data.paths.claudeBinary ?? '~/.local/bin/claude';
				}
				if (data.channels) {
					channelConfigs = data.channels;
				}
				if (data.heartbeat) {
					heartbeatConfig = data.heartbeat;
				}
				if (data.notifications?.operatorChannels?.length) {
					operatorChannels = data.notifications.operatorChannels;
				}
			}
		} catch { /* use defaults */ }

		// Load channel adapter metadata
		try {
			const res = await fetch('/api/channels/meta');
			if (res.ok) {
				channelMetas = await res.json();
				// Ensure all adapters have a config entry (use defaults for new ones)
				for (const m of channelMetas) {
					if (!channelConfigs[m.id]) {
						channelConfigs[m.id] = {
							enabled: m.configured,
							label: m.name,
							defaultFor: m.actions.includes('send') ? ['send'] : [],
						};
					}
				}
			}
		} catch { /* ignore */ }

		// Load UI overrides from localStorage
		const prefs = localStorage.getItem('soul-hub-prefs');
		if (prefs) {
			try {
				const p = JSON.parse(prefs);
				if (p.fontSize) fontSize = p.fontSize;
				if (p.cursorBlink !== undefined) cursorBlink = p.cursorBlink;
				if (p.defaultPanel) defaultPanel = p.defaultPanel;
				if (p.panelWidth) panelWidth = p.panelWidth;
			} catch { /* ignore */ }
		}

		// Load system health
		try {
			const res = await fetch('/api/system-health');
			if (res.ok) {
				const data = await res.json();
				serverHealth = data.server;
			}
		} catch { /* ignore */ }
	});

	async function save() {
		saving = true;
		toast = null;

		try {
			// Save to settings.json (paths + terminal + interface)
			const res = await fetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					terminal: { fontSize, cols, rows, cursorBlink },
					interface: { defaultPanel, panelWidth },
					paths: { devDir, catalogDir, claudeBinary },
					channels: channelConfigs,
					heartbeat: heartbeatConfig,
					notifications: { operatorChannels },
				}),
			});

			if (!res.ok) throw new Error('Failed to save');

			// Save UI prefs to localStorage
			localStorage.setItem('soul-hub-prefs', JSON.stringify({
				fontSize, cursorBlink, defaultPanel, panelWidth,
			}));

			dirty = false;
			toast = { message: 'Settings saved', type: 'success' };
		} catch {
			toast = { message: 'Failed to save settings', type: 'error' };
		} finally {
			saving = false;
			setTimeout(() => { toast = null; }, 3000);
		}
	}

	function handleChannelChange(id: string, cfg: ChannelConfigItem) {
		channelConfigs = { ...channelConfigs, [id]: cfg };
		markDirty();
	}

	/** Toggle an operator-notification channel. Enforces the schema's min-1:
	 *  unchecking the last remaining channel is a no-op (it stays selected). */
	function toggleOperatorChannel(ch: 'telegram' | 'whatsapp') {
		const has = operatorChannels.includes(ch);
		const next = has ? operatorChannels.filter((c) => c !== ch) : [...operatorChannels, ch];
		if (next.length === 0) return; // keep at least one
		operatorChannels = next;
		markDirty();
	}

	/** WhatsApp section emits patch objects (not full config replacements) so
	 *  pairing controls can edit one slice at a time without clobbering the
	 *  rest. We deep-merge the patch into the current `whatsapp` config. */
	function handleWhatsAppPatch(patch: Record<string, unknown>) {
		channelConfigs = { ...channelConfigs, whatsapp: deepMergeChannelPatch('whatsapp', 'WhatsApp', patch) };
		markDirty();
	}

	function handleTelegramPatch(patch: Record<string, unknown>) {
		channelConfigs = { ...channelConfigs, telegram: deepMergeChannelPatch('telegram', 'Telegram', patch) };
		markDirty();
	}

	/** HeartbeatSection emits `{ heartbeat: { …full config } }` — it always sends
	 *  the full merged object, so we replace wholesale. */
	function handleHeartbeatPatch(patch: Record<string, unknown>) {
		const next = patch.heartbeat as Record<string, unknown> | undefined;
		if (next) heartbeatConfig = next;
		markDirty();
	}

	function deepMergeChannelPatch(id: string, defaultLabel: string, patch: Record<string, unknown>): ChannelConfigItem {
		const current = (channelConfigs[id] as Record<string, unknown>) ?? {
			enabled: false,
			label: defaultLabel,
			defaultFor: [],
		};
		const next: Record<string, unknown> = { ...current };
		for (const [key, value] of Object.entries(patch)) {
			if (
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				current[key] &&
				typeof current[key] === 'object'
			) {
				next[key] = { ...(current[key] as Record<string, unknown>), ...(value as object) };
			} else {
				next[key] = value;
			}
		}
		return next as ChannelConfigItem;
	}

	function resetToDefaults() {
		fontSize = 13;
		cols = 120;
		rows = 40;
		cursorBlink = true;
		defaultPanel = 'code';
		panelWidth = 260;
		devDir = '~/dev';
		catalogDir = '~/dev/soul-hub/catalog';
		claudeBinary = '~/.local/bin/claude';
		dirty = true;
	}

</script>

<svelte:head>
	<title>Settings — Soul Hub</title>
</svelte:head>

<!-- Toast notification -->
{#if toast}
	<div
		class="fixed top-4 right-4 z-50 px-4 py-3 rounded-lg border-l-4 text-sm font-medium shadow-lg transition-all
			{toast.type === 'success' ? 'bg-hub-surface border-hub-cta text-hub-cta' : 'bg-hub-surface border-hub-danger text-hub-danger'}"
	>
		{toast.message}
	</div>
{/if}

<div class="h-full flex flex-col">
	<!-- Header -->
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="max-w-3xl mx-auto flex items-center gap-3">
			<h1 class="text-lg font-semibold text-hub-text">Settings</h1>
			<div class="flex-1"></div>
			<button
				onclick={save}
				disabled={saving || !dirty}
				class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors cursor-pointer
					{dirty ? 'bg-hub-cta text-black hover:bg-hub-cta-hover' : 'bg-hub-card text-hub-dim cursor-not-allowed'}"
			>
				{saving ? 'Saving...' : 'Save'}
			</button>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8">
	<div class="max-w-3xl mx-auto">

		<!-- Terminal section -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-4">Terminal</h2>
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label for="fontSize" class="block text-xs text-hub-muted mb-1">Font size (px)</label>
						<input
							id="fontSize"
							type="number"
							bind:value={fontSize}
							oninput={markDirty}
							min="8"
							max="24"
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div>
						<label for="cols" class="block text-xs text-hub-muted mb-1">Columns</label>
						<input
							id="cols"
							type="number"
							bind:value={cols}
							oninput={markDirty}
							min="40"
							max="300"
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div>
						<label for="rows" class="block text-xs text-hub-muted mb-1">Rows</label>
						<input
							id="rows"
							type="number"
							bind:value={rows}
							oninput={markDirty}
							min="10"
							max="100"
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div class="flex items-center gap-3 pt-4">
						<label for="cursorBlink" class="text-xs text-hub-muted">Cursor blink</label>
						<button
							id="cursorBlink"
							type="button"
							role="switch"
							aria-checked={cursorBlink}
							onclick={() => { cursorBlink = !cursorBlink; markDirty(); }}
							class="relative w-9 h-5 rounded-full transition-colors cursor-pointer
								{cursorBlink ? 'bg-hub-cta' : 'bg-hub-border'}"
						>
							<span
								class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform
									{cursorBlink ? 'translate-x-4' : 'translate-x-0'}"
							></span>
						</button>
					</div>
				</div>
			</div>
		</section>

		<!-- Interface section -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-4">Interface</h2>
				<div class="grid grid-cols-2 gap-4">
					<div>
						<label for="defaultPanel" class="block text-xs text-hub-muted mb-1">Default panel</label>
						<select
							id="defaultPanel"
							bind:value={defaultPanel}
							onchange={markDirty}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50 cursor-pointer"
						>
							<option value="code">Code</option>
							<option value="closed">Closed</option>
						</select>
					</div>
					<div>
						<label for="panelWidth" class="block text-xs text-hub-muted mb-1">Panel width (px)</label>
						<input
							id="panelWidth"
							type="number"
							bind:value={panelWidth}
							oninput={markDirty}
							min="180"
							max="500"
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
				</div>
			</div>
		</section>

		<!-- Paths section -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Paths</h2>
					<span class="text-[10px] text-hub-warning font-medium">Requires restart</span>
				</div>
				<div class="space-y-3">
					<div>
						<label for="devDir" class="block text-xs text-hub-muted mb-1">Dev projects</label>
						<input
							id="devDir"
							type="text"
							bind:value={devDir}
							oninput={markDirty}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div>
						<label for="catalogDir" class="block text-xs text-hub-muted mb-1">Catalog</label>
						<input
							id="catalogDir"
							type="text"
							bind:value={catalogDir}
							oninput={markDirty}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
					<div>
						<label for="claudeBinary" class="block text-xs text-hub-muted mb-1">Claude binary</label>
						<input
							id="claudeBinary"
							type="text"
							bind:value={claudeBinary}
							oninput={markDirty}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</div>
				</div>
			</div>
		</section>

		<!-- File Explorer Roots — runtime mutable, no save/restart needed -->
		<ExplorerRootsSection />

		<!-- Server section (read-only) -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Server</h2>
					<span class="text-[10px] text-hub-dim font-medium">Read only</span>
				</div>
				{#if serverHealth}
					<div class="grid grid-cols-2 gap-3 text-sm">
						<div class="flex items-center gap-2">
							<span class="text-hub-muted">Port</span>
							<span class="text-hub-text font-mono">{serverHealth.port}</span>
						</div>
						<div class="flex items-center gap-2">
							<span class="text-hub-muted">Domain</span>
							<span class="text-hub-text font-mono text-xs">{serverHealth.domain}</span>
						</div>
						<div class="flex items-center gap-2">
							<span class="w-2 h-2 rounded-full {serverHealth.nodeRunning ? 'bg-hub-cta' : 'bg-hub-danger'}"></span>
							<span class="text-hub-muted">Node</span>
							<span class="text-hub-text">{serverHealth.nodeRunning ? 'Running' : 'Stopped'}</span>
						</div>
						<div class="flex items-center gap-2">
							<span class="w-2 h-2 rounded-full {serverHealth.tunnelRunning ? 'bg-hub-cta' : 'bg-hub-danger'}"></span>
							<span class="text-hub-muted">Tunnel</span>
							<span class="text-hub-text">{serverHealth.tunnelRunning ? 'Connected' : 'Disconnected'}</span>
						</div>
					</div>
				{:else}
					<div class="text-sm text-hub-dim">Loading...</div>
				{/if}
			</div>
		</section>

		<!-- Vault Health Digest section -->
		<section class="mb-6">
			<div class="bg-hub-surface border border-hub-border rounded-lg p-4">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Vault Health Digest</h2>
					<span class="text-[10px] text-hub-dim font-medium">Telegram preview</span>
				</div>
				<p class="text-xs text-hub-dim mb-3">
					Preview the message body that the auto-fix cycle would send to Telegram. <em>Preview last</em> shows the most recent report; <em>Force check + preview</em> runs a fresh detection now.
				</p>
				<div class="flex gap-2 mb-3">
					<button
						type="button"
						class="px-3 py-1.5 text-xs font-medium rounded border border-hub-border hover:bg-hub-bg disabled:opacity-50"
						disabled={digestLoading !== null}
						onclick={() => loadDigestPreview(false)}
					>{digestLoading === 'preview' ? 'Loading…' : 'Preview last'}</button>
					<button
						type="button"
						class="px-3 py-1.5 text-xs font-medium rounded border border-hub-border hover:bg-hub-bg disabled:opacity-50"
						disabled={digestLoading !== null}
						onclick={() => loadDigestPreview(true)}
					>{digestLoading === 'check' ? 'Running…' : 'Force check + preview'}</button>
				</div>
				{#if digestError}
					<div class="text-sm text-hub-danger">Error: {digestError}</div>
				{:else if !digestLoaded}
					<div class="text-xs text-hub-dim">Click a button above to load.</div>
				{:else if digestPreview === null}
					<div class="text-xs text-hub-dim">Silent — nothing to send (no auto-fixes and no issues this cycle).</div>
				{:else}
					<pre class="text-xs text-hub-text bg-hub-bg border border-hub-border rounded p-3 whitespace-pre-wrap font-mono overflow-x-auto">{digestPreview}</pre>
				{/if}
			</div>
		</section>

		<!-- Platform Environment section -->
		<PlatformEnv />

		<!-- OAuth Connections (Gmail, Outlook) -->
		<ConnectionsSection />

		<!-- Inbox Layer 2 filter — read-only worker + classifier stats -->
		<InboxFilterSection />

		<!-- Channels section -->
		{#if channelMetas.length > 0}
			<section class="mb-6">
				<div class="mb-2">
					<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider px-1">Channels</h2>
				</div>
				<div class="space-y-3">
					{#each channelMetas.filter((m) => m.id !== 'whatsapp' && m.id !== 'telegram') as meta (meta.id)}
						<ChannelCard
							{meta}
							config={channelConfigs[meta.id] || { enabled: false, label: meta.name, defaultFor: [] }}
							onchange={handleChannelChange}
						/>
					{/each}
				</div>
			</section>

			<!-- WhatsApp gets its own section: pairing UI, allowlist, intent map, worker mode. -->
			{#if channelMetas.some((m) => m.id === 'whatsapp')}
				<WhatsAppSection
					config={(channelConfigs.whatsapp as Record<string, unknown>) ?? {
						enabled: false,
						label: 'WhatsApp',
						defaultFor: [],
					}}
					onchange={handleWhatsAppPatch}
				/>
			{/if}

			<!-- Telegram: bot identity, webhook, allowlist, intent map. -->
			{#if channelMetas.some((m) => m.id === 'telegram')}
				<TelegramSection
					config={(channelConfigs.telegram as Record<string, unknown>) ?? {
						enabled: false,
						label: 'Telegram',
						defaultFor: ['send'],
					}}
					onchange={handleTelegramPatch}
				/>
			{/if}

			<!-- Heartbeat: proactive ambient-agent loop (ADR-001). Promoted to its
				 own top-level section — it's an orchestration primitive, and its
				 delivery channel is configurable, not WhatsApp-bound. -->
			<section class="mb-6">
				<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Heartbeat</h2>
				<HeartbeatSection config={heartbeatConfig} onchange={handleHeartbeatPatch} />
			</section>

			<!-- Operator notifications: which channels proactive operator messages
				 (digests, anomaly alerts, audit nudges) fan out to. -->
			<section class="mb-6">
				<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-3">Operator Notifications</h2>
				<div class="rounded-lg border border-hub-border bg-hub-surface p-4 space-y-3">
					<p class="text-xs text-hub-dim">
						Channels that proactive operator messages (digests, anomaly alerts, audit nudges)
						are delivered to. At least one is required.
					</p>
					<label class="flex items-center gap-2 text-sm text-hub-text cursor-pointer">
						<input
							type="checkbox"
							checked={operatorChannels.includes('telegram')}
							onchange={() => toggleOperatorChannel('telegram')}
						/>
						Telegram
					</label>
					<label
						class="flex items-center gap-2 text-sm cursor-pointer {whatsappNotifyReady
							? 'text-hub-text'
							: 'text-hub-dim opacity-60 cursor-not-allowed'}"
					>
						<input
							type="checkbox"
							disabled={!whatsappNotifyReady}
							checked={operatorChannels.includes('whatsapp')}
							onchange={() => toggleOperatorChannel('whatsapp')}
						/>
						WhatsApp
						{#if !whatsappNotifyReady}
							<span class="text-[11px] text-hub-dim"
								>— set the Heartbeat WhatsApp delivery target above to enable</span
							>
						{/if}
					</label>
				</div>
			</section>

			<!-- Routes layer status + per-route Test buttons. -->
			<RoutesSection />
		{/if}

		<!-- Reset -->
		<div class="flex justify-end">
			<button
				onclick={resetToDefaults}
				class="text-xs text-hub-dim hover:text-hub-muted transition-colors cursor-pointer"
			>
				Reset to defaults
			</button>
		</div>
	</div>
	</div>
</div>
