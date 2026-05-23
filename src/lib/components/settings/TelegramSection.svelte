<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	interface IntentMapping {
		route: string;
		description?: string;
	}

	interface Props {
		config: Record<string, unknown> & {
			enabled?: boolean;
			label?: string;
			access?: { allowFrom?: string[]; groupAllowFrom?: string[] };
			webhook?: { url?: string; secretToken?: string };
			delivery?: {
				parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' | 'none';
				transcribeVoiceNotes?: boolean;
			};
			intentMap?: Record<string, IntentMapping & { dynamic?: boolean }>;
		};
		/** Patches: `{ enabled }`, `{ access: {...} }`, `{ webhook: {...} }`,
		 *  `{ delivery: {...} }`, `{ intentMap }`. Parent deep-merges. */
		onchange: (patch: Record<string, unknown>) => void;
	}

	let { config, onchange }: Props = $props();

	let bot = $state<{ id?: number; username?: string; first_name?: string } | null>(null);
	let webhookInfo = $state<{
		url?: string;
		pending_update_count?: number;
		last_error_date?: number;
		last_error_message?: string;
	} | null>(null);
	let tokenSet = $state(false);
	let pollHandle: ReturnType<typeof setInterval> | null = null;
	let setupBusy = $state(false);
	let setupMessage = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let testBusy = $state(false);
	let testMessage = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

	async function fetchStatus() {
		try {
			const res = await fetch('/api/channels/telegram/status');
			if (!res.ok) return;
			const data = await res.json();
			tokenSet = !!data.tokenSet;
			bot = data.bot ?? null;
			webhookInfo = data.webhook ?? null;
		} catch {
			/* keep last value */
		}
	}

	onMount(() => {
		void fetchStatus();
		pollHandle = setInterval(() => void fetchStatus(), 30_000);
	});

	onDestroy(() => {
		if (pollHandle) clearInterval(pollHandle);
	});

	const enabled = $derived(!!config.enabled);
	const access = $derived(config.access ?? {});
	const allowFrom = $derived((access.allowFrom as string[] | undefined) ?? []);
	const groupAllowFrom = $derived((access.groupAllowFrom as string[] | undefined) ?? []);
	const webhook = $derived(config.webhook ?? {});
	const delivery = $derived(config.delivery ?? {});
	const intentMap = $derived(
		(config.intentMap as Record<string, IntentMapping & { dynamic?: boolean }> | undefined) ?? {},
	);
	const intentRows = $derived(
		Object.entries(intentMap).filter(([k]) => k !== 'default').map(([k, v]) => ({
			token: k,
			route: v.route,
			description: v.description ?? '',
		})),
	);
	const defaultRoute = $derived(intentMap.default?.route ?? 'vault-chat');

	let newAllowFrom = $state('');
	let newGroupAllow = $state('');

	function toggleEnabled() {
		onchange({ enabled: !enabled });
	}

	function addAllowFrom() {
		const v = newAllowFrom.trim();
		if (!v) return;
		if (v !== '*' && !/^\d+$/.test(v)) {
			setupMessage = { kind: 'error', text: 'Allowlist entries must be numeric Telegram user_ids or `*`.' };
			return;
		}
		if (allowFrom.includes(v)) {
			newAllowFrom = '';
			return;
		}
		onchange({ access: { allowFrom: [...allowFrom, v] } });
		newAllowFrom = '';
	}

	function removeAllowFrom(id: string) {
		onchange({ access: { allowFrom: allowFrom.filter((x) => x !== id) } });
	}

	function addGroup() {
		const v = newGroupAllow.trim();
		if (!v || !/^-?\d+$/.test(v)) {
			setupMessage = { kind: 'error', text: 'Group chat IDs are signed integers (typically negative for groups).' };
			return;
		}
		if (groupAllowFrom.includes(v)) {
			newGroupAllow = '';
			return;
		}
		onchange({ access: { groupAllowFrom: [...groupAllowFrom, v] } });
		newGroupAllow = '';
	}

	function removeGroup(id: string) {
		onchange({ access: { groupAllowFrom: groupAllowFrom.filter((x) => x !== id) } });
	}

	function setWebhookUrl(url: string) {
		onchange({ webhook: { url } });
	}

	function setSecretToken(secret: string) {
		onchange({ webhook: { secretToken: secret } });
	}

	function setParseMode(mode: 'Markdown' | 'MarkdownV2' | 'HTML' | 'none') {
		onchange({ delivery: { parseMode: mode } });
	}

	function setTranscribeVoice(value: boolean) {
		onchange({ delivery: { transcribeVoiceNotes: value } });
	}

	function updateIntentRow(idx: number, field: 'token' | 'route' | 'description', value: string) {
		const next: Record<string, IntentMapping & { dynamic?: boolean }> = {
			default: intentMap.default ?? { route: 'vault-chat' },
		};
		intentRows.forEach((row, i) => {
			const useToken = i === idx && field === 'token' ? value : row.token;
			const useRoute = i === idx && field === 'route' ? value : row.route;
			const useDescription = i === idx && field === 'description' ? value : row.description;
			next[useToken] = {
				route: useRoute,
				description: useDescription || undefined,
			};
		});
		onchange({ intentMap: next });
	}

	function addIntentRow() {
		const next: Record<string, IntentMapping & { dynamic?: boolean }> = {
			default: intentMap.default ?? { route: 'vault-chat' },
		};
		intentRows.forEach((row) => {
			next[row.token] = { route: row.route, description: row.description || undefined };
		});
		next['/new'] = { route: 'vault-chat', description: '' };
		onchange({ intentMap: next });
	}

	function removeIntentRow(token: string) {
		const next: Record<string, IntentMapping & { dynamic?: boolean }> = {
			default: intentMap.default ?? { route: 'vault-chat' },
		};
		intentRows.forEach((row) => {
			if (row.token !== token) {
				next[row.token] = { route: row.route, description: row.description || undefined };
			}
		});
		onchange({ intentMap: next });
	}

	async function runSetup() {
		setupBusy = true;
		setupMessage = null;
		try {
			const res = await fetch('/api/channels/telegram/setup', { method: 'POST' });
			const data = await res.json();
			if (data.ok) {
				setupMessage = {
					kind: 'ok',
					text: `Setup OK — bot @${data.bot?.username}, ${data.commands?.length ?? 0} commands registered.`,
				};
				await fetchStatus();
			} else {
				setupMessage = { kind: 'error', text: data.error ?? 'setup failed' };
			}
		} catch (err) {
			setupMessage = { kind: 'error', text: (err as Error).message };
		} finally {
			setupBusy = false;
		}
	}

	async function runTest() {
		testBusy = true;
		testMessage = null;
		try {
			const res = await fetch('/api/channels/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ envKey: 'TELEGRAM_BOT_TOKEN' }),
			});
			const data = await res.json();
			if (data.ok) {
				testMessage = { kind: 'ok', text: 'Telegram credentials OK.' };
			} else {
				testMessage = { kind: 'error', text: data.message ?? data.status ?? 'test failed' };
			}
		} catch (err) {
			testMessage = { kind: 'error', text: (err as Error).message };
		} finally {
			testBusy = false;
		}
	}
