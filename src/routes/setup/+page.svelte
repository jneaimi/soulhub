<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	interface ApiSecret {
		key: string;
		set: boolean;
		source: 'platform' | 'shell';
		declared: boolean;
		required: boolean;
		declaredBy: string[];
		link?: string;
	}

	type Step = 1 | 2 | 3 | 4;

	let step = $state<Step>(1);
	let busy = $state(false);
	let stepError = $state<string | null>(null);

	// Step 2 — Paths
	let vaultDir = $state('~/vault');
	let devDir = $state('~/dev');
	let claudeBinary = $state('~/.local/bin/claude');

	// Step 3 — Secrets
	let secrets = $state<ApiSecret[]>([]);
	let editingKey = $state<string | null>(null);
	let editValue = $state('');
	let syncing = $state(false);
	let syncResult = $state<{ count: number } | null>(null);

	async function loadSecrets() {
		try {
			const res = await fetch('/api/secrets');
			if (res.ok) secrets = await res.json();
		} catch {
			/* ignore */
		}
	}

	onMount(async () => {
		// ?skip=1 — power-user bypass: write defaults via the existing endpoint
		// and bounce to the dashboard. The endpoint mkdirs ~/.soul-hub/ for us.
		const params = new URLSearchParams(window.location.search);
		if (params.get('skip') === '1') {
			busy = true;
			try {
				await fetch('/api/settings', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({}),
				});
			} catch {
				/* ignore */
			}
			busy = false;
			await goto('/', { replaceState: true });
			return;
		}
		await loadSecrets();
	});

	async function savePaths() {
		busy = true;
		stepError = null;
		try {
			const res = await fetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					paths: { vaultDir, devDir, claudeBinary },
				}),
			});
			const data = await res.json();
			if (!res.ok) {
				stepError = data?.issues?.[0]
					? `${data.issues[0].path || 'paths'}: ${data.issues[0].message}`
					: data?.error || 'Failed to save paths.';
				return;
			}
			step = 3;
		} catch (err) {
			stepError = (err as Error).message;
		} finally {
			busy = false;
		}
	}

	async function syncFromShell() {
		syncing = true;
		try {
			const keys = Array.from(new Set(secrets.map((s) => s.key)));
			const res = await fetch('/api/secrets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'sync-from-shell', keys }),
			});
			const data = await res.json();
			if (data.ok) {
				syncResult = { count: data.synced };
				await loadSecrets();
				setTimeout(() => {
					syncResult = null;
				}, 4000);
			}
		} catch {
			/* ignore */
		}
		syncing = false;
	}

	async function saveSecret(key: string) {
		if (!editValue.trim()) return;
		busy = true;
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
				await loadSecrets();
			}
		} catch {
			/* ignore */
		}
		busy = false;
	}

	async function finish() {
		busy = true;
		try {
			// Re-POST settings so the file definitely exists. The gate checks
			// `existsSync(settings.json)` and clears once this completes.
			await fetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ paths: { vaultDir, devDir, claudeBinary } }),
			});
		} catch {
			/* ignore */
		}
		busy = false;
		await goto('/', { replaceState: true });
	}

	let envList = $derived.by(() => {
		const declared = secrets.filter((s) => s.declared);
		const others = secrets.filter((s) => !s.declared && s.set);
		return [...declared, ...others];
	});
</script>

<svelte:head>
	<title>Soul Hub — First-run setup</title>
</svelte:head>

