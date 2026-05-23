<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type HeartbeatStatus =
		| 'sent'
		| 'ack'
		| 'skipped_empty'
		| 'gated_active_hours'
		| 'gated_cap'
		| 'gated_mute'
		| 'error';

	interface LogEntry {
		ts: number;
		target: string;
		taskName?: string;
		status: HeartbeatStatus;
		text?: string;
		tokensIn?: number;
		tokensOut?: number;
		model?: string;
	}

	interface ActiveHours {
		start: string;
		end: string;
		timezone: string;
	}

	interface DeliveryConfig {
		channel?: string;
		target?: string;
	}

	interface HeartbeatConfig {
		enabled?: boolean;
		delivery?: DeliveryConfig;
		soulPath?: string;
		checklistPath?: string;
		activeHours?: ActiveHours;
		maxPerDay?: number;
		muteUntil?: string | null;
		ackMaxChars?: number;
		model?: string;
	}

	interface Props {
		config: HeartbeatConfig;
		/** Emit a `{ heartbeat: { …patch } }` envelope so the settings page
		 *  deep-merges into the top-level `heartbeat` key (ADR-001 P3). */
		onchange: (patch: Record<string, unknown>) => void;
	}

	let { config, onchange }: Props = $props();

	const DEFAULTS = {
		channel: 'whatsapp',
		soulPath: 'operations/soul.md',
		checklistPath: 'operations/whatsapp/HEARTBEAT.md',
		activeHours: { start: '08:00', end: '23:00', timezone: 'Asia/Dubai' },
		maxPerDay: 3,
		ackMaxChars: 300,
		model: 'gemini:gemini-2.5-flash',
	};

	// Registered heartbeat delivery channels (ADR-001 P3 — the operator can move
	// the heartbeat to any channel with an adapter). Fetched once; falls back to
	// the configured channel if the endpoint is unavailable.
	let channels = $state<string[]>([]);
	async function fetchChannels() {
		try {
			const res = await fetch('/api/heartbeat/channels');
			if (!res.ok) return;
			const data = await res.json();
			if (Array.isArray(data.channels)) channels = data.channels;
		} catch {
			/* keep fallback */
		}
	}

	const channelOptions = $derived.by(() => {
		const current = config?.delivery?.channel ?? DEFAULTS.channel;
		const set = new Set(channels.length > 0 ? channels : [current]);
		set.add(current);
		return Array.from(set).sort();
	});

	function patchDelivery(patch: Partial<DeliveryConfig>) {
		onchange({
			heartbeat: {
				...(config ?? {}),
				delivery: { ...(config?.delivery ?? {}), ...patch },
			},
		});
	}

	interface RuntimeStatus {
		withinActiveHours: boolean;
		muteRemainingMs: number | null;
		dailyCount: number;
		dailyCap: number;
		scheduleDescription: string;
	}

	let entries = $state<LogEntry[]>([]);
	let logBusy = $state(false);
	let logError = $state<string | null>(null);

	let runBusy = $state(false);
	let runResult = $state<{ status: HeartbeatStatus; text?: string } | null>(null);
	let runError = $state<string | null>(null);

	let showAdvanced = $state(false);
	let runtime = $state<RuntimeStatus | null>(null);

	let pollHandle: ReturnType<typeof setInterval> | null = null;

	async function fetchLog() {
		logBusy = true;
		logError = null;
		try {
			const res = await fetch('/api/channels/whatsapp/heartbeat/log?limit=8');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			entries = data.entries ?? [];
		} catch (err) {
			logError = (err as Error).message;
		} finally {
			logBusy = false;
		}
	}

	async function fetchRuntime() {
		try {
			const res = await fetch('/api/channels/whatsapp/heartbeat/status');
			if (!res.ok) return;
			const data = await res.json();
			if (!data.ok) return;
			runtime = {
				withinActiveHours: data.withinActiveHours,
				muteRemainingMs: data.muteRemainingMs,
				dailyCount: data.dailyCount,
				dailyCap: data.dailyCap,
				scheduleDescription: data.scheduleDescription,
			};
		} catch {
			/* keep last value */
		}
	}

	async function runNow() {
		runBusy = true;
		runResult = null;
		runError = null;
		try {
			const res = await fetch('/api/channels/whatsapp/heartbeat/wake', { method: 'POST' });
			const data = await res.json();
			if (!data.ok) throw new Error(data.error ?? 'Run failed');
			runResult = { status: data.status, text: data.text };
			await Promise.all([fetchLog(), fetchRuntime()]);
		} catch (err) {
			runError = (err as Error).message;
		} finally {
			runBusy = false;
		}
	}

	function patchHeartbeat(patch: Record<string, unknown>) {
		onchange({ heartbeat: { ...(config ?? {}), ...patch } });
	}

	function patchActiveHours(patch: Partial<ActiveHours>) {
		const current = config?.activeHours ?? DEFAULTS.activeHours;
		onchange({
			heartbeat: {
				...(config ?? {}),
				activeHours: { ...current, ...patch },
			},
		});
	}

	function setMute(durationMs: number | null) {
		const muteUntil = durationMs === null ? null : new Date(Date.now() + durationMs).toISOString();
		patchHeartbeat({ muteUntil });
	}

	/** Convert a `<input type="datetime-local">` value (e.g. "2026-05-04T08:30")
	 *  into a UTC ISO string the schema accepts. Empty string clears mute. */
	function setMuteUntilLocal(localValue: string) {
		if (!localValue) {
			patchHeartbeat({ muteUntil: null });
			return;
		}
		const parsed = Date.parse(localValue);
		if (Number.isNaN(parsed)) return;
		patchHeartbeat({ muteUntil: new Date(parsed).toISOString() });
	}

	const muteUntilLocalValue = $derived.by(() => {
		const v = config?.muteUntil;
		if (!v) return '';
		const ms = Date.parse(v);
		if (Number.isNaN(ms) || ms < Date.now()) return '';
		// `datetime-local` expects "YYYY-MM-DDTHH:mm" in the user's local TZ.
		const d = new Date(ms);
		const pad = (n: number) => n.toString().padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	});

	const muteState = $derived.by(() => {
		const v = config?.muteUntil;
		if (!v) return null;
		const until = Date.parse(v);
		if (Number.isNaN(until) || until < Date.now()) return null;
		const remainMs = until - Date.now();
		const hours = Math.ceil(remainMs / 3_600_000);
		return hours <= 24 ? `${hours}h left` : `${Math.ceil(hours / 24)}d left`;
	});

	function formatTime(ts: number): string {
		return new Date(ts).toLocaleString('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			day: '2-digit',
			month: '2-digit',
		});
	}

	const STATUS_LABELS: Record<HeartbeatStatus, { label: string; tone: string }> = {
		sent: { label: 'sent', tone: 'text-hub-cta' },
		ack: { label: 'ack', tone: 'text-hub-dim' },
		skipped_empty: { label: 'skipped', tone: 'text-hub-dim' },
		gated_active_hours: { label: 'gated · hours', tone: 'text-hub-warning' },
		gated_cap: { label: 'gated · cap', tone: 'text-hub-warning' },
		gated_mute: { label: 'gated · mute', tone: 'text-hub-warning' },
		error: { label: 'error', tone: 'text-hub-danger' },
	};

	onMount(() => {
		void fetchChannels();
		if (config?.enabled) {
			void fetchLog();
			void fetchRuntime();
			pollHandle = setInterval(() => {
				void fetchLog();
				void fetchRuntime();
			}, 60_000);
		}
	});

	onDestroy(() => {
		if (pollHandle) clearInterval(pollHandle);
	});

	$effect(() => {
		// Refetch when the section is toggled on; clear when off.
		if (config?.enabled && entries.length === 0 && !logBusy) {
			void fetchLog();
			void fetchRuntime();
		}
	});
