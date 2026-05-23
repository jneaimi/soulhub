<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import cronstrue from 'cronstrue';
	import { CronExpressionParser } from 'cron-parser';

	function isCronValid(expr: string): boolean {
		if (!expr) return false;
		try {
			CronExpressionParser.parse(expr);
			return true;
		} catch {
			return false;
		}
	}

	type Mode = 'presets' | 'builder' | 'raw';
	// ADR-002: trigger-pipeline retired 2026-05-16; only shell-script remains in the
	// builder. The orchestrator-v2 fold will add a 'naseej-recipe' task type later.
	type TaskType = 'shell-script';

	interface ShellScriptParams {
		command: string[];
		cwd?: string;
		timeoutMs?: number;
	}

	const PRESETS: Array<{ label: string; cron: string }> = [
		{ label: 'Every 5 minutes', cron: '*/5 * * * *' },
		{ label: 'Hourly', cron: '0 * * * *' },
		{ label: 'Daily 9 AM', cron: '0 9 * * *' },
		{ label: 'Weekday mornings', cron: '0 8 * * 1-5' },
		{ label: 'Weekly Sun 9 AM', cron: '0 9 * * 0' },
		{ label: 'Monthly 1st', cron: '0 9 1 * *' },
	];

	const COMMON_TIMEZONES = [
		'Asia/Dubai',
		'UTC',
		'America/New_York',
		'America/Los_Angeles',
		'Europe/London',
		'Europe/Berlin',
	];

	// State
	let mode = $state<Mode>('presets');
	let editingId = $state<string | null>(null);
	let id = $state('');
	let description = $state('');
	let type = $state<TaskType>('shell-script');
	let cronExpr = $state('0 9 * * *');
	let timezone = $state('Asia/Dubai');
	let enabled = $state(true);
	let noOverlap = $state(true);

	// shell-script params
	let command = $state('');
	let cwd = $state('');
	let timeoutMin = $state(60);

	// Builder mode state (UI-only inputs that compose into cronExpr)
	let bMinute = $state('0');
	let bHour = $state('9');
	let bDay = $state('*');
	let bMonth = $state('*');
	let bWeekday = $state('*');

	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let loadingExisting = $state(false);

	const isValid = $derived(isCronValid(cronExpr));

	const humanReadable = $derived.by(() => {
		if (!isValid) return null;
		try {
			return cronstrue.toString(cronExpr);
		} catch {
			return null;
		}
	});

	const next5Runs = $derived.by(() => {
		if (!isValid) return [];
		try {
			const it = CronExpressionParser.parse(cronExpr, {
				tz: timezone,
				currentDate: new Date(),
			});
			return Array.from({ length: 5 }, () => it.next().toDate());
		} catch {
			return [];
		}
	});

	const validation = $derived.by(() => {
		if (!cronExpr.trim()) return { state: 'empty' as const, message: 'Enter a cron expression' };
		if (!isValid) return { state: 'invalid' as const, message: 'Invalid expression' };
		// Suspicious patterns
		if (cronExpr === '* * * * *') {
			return { state: 'warning' as const, message: 'This fires every minute — are you sure?' };
		}
		return { state: 'valid' as const, message: 'Valid expression' };
	});

	const idValid = $derived(/^[a-z0-9][a-z0-9-_]*$/.test(id));
	const canSave = $derived.by(() => {
		if (!idValid || !id) return false;
		if (!isValid) return false;
		if (type === 'shell-script' && !command.trim()) return false;
		return true;
	});

	function applyPreset(p: typeof PRESETS[number]) {
		cronExpr = p.cron;
	}

	function syncBuilderFromCron() {
		const parts = cronExpr.split(/\s+/);
		if (parts.length === 5) {
			[bMinute, bHour, bDay, bMonth, bWeekday] = parts;
		}
	}

	function applyBuilder() {
		cronExpr = `${bMinute} ${bHour} ${bDay} ${bMonth} ${bWeekday}`.trim();
	}

	function fmtRun(d: Date): string {
		return d.toLocaleString('en-GB', {
			timeZone: timezone,
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		});
	}

	function relativeFromNow(d: Date): string {
		const ms = d.getTime() - Date.now();
		const secs = Math.floor(ms / 1000);
		const mins = Math.floor(secs / 60);
		const hours = Math.floor(mins / 60);
		const days = Math.floor(hours / 24);
		if (days > 0) return `in ${days}d ${hours % 24}h`;
		if (hours > 0) return `in ${hours}h ${mins % 60}m`;
		if (mins > 0) return `in ${mins}m`;
		return `in ${secs}s`;
	}

	async function loadExisting(taskId: string) {
		loadingExisting = true;
		try {
			const res = await fetch('/api/scheduler/tasks');
			const data = await res.json();
			const task = (data.tasks ?? []).find((t: { id: string }) => t.id === taskId);
			if (!task) {
				saveError = `Task '${taskId}' not found`;
				return;
			}
			editingId = task.id;
			id = task.id;
			description = task.description ?? '';
			type = task.type;
			cronExpr = task.cron;
			timezone = task.timezone ?? 'Asia/Dubai';
			enabled = task.enabled !== false;
			noOverlap = task.noOverlap !== false;

			if (task.type === 'shell-script') {
				const p = task.params as ShellScriptParams;
				command = Array.isArray(p.command) ? p.command.join(' ') : '';
				cwd = p.cwd ?? '';
				timeoutMin = p.timeoutMs ? Math.round(p.timeoutMs / 60_000) : 60;
			}

			// Edit mode opens on Raw per ADR Q2.
			mode = 'raw';
			syncBuilderFromCron();
		} catch (err) {
			saveError = `Failed to load: ${(err as Error).message}`;
		} finally {
			loadingExisting = false;
		}
	}

	async function save() {
		if (!canSave) return;
		saving = true;
		saveError = null;
		try {
			const settingsRes = await fetch('/api/settings');
			const settings = await settingsRes.json();
			const existing: Array<Record<string, unknown>> = settings.scheduler?.tasks ?? [];

			const params: Record<string, unknown> = {
				command: command.trim().split(/\s+/).filter(Boolean),
				cwd: cwd.trim() || undefined,
				timeoutMs: timeoutMin > 0 ? timeoutMin * 60_000 : undefined,
			};

			const newSpec = {
				id,
				type,
				cron: cronExpr,
				timezone,
				enabled,
				noOverlap,
				description: description.trim() || undefined,
				params,
			};

			const merged = editingId
				? existing.map((t) => (t.id === editingId ? newSpec : t))
				: [...existing, newSpec];

			// Guard: prevent duplicate IDs on create.
			if (!editingId && existing.some((t) => t.id === id)) {
				saveError = `Task '${id}' already exists`;
				saving = false;
				return;
			}

			const res = await fetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ scheduler: { tasks: merged } }),
			});
			const data = await res.json();
			if (!res.ok) {
				saveError = data.error ?? `HTTP ${res.status}`;
				if (data.issues) {
					saveError += ': ' + data.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ');
				}
				saving = false;
				return;
			}

			goto('/scheduler');
		} catch (err) {
			saveError = (err as Error).message;
			saving = false;
		}
	}

	onMount(() => {
		const url = new URL(window.location.href);
		const taskId = url.searchParams.get('id');
		if (taskId) {
			loadExisting(taskId);
		}
	});

	$effect(() => {
		if (mode === 'builder') {
			applyBuilder();
		}
	});
