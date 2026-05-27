<script lang="ts">
	import type { FeaturesConfig } from '$lib/config.schema';

	let { features }: { features?: FeaturesConfig | null } = $props();

	// Only active when the localRedeploy feature flag is on. Public installs
	// (flag off) never poll and never show this banner.
	const active = $derived(features?.localRedeploy === true);

	// ── Deploy state (polled from GET /api/system/version) ──────────────────
	interface DeployBlock {
		deployedSha: string;
		headSha: string;
		deployPending: boolean;
		commitsBehind: number;
		redeployStatus: {
			state: string;
			error?: string;
			fromSha?: string;
			toSha?: string;
		};
	}

	let polled = $state<DeployBlock | null>(null);

	// Human labels for the redeployer's status-file states.
	const STATE_LABEL: Record<string, string> = {
		started:   'starting',
		building:  'building',
		reloading: 'restarting',
	};

	// ── Freshness poller ────────────────────────────────────────────────────
	// Poll every 10s when idle (fast enough to surface a banner shortly after
	// a Ship & merge without spamming). Speeds up to 2s when a redeploy is
	// in flight (reloading state drops the server briefly — keep trying).
	const IDLE_POLL_MS = 10_000;
	const ACTIVE_POLL_MS = 2_000;

	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	function schedulePoll(delayMs: number): void {
		if (pollTimer !== null) clearTimeout(pollTimer);
		pollTimer = setTimeout(doPoll, delayMs);
	}

	async function doPoll(): Promise<void> {
		pollTimer = null;
		if (!active) return;
		try {
			const res = await fetch('/api/system/version', { cache: 'no-store' });
			if (res.ok) {
				const data = await res.json();
				if (data?.deploy) {
					polled = data.deploy as DeployBlock;
				}
			}
		} catch {
			/* server may be mid-reload — treat as "still in progress", retry soon */
		}
		// Reschedule: fast cadence while a redeploy is active, slow otherwise.
		const inFlight =
			polled?.redeployStatus?.state === 'building' ||
			polled?.redeployStatus?.state === 'reloading' ||
			polled?.redeployStatus?.state === 'started';
		schedulePoll(inFlight ? ACTIVE_POLL_MS : IDLE_POLL_MS);
	}

	$effect(() => {
		if (!active) return;
		// Start the first poll soon after mount.
		schedulePoll(500);
		return () => {
			if (pollTimer !== null) clearTimeout(pollTimer);
		};
	});

	// ── UI state machine ────────────────────────────────────────────────────
	type Phase = 'idle' | 'confirm' | 'deploying' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let errorMsg = $state('');
	let progress = $state('');

	const deployPending = $derived(polled?.deployPending === true);
	const commitsBehind = $derived(polled?.commitsBehind ?? 0);
	const headSha = $derived(polled?.headSha ?? '');

	// Reflect live redeployer state in the UI phase.
	$effect(() => {
		const st = polled?.redeployStatus?.state;
		if (!st || st === 'idle') return;
		if (st === 'done' && phase === 'deploying') {
			phase = 'done';
			// Auto-dismiss after a brief success flash — the banner clears because
			// deployPending is now false (the new build has BUILD_SHA == HEAD).
			setTimeout(() => { phase = 'idle'; }, 3000);
		} else if (st === 'failed' && phase === 'deploying') {
			phase = 'error';
			errorMsg = polled?.redeployStatus?.error ?? 'Build failed — see ~/.soul-hub/logs/redeploy.log';
		} else if ((st === 'building' || st === 'reloading' || st === 'started') && phase !== 'deploying') {
			// Another tab or a previous run is in flight — reflect it.
			phase = 'deploying';
			progress = STATE_LABEL[st] ?? st;
		}
		// Update progress label while deploying.
		if (phase === 'deploying' && st && STATE_LABEL[st]) {
			progress = STATE_LABEL[st];
		}
	});

	const showBanner = $derived(
		active && (deployPending || phase === 'deploying' || phase === 'done' || phase === 'error'),
	);

	function openConfirm(): void {
		phase = 'confirm';
	}

	function cancel(): void {
		if (phase === 'confirm') phase = 'idle';
	}

	async function startRedeploy(): Promise<void> {
		phase = 'deploying';
		errorMsg = '';
		progress = 'starting';
		try {
			const res = await fetch('/api/system/redeploy', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ confirm: true, expectedSha: headSha }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(
					(data as Record<string, unknown>)?.error as string ||
					(data as Record<string, unknown>)?.reason as string ||
					`HTTP ${res.status}`,
				);
			}
			// Spawn succeeded — the poller will track progress via the status file.
			schedulePoll(ACTIVE_POLL_MS);
		} catch (err) {
			phase = 'error';
			errorMsg = err instanceof Error ? err.message : String(err);
		}
	}

	/** Short SHA for display (7 chars). */
	function short(sha: string): string {
		return sha && sha !== 'unknown' ? sha.slice(0, 7) : sha;
	}
