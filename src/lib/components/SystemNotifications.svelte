<script lang="ts">
	import { onMount } from 'svelte';

	interface SystemAction {
		id: string;
		label: string;
		type: 'script' | 'claude' | 'api';
		endpoint?: string;
		method?: string;
		body?: Record<string, unknown>;
		prompt?: string;
		cwd?: string;
	}

	interface Notification {
		id: string;
		source: string;
		severity: 'info' | 'warning' | 'action_required';
		title: string;
		detail: string;
		actions: SystemAction[];
		created: number;
		dismissed?: number;
		resolved?: { actionId: string; at: number; result: string };
	}

	let notifications = $state<Notification[]>([]);
	let expanded = $state(false);
	let loading = $state(false);
	let actionInProgress = $state<string | null>(null);
	let actionResults = $state<Map<string, string>>(new Map());

	const severityStyles: Record<string, string> = {
		info: 'border-hub-info/30 bg-hub-info/5',
		warning: 'border-hub-warning/30 bg-hub-warning/5',
		action_required: 'border-hub-danger/30 bg-hub-danger/5',
	};

	const severityDot: Record<string, string> = {
		info: 'bg-hub-info',
		warning: 'bg-hub-warning',
		action_required: 'bg-hub-danger',
	};

	async function loadNotifications() {
		try {
			const res = await fetch('/api/system/notifications?active=true');
			if (res.ok) {
				const data = await res.json();
				notifications = data.notifications ?? [];
			}
		} catch { /* silent */ }
	}

	async function dismiss(id: string) {
		try {
			await fetch('/api/system/notifications', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, action: 'dismiss' }),
			});
			notifications = notifications.filter((n) => n.id !== id);
		} catch { /* silent */ }
	}

	async function executeAction(notificationId: string, action: SystemAction) {
		actionInProgress = action.id;
		actionResults.delete(notificationId);
		actionResults = new Map(actionResults);

		try {
			if (action.type === 'api') {
				const res = await fetch('/api/system/actions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(action.body ?? {}),
				});
				const data = await res.json();
				if (res.ok) {
					const fixed = data.result?.fixed?.length ?? 0;
					const skipped = data.result?.skipped?.length ?? 0;
					const errors = data.result?.errors?.length ?? 0;
					const parts: string[] = [];
					if (fixed > 0) parts.push(`Fixed ${fixed}`);
					if (skipped > 0) parts.push(`${skipped} need manual review`);
					if (errors > 0) parts.push(`${errors} errors`);
					const resultMsg = parts.length > 0 ? parts.join(' · ') : 'No changes needed';
					actionResults.set(notificationId, resultMsg);
					actionResults = new Map(actionResults);

					// Tell the home page (and any other listener) to refresh its vault stats.
					window.dispatchEvent(new CustomEvent('vault:refresh'));

					// Only mark the notification resolved if everything was fixed;
					// if some were skipped, leave it open so the user can try the fallback.
					if (fixed > 0 && skipped === 0 && errors === 0) {
						await fetch('/api/system/notifications', {
							method: 'PATCH',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								id: notificationId,
								action: 'resolve',
								actionId: action.id,
								result: resultMsg,
							}),
						});
					}
					setTimeout(() => loadNotifications(), 500);
				} else {
					actionResults.set(notificationId, `Error: ${data.error}`);
					actionResults = new Map(actionResults);
				}
			} else if (action.type === 'claude') {
				const res = await fetch('/api/system/actions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'run-claude',
						prompt: action.prompt,
						cwd: action.cwd,
					}),
				});
				const data = await res.json();
				if (res.ok) {
					actionResults.set(notificationId, `Session ${data.sessionId} launched`);
					actionResults = new Map(actionResults);
				} else {
					actionResults.set(notificationId, `Error: ${data.error}`);
					actionResults = new Map(actionResults);
				}
			}
		} catch (err) {
			actionResults.set(notificationId, `Failed: ${err instanceof Error ? err.message : 'unknown error'}`);
			actionResults = new Map(actionResults);
		} finally {
			actionInProgress = null;
		}
	}

	async function forceCheck() {
		loading = true;
		try {
			await fetch('/api/system/health', { method: 'POST' });
			await loadNotifications();
		} catch { /* silent */ }
		loading = false;
	}

	onMount(() => {
		loadNotifications();
	});
