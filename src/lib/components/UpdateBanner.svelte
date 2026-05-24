<script lang="ts">
	import type { UpdateState } from '$lib/update-check';

	let { update }: { update?: UpdateState | null } = $props();

	// ── Dismissal (ADR-010) — per-browser, per-version localStorage flag. A newer
	//    release re-surfaces the banner automatically. Zero server state. ───────
	const DISMISS_KEY = 'soulhub:update-dismissed';
	let dismissedVersion = $state<string | null>(null);

	$effect(() => {
		try {
			dismissedVersion = localStorage.getItem(DISMISS_KEY);
		} catch {
			dismissedVersion = null;
		}
	});

	const showBanner = $derived(
		!!update?.updateAvailable &&
			!!update?.latestVersion &&
			dismissedVersion !== update.latestVersion,
	);

	function dismiss(): void {
		if (!update?.latestVersion) return;
		try {
			localStorage.setItem(DISMISS_KEY, update.latestVersion);
		} catch {
			/* private mode — banner just reappears next load */
		}
		dismissedVersion = update.latestVersion;
	}

	// ── One-click update (ADR-011) — confirm modal → POST → poll version ───────
	type Phase = 'idle' | 'confirm' | 'updating' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let errorMsg = $state('');

	function openConfirm(): void {
		phase = 'confirm';
	}
	function cancel(): void {
		if (phase === 'confirm') phase = 'idle';
	}

	/** Strip a leading `v` for display / comparison. */
	const strip = (v: string | null | undefined) => (v ?? '').replace(/^v/, '');

	async function startUpdate(): Promise<void> {
		if (!update?.latestVersion) return;
		phase = 'updating';
		errorMsg = '';
		try {
			const res = await fetch('/api/system/update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirm: true, expectedVersion: update.latestVersion }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data?.error || data?.reason || `HTTP ${res.status}`);
			}
			pollForNewVersion(update.latestVersion);
		} catch (err) {
			phase = 'error';
			errorMsg = err instanceof Error ? err.message : String(err);
		}
	}

	/** Poll GET /api/system/version every 3s for up to 120s. When the running
	 *  version matches the target tag, the reload landed — full-page reload to
	 *  pick up the new bundle. On timeout, tell the operator to check the log. */
	function pollForNewVersion(targetTag: string): void {
		const target = strip(targetTag);
		const deadline = Date.now() + 120_000;
		const tick = async () => {
			if (Date.now() > deadline) {
				phase = 'error';
				errorMsg = 'Taking longer than expected — check ~/.soul-hub/logs/update.log';
				return;
			}
			try {
				const res = await fetch('/api/system/version', { cache: 'no-store' });
				if (res.ok) {
					const data = await res.json();
					if (strip(data?.version) === target) {
						phase = 'done';
						setTimeout(() => location.reload(), 2000);
						return;
					}
				}
			} catch {
				/* server is mid-reload — keep polling */
			}
			setTimeout(tick, 3000);
		};
		setTimeout(tick, 3000);
	}
</script>

{#if showBanner}
	<div
		class="flex-shrink-0 flex items-center justify-center gap-3 px-4 py-1.5 text-xs bg-hub-info/10 border-b border-hub-info/30 text-hub-text"
		role="status"
	>
		{#if phase === 'updating'}
			<span class="flex items-center gap-2">
				<span class="inline-block w-3 h-3 border-2 border-hub-info/40 border-t-hub-info rounded-full animate-spin"></span>
				Updating to {update?.latestVersion}… Soul Hub will restart.
			</span>
		{:else if phase === 'done'}
			<span class="font-medium text-hub-cta">Updated to {update?.latestVersion} — reloading…</span>
		{:else if phase === 'error'}
			<span class="text-hub-warning">Update issue: {errorMsg}</span>
			<button type="button" onclick={() => (phase = 'idle')} class="text-hub-muted hover:text-hub-text transition-colors">Dismiss</button>
		{:else}
			<span class="font-medium">Soul Hub {update?.latestVersion} is available</span>
			{#if update?.releaseUrl}
				<a
					href={update.releaseUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="underline decoration-dotted hover:text-hub-info transition-colors"
				>
					What's new
				</a>
			{/if}
			<button
				type="button"
				onclick={openConfirm}
				class="px-2 py-0.5 rounded bg-hub-info/20 hover:bg-hub-info/30 text-hub-info font-medium transition-colors"
			>
				Update now
			</button>
			<button
				type="button"
				onclick={dismiss}
				class="text-hub-muted hover:text-hub-text transition-colors"
				aria-label="Dismiss update notification"
			>
				Dismiss
			</button>
		{/if}
	</div>
{/if}

{#if phase === 'confirm'}
	<!-- Confirm modal (ADR-011 §2b) — no auto-dismiss -->
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" role="dialog" aria-modal="true">
		<div class="bg-hub-card border border-hub-border rounded-lg shadow-xl max-w-md w-full mx-4 p-5">
			<h2 class="text-sm font-semibold text-hub-text mb-2">Update Soul Hub to {update?.latestVersion}?</h2>
			<p class="text-xs text-hub-muted leading-relaxed mb-4">
				This will restart Soul Hub. Active terminal sessions and in-flight pipelines
				will be interrupted. The update runs <code class="text-hub-dim">git pull → install → build → reload</code>
				and may take a minute or two.
			</p>
			<div class="flex justify-end gap-2">
				<button
					type="button"
					onclick={cancel}
					class="px-3 py-1.5 text-xs rounded-md text-hub-muted hover:text-hub-text hover:bg-hub-bg transition-colors"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={startUpdate}
					class="px-3 py-1.5 text-xs rounded-md bg-hub-info text-white hover:bg-hub-info/90 font-medium transition-colors"
				>
					Update now
				</button>
			</div>
		</div>
	</div>
{/if}
