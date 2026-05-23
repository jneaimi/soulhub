<script lang="ts">
	import { onDestroy } from 'svelte';
	import { marked } from 'marked';
	import PlaybookPhases from './PlaybookPhases.svelte';
	import PlaybookResult from './PlaybookResult.svelte';
	import SoulHubRunPanel from '../session/SoulHubRunPanel.svelte';

	function renderMarkdown(md: string): string {
		try {
			return marked.parse(md, { async: false }) as string;
		} catch {
			return `<pre>${md}</pre>`;
		}
	}

	let {
		playbookName,
		inputValues = {},
		disabled = false,
		configPhases = [],
		specInputs = [],
		isRunning = $bindable(false),
		runElapsed = $bindable(''),
		runStatus = $bindable(''),
		onStart,
		onKill,
	} = $props<{
		playbookName: string;
		inputValues: Record<string, string | number>;
		disabled: boolean;
		configPhases: { id: string; type: string }[];
		specInputs: { id: string; required?: boolean }[];
		isRunning?: boolean;
		runElapsed?: string;
		runStatus?: string;
		onStart?: () => void;
		onKill?: () => void;
	}>();

	// Sync to parent via $effect
	import { tick } from 'svelte';
	$effect(() => { isRunning = running; });
	$effect(() => { runElapsed = elapsed; });
	$effect(() => { runStatus = status; });

	// Run state
	let running = $state(false);
	let runId = $state('');
	type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';

	interface PhaseRunState {
		id: string;
		type: string;
		status: PhaseStatus;
		assignments: { role: string; status: string; error?: string }[];
		depends_on?: string[];
		error?: string;
		iterations?: number;
	}

	let phases = $state<PhaseRunState[]>([]);
	let events = $state<any[]>([]);
	let taskOutput = $state<Record<string, string>>({});
	let status = $state('');
	let error = $state('');
	let elapsed = $state('');
	let startTime = $state(0);
	let runResult = $state<{ status: string; phases: any[] } | null>(null);
	let outputFiles = $state<Record<string, string>>({});
	let activeReportTab = $state('');
	let vaultNotes = $state<{path: string; title: string; type?: string}[]>([]);

	// Gate / Human
	let waitingForGate = $state('');
	let gatePrompt = $state('');
	let waitingForHuman = $state('');
	let humanPrompt = $state('');
	let humanResponse = $state('');
	let rejectReason = $state('');
	let showRejectInput = $state(false);
	let humanReviewFiles = $state<Record<string, string>>({});
	let gateReviewFiles = $state<Record<string, string>>({});
	let humanSubmitting = $state(false);
	let handledEventKeys = $state(new Set<string>());

	// Timers
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let elapsedInterval: ReturnType<typeof setInterval> | null = null;

	function canRun(): boolean {
		if (running || disabled) return false;
		for (const inp of specInputs) {
			if (inp.required && !inputValues[inp.id]) return false;
		}
		return true;
	}

	function formatDuration(ms: number): string {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rs = s % 60;
		if (m < 60) return `${m}m ${rs}s`;
		const h = Math.floor(m / 60);
		return `${h}h ${m % 60}m`;
	}

	function stopTimers() {
		if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
		if (elapsedInterval) {
			clearInterval(elapsedInterval);
			elapsedInterval = null;
			if (startTime) elapsed = formatDuration(Date.now() - startTime);
		}
	}

	/** Call from parent to start the run */
	export function start() { startRun(); }
	/** Call from parent to kill the run */
	export function stop() { kill(); }

	async function startRun() {
		running = true;
		runResult = null;
		error = '';
		taskOutput = {};
		status = 'starting';
		waitingForGate = '';
		waitingForHuman = '';
		showRejectInput = false;

		// Init phase states from config
		phases = configPhases.map((ph: { id: string; type: string }) => ({
			id: ph.id,
			type: ph.type,
			status: 'pending',
			assignments: [],
		}));

		// Start elapsed timer
		startTime = Date.now();
		elapsedInterval = setInterval(() => {
			elapsed = formatDuration(Date.now() - startTime);
		}, 1000);

		try {
			const res = await fetch('/api/playbooks/run', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ playbook: playbookName, inputs: inputValues }),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				error = err.error || 'Failed to start';
				running = false;
				stopTimers();
				return;
			}

			const data = await res.json();
			runId = data.runId;
			status = 'running';

			// Start polling
			pollInterval = setInterval(poll, 1500);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to start';
			running = false;
			stopTimers();
		}
	}

	async function poll() {
		if (!runId) return;
		try {
			const res = await fetch(`/api/playbooks/run?id=${runId}`);
			if (!res.ok) return;
			const data = await res.json();

			// Sync state
			if (data.phases) {
				phases = data.phases.map((p: any) => ({
					id: p.id,
					type: p.type,
					status: p.status as PhaseStatus,
					assignments: (p.assignments || []).map((a: any) => ({
						role: a.role,
						status: a.status,
						error: a.error,
					})),
					depends_on: p.depends_on,
					error: p.error,
					iterations: p.iterations,
				}));
			}
			if (data.events) events = data.events;
			if (data.taskOutput) taskOutput = data.taskOutput;
			if (data.status) status = data.status;

			// Detect gate/human from events (deduplicate by phaseId+status)
			for (const ev of data.events || []) {
				const evKey = `${ev.phaseId}:${ev.status}`;
				if (handledEventKeys.has(evKey)) continue;

				if (ev.status === 'gate_required' && !waitingForGate) {
					handledEventKeys.add(evKey);
					waitingForGate = ev.phaseId;
					try {
						const parsed = JSON.parse(ev.detail || '');
						gatePrompt = parsed.prompt || 'Approve this phase?';
						gateReviewFiles = parsed.reviewFiles || {};
					} catch {
						gatePrompt = ev.detail || 'Approve this phase?';
						gateReviewFiles = {};
					}
				}
				if (ev.status === 'human_required' && !waitingForHuman) {
					handledEventKeys.add(evKey);
					waitingForHuman = ev.phaseId;
					try {
						const parsed = JSON.parse(ev.detail || '');
						humanPrompt = parsed.prompt || 'Input required';
						humanReviewFiles = parsed.reviewFiles || {};
					} catch {
						humanPrompt = ev.detail || 'Input required';
						humanReviewFiles = {};
					}
					// Fetch phase files as fallback if event data had none
					if (Object.keys(humanReviewFiles).length === 0) {
						fetch(`/api/playbooks/run?id=${runId}&phase=${ev.phaseId}`)
							.then(r => r.json())
							.then(d => { if (d.phaseFiles) humanReviewFiles = d.phaseFiles; })
							.catch(() => {});
					}
				}
			}

			// Check completion
			if (data.status === 'completed' || data.status === 'failed') {
				runResult = { status: data.status, phases: data.phases };
				if (data.outputFiles) {
					outputFiles = data.outputFiles;
					const keys = Object.keys(data.outputFiles);
					if (keys.length > 0 && !activeReportTab) activeReportTab = keys[0];
				}
				if (data.status === 'failed') {
					const failedPhase = data.phases?.find((p: any) => p.status === 'failed');
					if (failedPhase?.error) error = failedPhase.error;
				}
				running = false;
				stopTimers();
				loadPlaybookVaultNotes();
			}
		} catch { /* retry next poll */ }
	}

	async function approveGate() {
		await fetch('/api/playbooks/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'approve', runId, phaseId: waitingForGate }),
		});
		waitingForGate = '';
		gatePrompt = '';
	}

	async function rejectGate() {
		if (!showRejectInput) {
			showRejectInput = true;
			return;
		}
		await fetch('/api/playbooks/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'reject',
				runId,
				phaseId: waitingForGate,
				reason: rejectReason || 'Rejected',
			}),
		});
		waitingForGate = '';
		gatePrompt = '';
		rejectReason = '';
		showRejectInput = false;
	}

	async function submitHuman() {
		if (!humanResponse.trim() || humanSubmitting) return;
		humanSubmitting = true;
		await fetch('/api/playbooks/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'human_input',
				runId,
				phaseId: waitingForHuman,
				value: humanResponse,
			}),
		});
		waitingForHuman = '';
		humanPrompt = '';
		humanResponse = '';
		humanReviewFiles = {};
		humanSubmitting = false;
	}

	async function kill() {
		if (!runId) return;
		await fetch('/api/playbooks/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'kill', runId }),
		});
	}

	function reset() {
		runId = '';
		runResult = null;
		phases = [];
		events = [];
		taskOutput = {};
		outputFiles = {};
		activeReportTab = '';
		status = '';
		error = '';
		elapsed = '';
		waitingForGate = '';
		waitingForHuman = '';
		showRejectInput = false;
		humanReviewFiles = {};
		gateReviewFiles = {};
		humanSubmitting = false;
		handledEventKeys = new Set();
		vaultNotes = [];
	}

	async function loadPlaybookVaultNotes() {
		if (!playbookName || !runId) return;
		try {
			const res = await fetch(`/api/vault/notes?project=${encodeURIComponent(playbookName)}&limit=20`);
			if (res.ok) {
				const data = await res.json();
				const shortId = runId.slice(0, 8);
				vaultNotes = (data.results || []).filter((n: any) =>
					n.path.includes(shortId)
				);
			}
		} catch { vaultNotes = []; }
	}

	onDestroy(stopTimers);
