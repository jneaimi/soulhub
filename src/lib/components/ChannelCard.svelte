<script lang="ts">
	type ChannelAction = 'send' | 'prompt' | 'listen';

	interface ChannelMeta {
		id: string;
		name: string;
		icon: string;
		fields: { key: string; label: string; type: string; env: string }[];
		actions: ChannelAction[];
		configured: boolean;
		missingEnv: string[];
	}

	interface ChannelConfig {
		enabled: boolean;
		label: string;
		defaultFor: ChannelAction[];
		// Per-adapter passthrough — e.g. WhatsApp carries `access`/`intentMap`/
		// `worker` here and the parent merges them back at save time.
		[extra: string]: unknown;
	}

	interface Props {
		meta: ChannelMeta;
		config: ChannelConfig;
		onchange: (id: string, config: ChannelConfig) => void;
	}

	let { meta, config, onchange }: Props = $props();

	let testing = $state(false);
	let testResult = $state<{ ok: boolean; error?: string } | null>(null);

	let status = $derived.by(() => {
		if (!config.enabled) return 'disabled' as const;
		if (!meta.configured) return 'unconfigured' as const;
		return 'connected' as const;
	});

	let statusLabel = $derived(
		status === 'connected' ? 'Connected'
		: status === 'unconfigured' ? 'Not configured'
		: 'Disabled'
	);

	let statusColor = $derived(
		status === 'connected' ? 'bg-hub-cta'
		: status === 'unconfigured' ? 'bg-hub-warning'
		: 'bg-hub-dim'
	);

	let statusTextColor = $derived(
		status === 'connected' ? 'text-hub-cta'
		: status === 'unconfigured' ? 'text-hub-warning'
		: 'text-hub-dim'
	);

	function toggleEnabled() {
		onchange(meta.id, { ...config, enabled: !config.enabled });
	}

	function toggleDefaultFor(action: ChannelAction) {
		const current = config.defaultFor;
		const next = current.includes(action)
			? current.filter((a) => a !== action)
			: [...current, action];
		onchange(meta.id, { ...config, defaultFor: next });
	}

	function updateLabel(e: Event) {
		const val = (e.target as HTMLInputElement).value;
		onchange(meta.id, { ...config, label: val });
	}

	async function testChannel() {
		testing = true;
		testResult = null;
		try {
			const res = await fetch('/api/channels/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ channel: meta.id }),
			});
			testResult = await res.json();
		} catch {
			testResult = { ok: false, error: 'Network error' };
		} finally {
			testing = false;
			setTimeout(() => { testResult = null; }, 4000);
		}
	}
</script>

<div class="bg-hub-surface border border-hub-border rounded-lg overflow-hidden">
	<!-- Header -->
	<div class="flex items-center justify-between p-4">
		<div class="flex items-center gap-3">
			{#if meta.id === 'telegram'}
				<svg class="w-5 h-5 text-hub-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
				</svg>
			{:else}
				<svg class="w-5 h-5 text-hub-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
				</svg>
			{/if}
			<span class="text-sm font-medium text-hub-text">{meta.name}</span>
			<span class="flex items-center gap-1.5 text-[11px] {statusTextColor}" aria-label="{meta.name}: {statusLabel}">
				<span class="w-1.5 h-1.5 rounded-full {statusColor}"></span>
				{statusLabel}
			</span>
		</div>

		<button
			type="button"
			role="switch"
			aria-checked={config.enabled}
			aria-label="Enable {meta.name}"
			onclick={toggleEnabled}
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
		<div class="border-t border-hub-border px-4 pb-4 pt-3 space-y-3">
			<!-- Missing env warning — points to Platform Environment -->
			{#if meta.missingEnv.length > 0}
				<div class="flex items-start gap-2 bg-hub-warning/10 border border-hub-warning/20 rounded-md px-3 py-2">
					<svg class="w-4 h-4 text-hub-warning flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
					</svg>
					<span class="text-xs text-hub-warning">
						Missing: {meta.missingEnv.join(', ')}. Configure in Platform Environment above.
					</span>
				</div>
			{/if}

			<!-- Test button -->
			{#if meta.configured}
				<div class="flex items-center gap-3">
					<button
						onclick={testChannel}
						disabled={testing}
						class="px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer
							{testResult?.ok ? 'border-hub-cta text-hub-cta' : testResult && !testResult.ok ? 'border-hub-danger text-hub-danger' : 'border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta'}"
					>
						{#if testing}
							<span class="inline-flex items-center gap-1.5">
								<svg class="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
								</svg>
								Testing...
							</span>
						{:else if testResult?.ok}
							Sent
						{:else if testResult && !testResult.ok}
							Failed
						{:else}
							Test
						{/if}
					</button>
					{#if testResult && !testResult.ok && testResult.error}
						<span class="text-[10px] text-hub-danger">{testResult.error}</span>
					{/if}
				</div>
			{/if}

			<!-- Label -->
			<div>
				<label for="channel-label-{meta.id}" class="block text-xs text-hub-muted mb-1">Label</label>
				<input
					id="channel-label-{meta.id}"
					type="text"
					value={config.label}
					oninput={updateLabel}
					class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-1.5 text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
				/>
			</div>

			<!-- Default for actions -->
			<div>
				<span class="block text-xs text-hub-muted mb-2">Default for</span>
				<div class="flex items-center gap-4">
					{#each meta.actions as action}
						<label class="flex items-center gap-2 cursor-pointer">
							<button
								type="button"
								role="checkbox"
								aria-checked={config.defaultFor.includes(action)}
								onclick={() => toggleDefaultFor(action)}
								class="w-4 h-4 rounded border transition-colors flex items-center justify-center cursor-pointer
									{config.defaultFor.includes(action) ? 'bg-hub-cta border-hub-cta' : 'border-hub-border bg-hub-bg'}"
							>
								{#if config.defaultFor.includes(action)}
									<svg class="w-2.5 h-2.5 text-hub-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
										<polyline points="20 6 9 17 4 12"/>
									</svg>
								{/if}
							</button>
							<span class="text-xs text-hub-text">{action}</span>
						</label>
					{/each}
				</div>
			</div>
		</div>
	{:else}
		<div class="border-t border-hub-border px-4 py-3">
			<span class="text-xs text-hub-dim">Enable to configure {meta.name} integration.</span>
		</div>
	{/if}
</div>