</script>

{#if notifications.length > 0}
	<div class="mb-6">
		<!-- Summary bar -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			onclick={() => { expanded = !expanded; }}
			class="w-full flex items-center justify-between px-4 py-2.5 rounded-lg border {notifications.some(n => n.severity === 'action_required') ? 'border-hub-danger/30 bg-hub-danger/5' : 'border-hub-warning/30 bg-hub-warning/5'} hover:opacity-90 transition-opacity cursor-pointer"
			role="button"
			tabindex="0"
		>
			<div class="flex items-center gap-2">
				<span class="relative flex h-2.5 w-2.5">
					<span class="animate-ping absolute inline-flex h-full w-full rounded-full {notifications.some(n => n.severity === 'action_required') ? 'bg-hub-danger' : 'bg-hub-warning'} opacity-75"></span>
					<span class="relative inline-flex rounded-full h-2.5 w-2.5 {notifications.some(n => n.severity === 'action_required') ? 'bg-hub-danger' : 'bg-hub-warning'}"></span>
				</span>
				<span class="text-sm text-hub-text font-medium">
					{notifications.length} system notification{notifications.length === 1 ? '' : 's'}
				</span>
			</div>
			<div class="flex items-center gap-2">
				<button
					onclick={(e) => { e.stopPropagation(); forceCheck(); }}
					disabled={loading}
					class="text-[10px] text-hub-dim hover:text-hub-muted transition-colors px-2 py-0.5 rounded border border-hub-border cursor-pointer disabled:opacity-50"
				>
					{loading ? 'Checking...' : 'Re-check'}
				</button>
				<svg
					class="w-4 h-4 text-hub-dim transition-transform {expanded ? 'rotate-180' : ''}"
					viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
				>
					<polyline points="6 9 12 15 18 9"/>
				</svg>
			</div>
		</div>

		<!-- Expanded notification list -->
		{#if expanded}
			<div class="mt-2 space-y-2">
				{#each notifications as n (n.id)}
					<div class="rounded-lg border {severityStyles[n.severity] || severityStyles.info} px-4 py-3">
						<div class="flex items-start justify-between gap-3">
							<div class="flex items-start gap-2 min-w-0">
								<span class="mt-1 flex-shrink-0 w-2 h-2 rounded-full {severityDot[n.severity] || severityDot.info}"></span>
								<div class="min-w-0">
									<div class="text-sm font-medium text-hub-text">{n.title}</div>
									<div class="text-xs text-hub-muted mt-0.5 whitespace-pre-line">{n.detail}</div>
									<div class="text-[10px] text-hub-dim mt-1">
										{n.source} &middot; {new Date(n.created).toLocaleDateString()}
									</div>
								</div>
							</div>
							<button
								onclick={() => dismiss(n.id)}
								class="flex-shrink-0 p-1 rounded text-hub-dim hover:text-hub-muted hover:bg-hub-card transition-colors cursor-pointer"
								aria-label="Dismiss"
							>
								<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M18 6L6 18"/><path d="M6 6l12 12"/>
								</svg>
							</button>
						</div>

						<!-- Actions -->
						{#if n.actions.length > 0}
							<div class="flex flex-wrap gap-2 mt-2 ml-4">
								{#each n.actions as act}
									<button
										onclick={() => executeAction(n.id, act)}
										disabled={actionInProgress === act.id}
										class="px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors disabled:opacity-50
											{act.type === 'claude'
												? 'bg-hub-purple/15 text-hub-purple hover:bg-hub-purple/25'
												: 'bg-hub-cta/15 text-hub-cta hover:bg-hub-cta/25'}"
									>
										{actionInProgress === act.id ? 'Running...' : act.label}
									</button>
								{/each}
							</div>
						{/if}

						<!-- Action result feedback -->
						{#if actionResults.get(n.id)}
							<div class="mt-2 ml-4 text-[11px] text-hub-muted bg-hub-bg/50 rounded px-2 py-1">
								{actionResults.get(n.id)}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