</script>

<!-- Run Error -->
{#if error && !running}
	<div class="border border-hub-danger/30 bg-hub-danger/5 rounded-lg p-4 text-sm text-hub-danger">
		{error}
	</div>
{/if}

<!-- Phase Progress (only during run) -->
{#if phases.length > 0 && running}
	<PlaybookPhases {phases} />
{/if}

<!-- Gate Required -->
{#if waitingForGate}
	<div class="border-2 border-hub-warning/40 bg-hub-warning/5 rounded-lg p-4 space-y-4">
		<p class="text-sm text-hub-warning font-medium">Gate: {gatePrompt}</p>

		{#if Object.keys(gateReviewFiles).length > 0}
			<div class="border border-hub-border rounded-lg overflow-hidden">
				<div class="px-3 py-1.5 bg-hub-panel/30 border-b border-hub-border">
					<span class="text-[10px] text-hub-dim uppercase tracking-wider font-medium">Review Content</span>
				</div>
				<div class="p-4 max-h-[400px] overflow-y-auto prose prose-sm prose-invert max-w-none
					prose-headings:text-hub-text prose-p:text-hub-muted prose-strong:text-hub-text
					prose-a:text-hub-cta prose-code:text-hub-muted prose-code:bg-hub-bg/50
					prose-pre:bg-hub-bg prose-pre:border prose-pre:border-hub-border
					prose-li:text-hub-muted prose-blockquote:text-hub-dim prose-blockquote:border-hub-border">
					{#each Object.entries(gateReviewFiles) as [filename, content]}
						{@html renderMarkdown(content)}
					{/each}
				</div>
			</div>
		{/if}

		{#if showRejectInput}
			<div>
				<input
					type="text"
					bind:value={rejectReason}
					placeholder="Rejection reason..."
					class="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-danger/50"
				/>
			</div>
		{/if}
		<div class="flex gap-2">
			<button
				onclick={approveGate}
				class="px-4 py-1.5 bg-hub-cta text-black rounded-lg text-sm font-medium hover:bg-hub-cta-hover transition-colors duration-200 cursor-pointer"
			>
				Approve
			</button>
			<button
				onclick={rejectGate}
				class="px-4 py-1.5 bg-hub-danger text-white rounded-lg text-sm font-medium hover:bg-hub-danger/80 transition-colors duration-200 cursor-pointer"
			>
				{showRejectInput ? 'Confirm Reject' : 'Reject'}
			</button>
		</div>
	</div>
{/if}

<!-- Human Input Required -->
{#if waitingForHuman}
	<div class="border-2 border-hub-info/40 bg-hub-info/5 rounded-lg p-4 space-y-4">
		<p class="text-sm text-hub-info font-medium">{humanPrompt}</p>

		{#if Object.keys(humanReviewFiles).length > 0}
			<div class="border border-hub-border rounded-lg overflow-hidden">
				<div class="px-3 py-1.5 bg-hub-panel/30 border-b border-hub-border">
					<span class="text-[10px] text-hub-dim uppercase tracking-wider font-medium">Draft for Review</span>
				</div>
				<div class="p-4 max-h-[400px] overflow-y-auto prose prose-sm prose-invert max-w-none
					prose-headings:text-hub-text prose-p:text-hub-muted prose-strong:text-hub-text
					prose-a:text-hub-cta prose-code:text-hub-muted prose-code:bg-hub-bg/50
					prose-pre:bg-hub-bg prose-pre:border prose-pre:border-hub-border
					prose-li:text-hub-muted prose-blockquote:text-hub-dim prose-blockquote:border-hub-border">
					{#each Object.entries(humanReviewFiles) as [filename, content]}
						{@html renderMarkdown(content)}
					{/each}
				</div>
			</div>
		{/if}

		<div>
			<label class="text-xs text-hub-dim mb-1 block">Your feedback</label>
			<textarea
				bind:value={humanResponse}
				rows="4"
				class="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder-hub-dim focus:outline-none focus:border-hub-info/50 resize-y"
				placeholder="Type your feedback or 'approved' if ready to publish..."
				disabled={humanSubmitting}
			></textarea>
		</div>
		<button
			onclick={submitHuman}
			disabled={!humanResponse.trim() || humanSubmitting}
			class="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors duration-200
				{humanResponse.trim() && !humanSubmitting
					? 'bg-hub-cta text-black hover:bg-hub-cta-hover cursor-pointer'
					: 'bg-hub-border text-hub-dim cursor-not-allowed'}"
		>
			{humanSubmitting ? 'Submitting...' : 'Submit'}
		</button>
	</div>
{/if}

<!-- Result (only after completion — includes phases, output, and summary) -->
{#if runResult && !running}
	<PlaybookResult
		status={runResult.status}
		phases={runResult.phases}
		{elapsed}
		{error}
	/>

	<!-- Report Files (shown after completion) -->
	{#if Object.keys(outputFiles).length > 0}
		{@const fileEntries = Object.entries(outputFiles)}
		<section>
			<h2 class="text-xs font-semibold text-hub-dim uppercase tracking-wider mb-2">Reports</h2>
			<div class="border border-hub-border rounded-lg overflow-hidden">
				<!-- Tab bar -->
				<div class="flex border-b border-hub-border bg-hub-panel/30 overflow-x-auto">
					{#each fileEntries as [path]}
						{@const label = path.replace(/\.md$/, '').split('/').pop() || path}
						<button
							onclick={() => activeReportTab = path}
							class="px-3 py-2 text-xs whitespace-nowrap border-b-2 transition-colors duration-150 cursor-pointer
								{activeReportTab === path
									? 'border-hub-cta text-hub-cta'
									: 'border-transparent text-hub-dim hover:text-hub-muted'}"
						>
							{label}
						</button>
					{/each}
				</div>
				<!-- Content -->
				<div class="p-4 max-h-[500px] overflow-y-auto">
					{#each fileEntries as [path, content]}
						{#if activeReportTab === path}
							<div class="prose prose-sm prose-invert max-w-none
							prose-headings:text-hub-text prose-p:text-hub-muted prose-strong:text-hub-text
							prose-a:text-hub-cta prose-code:text-hub-muted prose-code:bg-hub-bg/50
							prose-pre:bg-hub-bg prose-pre:border prose-pre:border-hub-border
							prose-li:text-hub-muted prose-blockquote:text-hub-dim prose-blockquote:border-hub-border
							prose-table:text-hub-muted prose-th:text-hub-text prose-td:text-hub-muted
							prose-hr:border-hub-border">
							{@html renderMarkdown(content)}
						</div>
						{/if}
					{/each}
				</div>
			</div>
		</section>
	{/if}

	<!-- Vault Notes -->
	{#if vaultNotes.length > 0}
		<div class="mt-4">
			<h3 class="text-xs font-medium text-hub-dim uppercase tracking-wider mb-2">Vault Notes</h3>
			<div class="space-y-1">
				{#each vaultNotes as note}
					<a
						href="/vault?note={encodeURIComponent(note.path)}"
						class="flex items-center gap-2 px-3 py-2 rounded-lg bg-hub-card border border-hub-border hover:border-hub-dim transition-colors text-sm text-hub-muted hover:text-hub-text"
					>
						<svg class="w-4 h-4 text-hub-dim flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
						</svg>
						<span class="truncate">{note.title}</span>
						{#if note.type}
							<span class="text-[10px] px-1.5 rounded bg-hub-surface text-hub-dim ml-auto flex-shrink-0">{note.type}</span>
						{/if}
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Event timeline (Phase 2 SoulHubEvent JSONL) -->
	{#if runId && (runResult?.status === 'completed' || runResult?.status === 'failed')}
		<details class="mt-4 border border-hub-border/40 rounded-lg overflow-hidden">
			<summary class="px-3 py-2 text-xs text-hub-muted hover:text-hub-text cursor-pointer bg-hub-card/40 flex items-center justify-between">
				<span class="font-medium">Events</span>
				<span class="text-[10px] text-hub-dim font-mono">runId: {runId}</span>
			</summary>
			<div class="h-96">
				<SoulHubRunPanel {runId} />
			</div>
		</details>
	{/if}

	<!-- Actions -->
	<div class="flex gap-2">
		{#if runResult?.status === 'failed'}
			<a
				href="/playbooks/builder?playbook={encodeURIComponent(playbookName)}&troubleshoot={encodeURIComponent(runId)}&error={encodeURIComponent(error || 'Run failed')}"
				class="flex-1 py-2.5 rounded-lg text-sm font-medium text-center bg-hub-danger/10 text-hub-danger border border-hub-danger/30 hover:bg-hub-danger/20 transition-colors duration-200 cursor-pointer"
			>
				Troubleshoot
			</a>
		{/if}
		<button
			onclick={reset}
			class="flex-1 py-2.5 rounded-lg text-sm font-medium bg-hub-panel text-hub-text border border-hub-border hover:border-hub-dim transition-colors duration-200 cursor-pointer"
		>
			Run Again
		</button>
	</div>
{/if}