<div class="min-h-screen bg-hub-bg flex items-center justify-center p-6">
	<div class="w-full max-w-2xl">
		<!-- Step indicator -->
		<div class="flex items-center justify-center gap-2 mb-8">
			{#each [1, 2, 3, 4] as n}
				<div
					class="w-8 h-1.5 rounded-full transition-colors {step >= n
						? 'bg-hub-cta'
						: 'bg-hub-border'}"
				></div>
			{/each}
		</div>

		<div class="bg-hub-surface border border-hub-border rounded-xl p-8 shadow-lg">
			{#if step === 1}
				<h1 class="text-2xl font-medium text-hub-text mb-2">Welcome to Soul Hub</h1>
				<p class="text-sm text-hub-dim mb-6">
					Soul Hub stores your settings and secrets in <code class="font-mono text-hub-text"
						>~/.soul-hub/</code
					>, kept separate from this repository so upgrades and clones never touch your data.
				</p>
				<p class="text-xs text-hub-muted mb-6">
					This wizard takes about a minute. You can re-run it any time from
					<a href="/settings" class="text-hub-cta hover:underline">Settings</a>.
				</p>
				<div class="flex items-center justify-end gap-2">
					<a
						href="/setup?skip=1"
						class="px-3 py-1.5 text-xs text-hub-muted hover:text-hub-text transition-colors"
					>
						Skip with defaults
					</a>
					<button
						onclick={() => (step = 2)}
						class="px-4 py-2 text-sm font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer"
					>
						Continue
					</button>
				</div>
			{:else if step === 2}
				<h1 class="text-2xl font-medium text-hub-text mb-2">Paths</h1>
				<p class="text-sm text-hub-dim mb-6">
					Where do your projects, vault, and Claude binary live? <code class="font-mono">~</code>
					expands to your home directory.
				</p>
				<div class="space-y-4">
					<label class="block">
						<span class="block text-xs font-medium text-hub-muted mb-1">Vault directory</span>
						<input
							type="text"
							bind:value={vaultDir}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-2 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</label>
					<label class="block">
						<span class="block text-xs font-medium text-hub-muted mb-1">Dev directory</span>
						<input
							type="text"
							bind:value={devDir}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-2 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
					</label>
					<label class="block">
						<span class="block text-xs font-medium text-hub-muted mb-1">Claude binary</span>
						<input
							type="text"
							bind:value={claudeBinary}
							class="w-full bg-hub-bg border border-hub-border rounded-md px-3 py-2 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
						/>
						<span class="block text-[10px] text-hub-muted mt-1">
							Run <code class="font-mono">which claude</code> in a terminal if you're unsure.
						</span>
					</label>
				</div>
				{#if stepError}
					<div class="mt-4 text-xs text-hub-danger">{stepError}</div>
				{/if}
				<div class="flex items-center justify-between mt-6">
					<button
						onclick={() => (step = 1)}
						class="px-3 py-1.5 text-sm text-hub-muted hover:text-hub-text transition-colors cursor-pointer"
					>
						Back
					</button>
					<button
						onclick={savePaths}
						disabled={busy}
						class="px-4 py-2 text-sm font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer disabled:opacity-40"
					>
						{busy ? 'Saving...' : 'Continue'}
					</button>
				</div>
			{:else if step === 3}
				<h1 class="text-2xl font-medium text-hub-text mb-2">Secrets</h1>
				<p class="text-sm text-hub-dim mb-4">
					Soul Hub manages API keys in <code class="font-mono text-hub-text">~/.soul-hub/.env</code>.
					Skip any you don't need yet — channels just stay disabled.
				</p>

				<div class="flex items-center gap-2 mb-4">
					<button
						onclick={syncFromShell}
						disabled={syncing}
						class="px-3 py-1.5 text-xs font-medium rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta transition-colors cursor-pointer disabled:opacity-40"
					>
						{syncing ? 'Syncing...' : 'Import from shell'}
					</button>
					{#if syncResult}
						<span class="text-[10px] text-hub-cta font-medium">{syncResult.count} keys imported</span>
					{/if}
				</div>

				<div class="space-y-2 max-h-72 overflow-y-auto pr-1">
					{#each envList as entry (entry.key)}
						<div class="flex items-start gap-3 py-2 border-b border-hub-border/50 last:border-b-0">
							<span
								class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0 {entry.set
									? 'bg-hub-cta'
									: 'bg-hub-border'}"
							></span>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="text-sm font-mono text-hub-text">{entry.key}</span>
									{#if entry.required}
										<span
											class="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border border-hub-cta/40 text-hub-cta"
										>
											Required
										</span>
									{/if}
								</div>
								{#if entry.declaredBy.length > 0}
									<div class="text-[10px] text-hub-muted mt-0.5">
										For: {entry.declaredBy.join(', ')}
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
								{#if editingKey === entry.key}
									<div class="flex items-center gap-2 mt-2">
										<input
											type="password"
											bind:value={editValue}
											placeholder="Paste value..."
											class="flex-1 bg-hub-bg border border-hub-cta/50 rounded-md px-2.5 py-1 text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50"
											onkeydown={(e) => {
												if (e.key === 'Enter') saveSecret(entry.key);
												if (e.key === 'Escape') {
													editingKey = null;
													editValue = '';
												}
											}}
										/>
										<button
											onclick={() => saveSecret(entry.key)}
											disabled={busy || !editValue.trim()}
											class="px-2 py-1 text-xs font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer disabled:opacity-40"
										>
											Save
										</button>
										<button
											onclick={() => {
												editingKey = null;
												editValue = '';
											}}
											class="px-2 py-1 text-xs text-hub-muted hover:text-hub-text cursor-pointer"
										>
											Cancel
										</button>
									</div>
								{/if}
							</div>
							{#if editingKey !== entry.key}
								<button
									onclick={() => {
										editingKey = entry.key;
										editValue = '';
									}}
									class="px-2 py-1 text-[11px] font-medium rounded border border-hub-border text-hub-muted hover:text-hub-text hover:border-hub-cta transition-colors cursor-pointer flex-shrink-0"
								>
									{entry.set ? 'Change' : 'Set'}
								</button>
							{/if}
						</div>
					{/each}
				</div>

				<div class="flex items-center justify-between mt-6">
					<button
						onclick={() => (step = 2)}
						class="px-3 py-1.5 text-sm text-hub-muted hover:text-hub-text transition-colors cursor-pointer"
					>
						Back
					</button>
					<button
						onclick={() => (step = 4)}
						class="px-4 py-2 text-sm font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer"
					>
						Continue
					</button>
				</div>
			{:else}
				<h1 class="text-2xl font-medium text-hub-text mb-2">All set</h1>
				<p class="text-sm text-hub-dim mb-6">
					Soul Hub is configured. Your settings live at <code class="font-mono text-hub-text"
						>~/.soul-hub/settings.json</code
					>; secrets at <code class="font-mono text-hub-text">~/.soul-hub/.env</code>.
				</p>
				<ul class="text-sm text-hub-muted space-y-1 mb-6 list-disc pl-5">
					<li>Edit anything later from <a href="/settings" class="text-hub-cta hover:underline">Settings</a>.</li>
					<li>Open the vault, dispatch a pipeline, or pin a project from the dashboard.</li>
					<li>Need to start fresh? <code class="font-mono">rm -rf ~/.soul-hub/</code> and reload.</li>
				</ul>

				<!-- L2-U5 — Layer 2 inbox filter heads-up. Optional: filter runs
				     rules-only without Claude auth, so this is a nudge not a
				     blocker. ADR 2026-05-11-inbox-processing-filter-layer §D-Bootstrap. -->
				<div class="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
					<div class="flex items-start gap-3">
						<svg class="w-4 h-4 mt-0.5 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"/>
							<line x1="12" y1="8" x2="12" y2="12"/>
							<line x1="12" y1="16" x2="12.01" y2="16"/>
						</svg>
						<div class="flex-1 text-xs">
							<p class="text-amber-300 font-medium mb-1">One more thing — authenticate the Claude CLI</p>
							<p class="text-hub-muted leading-relaxed">
								The inbox Layer 2 filter uses <code class="font-mono text-hub-text">claude -p</code> to
								classify mail that header rules can't decide. Run <code class="font-mono text-hub-text">claude</code>
								once in a terminal to authenticate. Until then, the filter runs rules-only and ambiguous
								mail is held for the next sweep — not a blocker, just a heads-up.
							</p>
							<p class="text-hub-dim leading-relaxed mt-1.5">
								<span class="uppercase tracking-wider text-[9px] text-hub-dim/80">Privacy:</span>
								the classifier sends email subjects + the 500-char preview to Anthropic. No bodies or
								attachments are sent. Set <code class="font-mono text-hub-muted">INBOX_FILTER_LLM_DISABLED=1</code>
								for rules-only mode, or <code class="font-mono text-hub-muted">INBOX_FILTER_DISABLED=1</code>
								to skip the filter entirely.
							</p>
						</div>
					</div>
				</div>
				<div class="flex items-center justify-end gap-2">
					<button
						onclick={() => (step = 3)}
						class="px-3 py-1.5 text-sm text-hub-muted hover:text-hub-text transition-colors cursor-pointer"
					>
						Back
					</button>
					<button
						onclick={finish}
						disabled={busy}
						class="px-4 py-2 text-sm font-medium rounded-md bg-hub-cta text-hub-bg hover:bg-hub-cta-hover transition-colors cursor-pointer disabled:opacity-40"
					>
						{busy ? 'Finishing...' : 'Open dashboard'}
					</button>
				</div>
			{/if}
		</div>

		<div class="text-center mt-4 text-[10px] text-hub-muted">
			Step {step} of 4
		</div>
	</div>
</div>