</script>

<section class="mb-6">
	<div class="mb-2 flex items-center justify-between px-1">
		<h2 class="text-xs font-medium text-hub-dim uppercase tracking-wider">Telegram</h2>
		<label class="flex items-center gap-2 text-xs text-hub-dim cursor-pointer">
			<input type="checkbox" checked={enabled} onchange={toggleEnabled} class="cursor-pointer" />
			<span>{enabled ? 'Enabled' : 'Disabled'}</span>
		</label>
	</div>

	<div class="rounded-md border border-hub-border bg-hub-card-deep p-4 space-y-4">
		<!-- Bot identity + webhook info -->
		<div class="text-sm space-y-1">
			{#if !tokenSet}
				<div class="text-amber-400">TELEGRAM_BOT_TOKEN is not set — add it in Secrets.</div>
			{:else if bot}
				<div>Bot: <span class="font-mono">@{bot.username ?? '(unknown)'}</span> · id <span class="font-mono">{bot.id}</span></div>
			{:else}
				<div class="text-hub-dim">Loading bot info…</div>
			{/if}
			{#if webhookInfo}
				{#if webhookInfo.url}
					<div class="text-hub-dim">Webhook: <span class="font-mono break-all">{webhookInfo.url}</span></div>
					{#if webhookInfo.pending_update_count}
						<div class="text-amber-400">Pending updates: {webhookInfo.pending_update_count}</div>
					{/if}
					{#if webhookInfo.last_error_message}
						<div class="text-red-400">Last error: {webhookInfo.last_error_message}</div>
					{/if}
				{:else}
					<div class="text-hub-dim">Webhook: <span class="italic">not registered</span> — set URL below + click Setup.</div>
				{/if}
			{/if}
		</div>

		<!-- Webhook fields -->
		<div class="space-y-2">
			<label class="block text-xs text-hub-dim">
				Webhook URL
				<input
					type="url"
					value={webhook.url ?? ''}
					placeholder="https://your-tunnel/api/channels/telegram/_webhook"
					onchange={(e) => setWebhookUrl((e.currentTarget as HTMLInputElement).value)}
					class="mt-1 w-full rounded border border-hub-border bg-hub-card px-2 py-1 text-sm font-mono"
				/>
			</label>
			<label class="block text-xs text-hub-dim">
				Secret token (sent as X-Telegram-Bot-Api-Secret-Token)
				<input
					type="password"
					value={webhook.secretToken ?? ''}
					placeholder="optional shared secret"
					onchange={(e) => setSecretToken((e.currentTarget as HTMLInputElement).value)}
					class="mt-1 w-full rounded border border-hub-border bg-hub-card px-2 py-1 text-sm font-mono"
				/>
			</label>
			<div class="flex items-center gap-2">
				<button
					type="button"
					disabled={setupBusy || !tokenSet || !webhook.url}
					onclick={runSetup}
					class="px-3 py-1 text-xs rounded bg-hub-accent text-hub-bg disabled:opacity-50"
				>
					{setupBusy ? 'Registering…' : 'Setup webhook + commands'}
				</button>
				<button
					type="button"
					disabled={testBusy || !tokenSet}
					onclick={runTest}
					class="px-3 py-1 text-xs rounded border border-hub-border"
				>
					{testBusy ? 'Testing…' : 'Test credentials'}
				</button>
			</div>
			{#if setupMessage}
				<div class="text-xs {setupMessage.kind === 'ok' ? 'text-green-400' : 'text-red-400'}">{setupMessage.text}</div>
			{/if}
			{#if testMessage}
				<div class="text-xs {testMessage.kind === 'ok' ? 'text-green-400' : 'text-red-400'}">{testMessage.text}</div>
			{/if}
		</div>

		<!-- DM allowlist -->
		<div>
			<div class="text-xs text-hub-dim mb-1">DM allowlist (Telegram user_ids — numeric)</div>
			<div class="flex flex-wrap gap-1 mb-2">
				{#each allowFrom as id (id)}
					<span class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-hub-card border border-hub-border">
						<span class="font-mono">{id}</span>
						<button type="button" onclick={() => removeAllowFrom(id)} class="text-hub-dim hover:text-red-400">×</button>
					</span>
				{/each}
				{#if allowFrom.length === 0}
					<span class="text-xs italic text-hub-dim">empty — DMs will be silently dropped</span>
				{/if}
			</div>
			<div class="flex gap-1">
				<input
					type="text"
					bind:value={newAllowFrom}
					placeholder="123456789 or *"
					onkeydown={(e) => e.key === 'Enter' && addAllowFrom()}
					class="flex-1 rounded border border-hub-border bg-hub-card px-2 py-1 text-sm font-mono"
				/>
				<button type="button" onclick={addAllowFrom} class="px-3 py-1 text-xs rounded border border-hub-border">Add</button>
			</div>
		</div>

		<!-- Group allowlist -->
		<div>
			<div class="text-xs text-hub-dim mb-1">Group allowlist (negative chat_ids, e.g. -100123…)</div>
			<div class="flex flex-wrap gap-1 mb-2">
				{#each groupAllowFrom as id (id)}
					<span class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-hub-card border border-hub-border">
						<span class="font-mono">{id}</span>
						<button type="button" onclick={() => removeGroup(id)} class="text-hub-dim hover:text-red-400">×</button>
					</span>
				{/each}
				{#if groupAllowFrom.length === 0}
					<span class="text-xs italic text-hub-dim">empty — bot ignores all groups</span>
				{/if}
			</div>
			<div class="flex gap-1">
				<input
					type="text"
					bind:value={newGroupAllow}
					placeholder="-1001234567890"
					onkeydown={(e) => e.key === 'Enter' && addGroup()}
					class="flex-1 rounded border border-hub-border bg-hub-card px-2 py-1 text-sm font-mono"
				/>
				<button type="button" onclick={addGroup} class="px-3 py-1 text-xs rounded border border-hub-border">Add</button>
			</div>
		</div>

		<!-- Delivery -->
		<div class="grid grid-cols-2 gap-3">
			<label class="block text-xs text-hub-dim">
				Parse mode
				<select
					value={delivery.parseMode ?? 'Markdown'}
					onchange={(e) => setParseMode((e.currentTarget as HTMLSelectElement).value as never)}
					class="mt-1 w-full rounded border border-hub-border bg-hub-card px-2 py-1 text-sm"
				>
					<option value="Markdown">Markdown (legacy)</option>
					<option value="MarkdownV2">MarkdownV2 (strict)</option>
					<option value="HTML">HTML</option>
					<option value="none">None (plain)</option>
				</select>
			</label>
			<label class="flex items-center gap-2 text-xs text-hub-dim mt-5 cursor-pointer">
				<input
					type="checkbox"
					checked={delivery.transcribeVoiceNotes !== false}
					onchange={(e) => setTranscribeVoice((e.currentTarget as HTMLInputElement).checked)}
					class="cursor-pointer"
				/>
				Auto-transcribe voice notes
			</label>
		</div>

		<!-- Intent map -->
		<div>
			<div class="text-xs text-hub-dim mb-2">Intent map (default → <span class="font-mono">{defaultRoute}</span>)</div>
			<div class="space-y-1">
				{#each intentRows as row, i (row.token)}
					<div class="flex gap-1">
						<input
							type="text"
							value={row.token}
							onchange={(e) => updateIntentRow(i, 'token', (e.currentTarget as HTMLInputElement).value)}
							class="w-24 rounded border border-hub-border bg-hub-card px-2 py-1 text-xs font-mono"
						/>
						<input
							type="text"
							value={row.route}
							onchange={(e) => updateIntentRow(i, 'route', (e.currentTarget as HTMLInputElement).value)}
							class="w-32 rounded border border-hub-border bg-hub-card px-2 py-1 text-xs font-mono"
						/>
						<input
							type="text"
							value={row.description}
							placeholder="Optional description"
							onchange={(e) => updateIntentRow(i, 'description', (e.currentTarget as HTMLInputElement).value)}
							class="flex-1 rounded border border-hub-border bg-hub-card px-2 py-1 text-xs"
						/>
						<button type="button" onclick={() => removeIntentRow(row.token)} class="text-hub-dim hover:text-red-400 px-2">×</button>
					</div>
				{/each}
				<button type="button" onclick={addIntentRow} class="px-3 py-1 text-xs rounded border border-hub-border">+ Add command</button>
			</div>
		</div>
	</div>
</section>