</script>

<svelte:head>
	<title>{editingId ? 'Edit task' : 'New task'} · Scheduler · Soul Hub</title>
</svelte:head>

<div class="flex flex-col h-full bg-hub-bg" data-scheduler>
	<header class="flex-shrink-0 px-4 sm:px-6 py-4 border-b border-hub-border">
		<div class="flex items-center gap-3 max-w-4xl mx-auto w-full">
			<a
				href="/scheduler"
				class="p-1.5 rounded-lg hover:bg-hub-card transition-colors text-hub-muted hover:text-hub-text cursor-pointer"
				aria-label="Back to scheduler"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
				</svg>
			</a>
			<h1 class="text-lg font-semibold text-hub-text">
				{editingId ? `Edit task — ${editingId}` : 'New scheduled task'}
			</h1>
			<div class="flex-1"></div>
			<a
				href="/scheduler"
				class="px-3 py-1.5 rounded-lg text-sm text-hub-muted hover:text-hub-text hover:bg-hub-card transition-colors cursor-pointer"
			>
				Cancel
			</a>
			<button
				onclick={save}
				disabled={!canSave || saving}
				class="px-3 py-1.5 rounded-lg bg-hub-cta text-black font-medium text-sm hover:bg-hub-cta/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
			>
				{saving ? 'Saving…' : editingId ? 'Save changes' : 'Save and enable'}
			</button>
		</div>
	</header>

	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
		<div class="max-w-4xl mx-auto w-full space-y-6">
			{#if loadingExisting}
				<div class="text-sm text-hub-muted">Loading task…</div>
			{/if}

			{#if saveError}
				<div class="bg-hub-danger/10 border border-hub-danger/40 rounded-lg p-3 text-sm text-hub-danger">
					{saveError}
				</div>
			{/if}

			<!-- Identity -->
			<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-3">
				<h2 class="text-sm font-semibold text-hub-text">Task identity</h2>
				<div>
					<label for="task-id" class="block text-xs text-hub-muted mb-1">ID <span class="text-hub-dim">(lowercase, hyphens, no spaces)</span></label>
					<input
						id="task-id"
						type="text"
						bind:value={id}
						readonly={!!editingId}
						placeholder="my-task-name"
						class="w-full px-3 py-2 rounded-lg bg-hub-bg border text-sm text-hub-text font-mono focus:outline-none focus:ring-1
							{idValid || !id ? 'border-hub-border focus:border-hub-cta/50 focus:ring-hub-cta/50' : 'border-hub-danger/60 focus:border-hub-danger focus:ring-hub-danger/30'}
							{editingId ? 'opacity-60 cursor-not-allowed' : ''}"
					/>
					{#if id && !idValid}
						<p class="text-[11px] text-hub-danger mt-1">Use lowercase letters, digits, hyphens, or underscores. Must start with a letter or digit.</p>
					{/if}
				</div>
				<div>
					<label for="task-desc" class="block text-xs text-hub-muted mb-1">Description <span class="text-hub-dim">(optional)</span></label>
					<input
						id="task-desc"
						type="text"
						bind:value={description}
						placeholder="What this task does"
						class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
					/>
				</div>
			</section>

			<!-- Schedule -->
			<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-4">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-semibold text-hub-text">Schedule</h2>
					<div class="flex items-center gap-1">
						{#each ['presets', 'builder', 'raw'] as m (m)}
							<button
								onclick={() => {
									if (m === 'builder') syncBuilderFromCron();
									mode = m as Mode;
								}}
								class="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer
									{mode === m
										? 'bg-hub-cta text-black'
										: 'text-hub-muted hover:text-hub-text hover:bg-hub-bg'}"
							>
								{m === 'raw' ? 'Raw cron' : m.charAt(0).toUpperCase() + m.slice(1)}
							</button>
						{/each}
					</div>
				</div>

				<!-- Mode bodies -->
				{#if mode === 'presets'}
					<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
						{#each PRESETS as p (p.cron)}
							<button
								onclick={() => applyPreset(p)}
								class="px-3 py-2 rounded-lg border text-xs text-left transition-colors cursor-pointer
									{cronExpr === p.cron
										? 'border-hub-cta/60 bg-hub-cta/10 text-hub-text'
										: 'border-hub-border bg-hub-bg text-hub-muted hover:text-hub-text hover:border-hub-border/80'}"
							>
								<div class="font-medium mb-0.5">{p.label}</div>
								<code class="text-[10px] text-hub-dim font-mono">{p.cron}</code>
							</button>
						{/each}
					</div>
				{:else if mode === 'builder'}
					<div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
						{#each [
							{ label: 'Minute', bind: 'bMinute' },
							{ label: 'Hour', bind: 'bHour' },
							{ label: 'Day', bind: 'bDay' },
							{ label: 'Month', bind: 'bMonth' },
							{ label: 'Weekday', bind: 'bWeekday' },
						] as field (field.bind)}
							<div>
								<label for={`b-${field.bind}`} class="block text-[10px] text-hub-dim mb-1 uppercase tracking-wider">{field.label}</label>
								{#if field.bind === 'bMinute'}
									<input id={`b-${field.bind}`} bind:value={bMinute} class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs font-mono text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50" />
								{:else if field.bind === 'bHour'}
									<input id={`b-${field.bind}`} bind:value={bHour} class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs font-mono text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50" />
								{:else if field.bind === 'bDay'}
									<input id={`b-${field.bind}`} bind:value={bDay} class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs font-mono text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50" />
								{:else if field.bind === 'bMonth'}
									<input id={`b-${field.bind}`} bind:value={bMonth} class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs font-mono text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50" />
								{:else}
									<input id={`b-${field.bind}`} bind:value={bWeekday} class="w-full px-2 py-1.5 rounded bg-hub-bg border border-hub-border text-xs font-mono text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50" />
								{/if}
							</div>
						{/each}
					</div>
					<p class="text-[11px] text-hub-dim">Use cron syntax in each field — e.g. <code class="text-hub-muted">*/5</code>, <code class="text-hub-muted">9</code>, <code class="text-hub-muted">1-5</code>, <code class="text-hub-muted">MON,TUE</code>.</p>
				{/if}

				<!-- Cron + timezone (always visible) -->
				<div class="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3">
					<div>
						<label for="cron-input" class="block text-xs text-hub-muted mb-1">Cron expression</label>
						<input
							id="cron-input"
							type="text"
							bind:value={cronExpr}
							class="w-full px-3 py-2 rounded-lg bg-hub-bg border text-sm font-mono text-hub-text focus:outline-none focus:ring-1
								{validation.state === 'invalid' ? 'border-hub-danger/60 focus:ring-hub-danger/30 focus:border-hub-danger'
								: validation.state === 'warning' ? 'border-hub-warning/60 focus:ring-hub-warning/30'
								: 'border-hub-border focus:border-hub-cta/50 focus:ring-hub-cta/50'}"
						/>
					</div>
					<div>
						<label for="tz-input" class="block text-xs text-hub-muted mb-1">Timezone</label>
						<select
							id="tz-input"
							bind:value={timezone}
							class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
						>
							{#each COMMON_TIMEZONES as tz (tz)}
								<option value={tz}>{tz}</option>
							{/each}
						</select>
					</div>
				</div>

				<!-- Description + validation -->
				<div class="space-y-1.5">
					{#if humanReadable}
						<p class="text-sm text-hub-muted">💬 {humanReadable}</p>
					{/if}
					<p class="text-xs
						{validation.state === 'valid' ? 'text-hub-cta'
						: validation.state === 'invalid' ? 'text-hub-danger'
						: validation.state === 'warning' ? 'text-hub-warning'
						: 'text-hub-dim'}"
					>
						{validation.state === 'valid' ? '✓' : validation.state === 'invalid' ? '✗' : validation.state === 'warning' ? '⚠' : ''}
						{validation.message}
					</p>
				</div>

				<!-- Next 5 runs -->
				{#if next5Runs.length > 0}
					<div class="rounded-lg bg-hub-bg/60 border border-hub-border/60 p-3">
						<p class="text-[11px] uppercase tracking-wider text-hub-dim mb-2">Next 5 runs ({timezone})</p>
						<div class="space-y-1">
							{#each next5Runs as d (d.toISOString())}
								<div class="flex items-center justify-between text-xs font-mono">
									<span class="text-hub-muted">{fmtRun(d)}</span>
									<span class="text-hub-dim">{relativeFromNow(d)}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</section>

			<!-- Task body -->
			<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-4">
				<h2 class="text-sm font-semibold text-hub-text">Task body</h2>

				<div>
					<p class="text-[11px] text-hub-dim mb-2">
						Task type: <code class="font-mono text-hub-muted">shell-script</code>
						<span class="text-hub-dim">— pipeline-trigger retired per ADR-002 (2026-05-16); a Naseej-recipe task type will land with the orchestrator-v2 fold.</span>
					</p>
				</div>

				<div>
					<label for="cmd" class="block text-xs text-hub-muted mb-1">Command</label>
					<input
						id="cmd"
						type="text"
						bind:value={command}
						placeholder="python3 /path/to/script.py"
						class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
					/>
					<p class="text-[11px] text-hub-dim mt-1">Whitespace-separated. For args containing spaces, edit <code class="font-mono">~/.soul-hub/settings.json</code> directly.</p>
				</div>
				<div class="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
					<div>
						<label for="cwd" class="block text-xs text-hub-muted mb-1">Working dir <span class="text-hub-dim">(optional)</span></label>
						<input
							id="cwd"
							type="text"
							bind:value={cwd}
							placeholder="/Users/jneaimi/dev/your-project"
							class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
						/>
					</div>
					<div>
						<label for="timeout" class="block text-xs text-hub-muted mb-1">Timeout (min)</label>
						<input
							id="timeout"
							type="number"
							bind:value={timeoutMin}
							min="0"
							class="w-full px-3 py-2 rounded-lg bg-hub-bg border border-hub-border text-sm text-hub-text font-mono focus:outline-none focus:ring-1 focus:ring-hub-cta/50 focus:border-hub-cta/50"
						/>
					</div>
				</div>
			</section>

			<!-- Behavior -->
			<section class="bg-hub-card rounded-xl border border-hub-border p-4 space-y-3">
				<h2 class="text-sm font-semibold text-hub-text">Behavior</h2>
				<label class="flex items-start gap-2 cursor-pointer">
					<input type="checkbox" bind:checked={noOverlap} class="mt-0.5 cursor-pointer" />
					<div>
						<div class="text-sm text-hub-text">No overlap</div>
						<div class="text-[11px] text-hub-dim">Skip this fire if the previous run is still in progress.</div>
					</div>
				</label>
				<label class="flex items-start gap-2 cursor-pointer">
					<input type="checkbox" bind:checked={enabled} class="mt-0.5 cursor-pointer" />
					<div>
						<div class="text-sm text-hub-text">Enabled</div>
						<div class="text-[11px] text-hub-dim">Uncheck to register the spec without scheduling it.</div>
					</div>
				</label>
			</section>
		</div>
	</div>
</div>