</script>

<div class="border border-hub-border rounded-md bg-hub-bg/40">
	<div class="flex items-center justify-between px-3 py-2.5">
		<div class="flex items-center gap-2 min-w-0">
			<svg class="w-4 h-4 text-hub-muted flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
			</svg>
			<span class="text-xs font-medium text-hub-text">Heartbeat</span>
			<span class="text-[11px] text-hub-dim">proactive nudges</span>
			{#if muteState}
				<span class="text-[11px] text-hub-warning">· muted ({muteState})</span>
			{/if}
		</div>

		<button
			type="button"
			role="switch"
			aria-checked={!!config?.enabled}
			aria-label="Enable heartbeat"
			onclick={() => patchHeartbeat({ enabled: !config?.enabled })}
			class="relative w-9 h-5 rounded-full transition-colors cursor-pointer
				{config?.enabled ? 'bg-hub-cta' : 'bg-hub-border'}"
		>
			<span
				class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform
					{config?.enabled ? 'translate-x-4' : 'translate-x-0'}"
			></span>
		</button>
	</div>

	{#if config?.enabled}
		<div class="border-t border-hub-border px-3 pb-3 pt-2.5 space-y-3">
			<!-- Runtime status line — would-fire-now check + cap counter -->
			{#if runtime}
				<div class="flex flex-wrap items-center gap-2 text-[11px]">
					{#if muteState}
						<span class="text-hub-warning">Muted ({muteState})</span>
					{:else if !runtime.withinActiveHours}
						<span class="text-hub-warning">Outside active hours</span>
					{:else if runtime.dailyCount >= runtime.dailyCap}
						<span class="text-hub-warning">Daily cap reached</span>
					{:else}
						<span class="text-hub-cta">Active</span>
					{/if}
					<span class="text-hub-dim">·</span>
					<span class="text-hub-muted font-mono">{runtime.dailyCount}/{runtime.dailyCap} today</span>
					<span class="text-hub-dim">·</span>
					<span class="text-hub-dim truncate">{runtime.scheduleDescription}</span>
				</div>
			{/if}

			<!-- Cadence is owned by the scheduler `heartbeat` task (ADR-001 P3) —
				 edit it on the Scheduler page, not here. -->

			<!-- Delivery binding — channel + recipient (ADR-001 P3). -->
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div>
					<label for="hb-channel" class="block text-[11px] text-hub-muted mb-1">
						Delivery channel
					</label>
					<select
						id="hb-channel"
						value={config?.delivery?.channel ?? DEFAULTS.channel}
						onchange={(e) => patchDelivery({ channel: (e.currentTarget as HTMLSelectElement).value })}
						class="w-full px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
					>
						{#each channelOptions as ch (ch)}
							<option value={ch}>{ch}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="hb-target" class="block text-[11px] text-hub-muted mb-1">
						Recipient
					</label>
					<input
						id="hb-target"
						type="text"
						value={config?.delivery?.target ?? ''}
						placeholder="+9715XXXXXXXX"
						oninput={(e) => patchDelivery({ target: (e.currentTarget as HTMLInputElement).value || undefined })}
						class="w-full px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
					/>
				</div>
			</div>

			<!-- Active hours -->
			<div>
				<label class="block text-[11px] text-hub-muted mb-1">Active hours</label>
				<div class="grid grid-cols-3 gap-2">
					<input
						type="text"
						value={config?.activeHours?.start ?? DEFAULTS.activeHours.start}
						placeholder="08:00"
						aria-label="Start time"
						oninput={(e) => patchActiveHours({ start: (e.currentTarget as HTMLInputElement).value })}
						class="px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
					/>
					<input
						type="text"
						value={config?.activeHours?.end ?? DEFAULTS.activeHours.end}
						placeholder="23:00"
						aria-label="End time"
						oninput={(e) => patchActiveHours({ end: (e.currentTarget as HTMLInputElement).value })}
						class="px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
					/>
					<input
						type="text"
						value={config?.activeHours?.timezone ?? DEFAULTS.activeHours.timezone}
						placeholder="Asia/Dubai"
						aria-label="Timezone"
						oninput={(e) => patchActiveHours({ timezone: (e.currentTarget as HTMLInputElement).value })}
						class="px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
					/>
				</div>
			</div>

			<!-- Cap + model -->
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div>
					<label for="hb-cap" class="block text-[11px] text-hub-muted mb-1">Daily cap</label>
					<input
						id="hb-cap"
						type="number"
						min="1"
						max="20"
						value={config?.maxPerDay ?? DEFAULTS.maxPerDay}
						oninput={(e) => patchHeartbeat({ maxPerDay: Number((e.currentTarget as HTMLInputElement).value) })}
						class="w-full px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
					/>
				</div>
				<div>
					<label for="hb-model" class="block text-[11px] text-hub-muted mb-1">Model</label>
					<input
						id="hb-model"
						type="text"
						list="hb-model-suggestions"
						value={config?.model ?? DEFAULTS.model}
						oninput={(e) => patchHeartbeat({ model: (e.currentTarget as HTMLInputElement).value })}
						class="w-full px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
					/>
					<datalist id="hb-model-suggestions">
						<option value="gemini:gemini-2.5-flash"></option>
						<option value="gemini:gemini-2.5-flash-lite"></option>
						<option value="claude-cli:claude-sonnet-4-6"></option>
						<option value="anthropic:claude-haiku-4-5-20251001"></option>
						<option value="openrouter:anthropic/claude-sonnet-4.6"></option>
					</datalist>
				</div>
			</div>

			<!-- Mute controls -->
			<div>
				<label class="block text-[11px] text-hub-muted mb-1">
					Mute {muteState ? `· ${muteState}` : ''}
				</label>
				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						onclick={() => setMute(3_600_000)}
						class="px-2.5 py-1 text-[11px] rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-text transition-colors cursor-pointer"
					>
						1h
					</button>
					<button
						type="button"
						onclick={() => setMute(86_400_000)}
						class="px-2.5 py-1 text-[11px] rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-text transition-colors cursor-pointer"
					>
						24h
					</button>
					<button
						type="button"
						onclick={() => setMute(7 * 86_400_000)}
						class="px-2.5 py-1 text-[11px] rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-text transition-colors cursor-pointer"
					>
						7d
					</button>
					{#if muteState}
						<button
							type="button"
							onclick={() => setMute(null)}
							class="px-2.5 py-1 text-[11px] rounded border border-hub-cta text-hub-cta hover:bg-hub-cta/10 transition-colors cursor-pointer"
						>
							Resume now
						</button>
					{/if}
				</div>
				<div class="mt-2">
					<label for="hb-mute-until" class="block text-[10px] text-hub-dim mb-1">
						Or mute until a specific time
					</label>
					<input
						id="hb-mute-until"
						type="datetime-local"
						value={muteUntilLocalValue}
						oninput={(e) => setMuteUntilLocal((e.currentTarget as HTMLInputElement).value)}
						class="px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
					/>
				</div>
			</div>

			<!-- Vault links — deep-link to the Soul Hub vault page in edit mode.
				 Slashes inside query strings have no special meaning, so the raw
				 path round-trips through URL.searchParams cleanly. -->
			<div class="text-[11px] text-hub-dim flex flex-wrap gap-x-4 gap-y-0.5">
				<a
					href="/vault?note={config?.soulPath ?? DEFAULTS.soulPath}&view=edit"
					class="text-hub-cta hover:underline"
				>
					Edit personality →
				</a>
				<a
					href="/vault?note={config?.checklistPath ?? DEFAULTS.checklistPath}&view=edit"
					class="text-hub-cta hover:underline"
				>
					Edit checklist →
				</a>
			</div>

			<!-- Advanced -->
			<details bind:open={showAdvanced} class="text-[11px]">
				<summary class="cursor-pointer text-hub-muted hover:text-hub-text">Advanced</summary>
				<div class="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div>
						<label for="hb-ack" class="block text-[11px] text-hub-muted mb-1">
							Ack max chars
						</label>
						<input
							id="hb-ack"
							type="number"
							min="50"
							max="2000"
							value={config?.ackMaxChars ?? DEFAULTS.ackMaxChars}
							oninput={(e) => patchHeartbeat({ ackMaxChars: Number((e.currentTarget as HTMLInputElement).value) })}
							class="w-full px-2 py-1.5 bg-hub-bg border border-hub-border rounded text-xs text-hub-text font-mono"
						/>
					</div>
				</div>
			</details>

			<!-- Run now -->
			<div class="flex flex-wrap items-center gap-3 pt-1">
				<button
					type="button"
					onclick={runNow}
					disabled={runBusy}
					class="px-3 py-1.5 text-xs font-medium rounded-md border border-hub-cta text-hub-cta hover:bg-hub-cta/10 transition-colors cursor-pointer disabled:opacity-50"
				>
					{runBusy ? 'Running…' : 'Run now'}
				</button>
				{#if runResult}
					<span class="text-[11px] {STATUS_LABELS[runResult.status]?.tone ?? 'text-hub-dim'}">
						{STATUS_LABELS[runResult.status]?.label ?? runResult.status}
						{#if runResult.text}
							<span class="text-hub-dim"> · "{runResult.text.slice(0, 80)}{runResult.text.length > 80 ? '…' : ''}"</span>
						{/if}
					</span>
				{/if}
				{#if runError}
					<span class="text-[11px] text-hub-danger">{runError}</span>
				{/if}
			</div>

			<!-- Recent audit -->
			<div>
				<div class="flex items-center justify-between mb-1.5">
					<span class="text-[11px] text-hub-muted">Recent</span>
					<button
						type="button"
						onclick={fetchLog}
						disabled={logBusy}
						class="text-[11px] text-hub-dim hover:text-hub-text cursor-pointer disabled:opacity-50"
					>
						{logBusy ? '…' : 'Refresh'}
					</button>
				</div>
				{#if logError}
					<div class="text-[11px] text-hub-danger">{logError}</div>
				{:else if entries.length === 0}
					<div class="text-[11px] text-hub-dim italic">No runs yet.</div>
				{:else}
					<div class="space-y-1">
						{#each entries as entry (entry.ts)}
							<div class="flex items-baseline gap-2 text-[11px] font-mono">
								<span class="text-hub-dim flex-shrink-0">{formatTime(entry.ts)}</span>
								<span class="{STATUS_LABELS[entry.status]?.tone ?? 'text-hub-dim'} flex-shrink-0">
									{STATUS_LABELS[entry.status]?.label ?? entry.status}
								</span>
								{#if entry.text}
									<span class="text-hub-muted truncate" title={entry.text}>
										{entry.text.slice(0, 60)}{entry.text.length > 60 ? '…' : ''}
									</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