</script>

{#if showBanner}
	<div
		class="flex-shrink-0 flex items-center justify-center gap-3 px-4 py-1.5 text-xs bg-hub-warning/10 border-b border-hub-warning/30 text-hub-text"
		role="status"
	>
		{#if phase === 'deploying'}
			<span class="flex items-center gap-2">
				<span class="inline-block w-3 h-3 border-2 border-hub-warning/40 border-t-hub-warning rounded-full animate-spin"></span>
				Rebuilding &amp; reloading{progress ? ` — ${progress}` : ''}… Soul Hub will restart.
			</span>
		{:else if phase === 'done'}
			<span class="font-medium text-hub-cta">&#10003; Deployed — Soul Hub is up to date.</span>
		{:else if phase === 'error'}
			<span class="text-hub-warning">Deploy issue: {errorMsg}</span>
			<button type="button" onclick={() => { phase = 'idle'; errorMsg = ''; }} class="text-hub-muted hover:text-hub-text transition-colors">Dismiss</button>
		{:else}
			<!-- deployPending && idle/confirm -->
			<span class="font-medium">
				&#9881;&#65039; {commitsBehind} commit{commitsBehind !== 1 ? 's' : ''} merged but not deployed
				{#if headSha && headSha !== 'unknown'}
					<span class="text-hub-muted font-mono">(HEAD: {short(headSha)})</span>
				{/if}
			</span>
			<button
				type="button"
				onclick={openConfirm}
				class="px-2 py-0.5 rounded bg-hub-warning/20 hover:bg-hub-warning/30 text-hub-warning font-medium transition-colors"
			>
				Rebuild &amp; reload
			</button>
		{/if}
	</div>
{/if}

{#if phase === 'confirm'}
	<!-- Confirm modal — mirrors UpdateBanner's pattern -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
	>
		<div class="bg-hub-card border border-hub-border rounded-lg shadow-xl max-w-md w-full mx-4 p-5">
			<h2 class="text-sm font-semibold text-hub-text mb-2">Rebuild &amp; reload Soul Hub?</h2>
			<p class="text-xs text-hub-muted leading-relaxed mb-4">
				This will build the current <code class="text-hub-dim">HEAD</code> and restart Soul Hub.
				Active terminal sessions and in-flight pipelines will be interrupted.
				The build runs <code class="text-hub-dim">npm run build → pm2 reload</code>
				and may take a minute or two.
			</p>
			{#if headSha && headSha !== 'unknown'}
				<p class="text-xs text-hub-dim mb-4 font-mono">Target: {headSha.slice(0, 12)}…</p>
			{/if}
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
					onclick={startRedeploy}
					class="px-3 py-1.5 text-xs rounded-md bg-hub-warning text-white hover:bg-hub-warning/90 font-medium transition-colors"
				>
					Rebuild &amp; reload
				</button>
			</div>
		</div>
	</div>
{/if}
