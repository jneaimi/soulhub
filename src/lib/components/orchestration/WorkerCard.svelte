<script lang="ts">
	import AgentTerminal from '$lib/components/AgentTerminal.svelte';
	import type { TaskNode, TaskPriority, WorkerState } from '$lib/orchestration/types.js';

	const {
		taskId,
		task,
		worker,
		allTasks = [],
		outputLines = [],
		onIntervene,
		onKill,
		onMerge,
	}: {
		taskId: string;
		task: TaskNode;
		worker: WorkerState | null;
		allTasks?: TaskNode[];
		outputLines?: string[];
		onIntervene: (taskId: string, input: string) => void;
		onKill: (taskId: string) => void;
		onMerge: (taskId: string) => void;
	} = $props();

	const priorityColors: Record<TaskPriority, string> = {
		critical: '#ef4444',
		high: '#f59e0b',
		medium: '#3b82f6',
		low: '#666',
	};

	const providerColors: Record<string, { color: string; bg: string }> = {
		'claude-code': { color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.1)' },
		'codex': { color: '#10b981', bg: 'rgba(16, 185, 129, 0.1)' },
		'shell': { color: '#6b7280', bg: 'rgba(107, 114, 128, 0.1)' },
	};

	const providerLabels: Record<string, string> = {
		'claude-code': 'Claude',
		'codex': 'Codex',
		'shell': 'Shell',
	};

	let interventionInput = $state('');
	let showConfirmKill = $state(false);
	let showPrompt = $state(false);

	const status = $derived<string>(worker?.status ?? 'pending');
	const isBlocked = $derived(status === 'blocked');
	const isRunning = $derived(status === 'running');
	const isInteractive = $derived(task.provider === 'claude-code' || !task.provider);
	const isDone = $derived(status === 'done');
	const isFailed = $derived(status === 'failed' || status === 'killed');
	const isInterrupted = $derived(status === 'interrupted');
	const isValidationFailed = $derived(status === 'validation_failed');

	const statusColor = $derived(
		status === 'done'
			? '#22c55e'
			: status === 'running'
				? '#3b82f6'
				: status === 'pending'
					? '#666'
					: status === 'blocked'
						? '#555'
						: status === 'stuck'
							? '#f59e0b'
							: status === 'interrupted'
								? '#f97316'
								: status === 'validation_failed'
									? '#f59e0b'
									: '#ef4444',
	);

	const validation = $derived(worker?.validation ?? null);
	let showValidationDetails = $state(false);

	const elapsedLabel = $derived.by(() => {
		if (!worker?.startedAt) return '—';
		const elapsed = Math.floor((now - new Date(worker.startedAt).getTime()) / 1000);
		if (elapsed < 60) return `${elapsed}s`;
		if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
		return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;
	});

	const stallCount = $derived(worker?.iterationCount ?? 0);

	let now = $state(Date.now());
	$effect(() => {
		if (!isRunning) return;
		const timer = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(timer);
	});

	const lastActivityText = $derived.by(() => {
		if (!worker || !isRunning || !worker.startedAt) return '';
		const elapsed = Math.floor((now - new Date(worker.startedAt).getTime()) / 1000);
		if (elapsed < 60) return `Active ${elapsed}s ago`;
		return `Active ${Math.floor(elapsed / 60)}m ago`;
	});

	const blockingDeps = $derived.by(() => {
		if (!isBlocked) return [] as string[];
		return task.dependsOn
			.map((id) => allTasks.find((t) => t.id === id)?.name ?? id)
			.filter(Boolean);
	});

	// Strip ANSI codes from output for display
	function stripAnsi(str: string): string {
		return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
	}

	const displayLines = $derived(outputLines.slice(-10).map(stripAnsi));

	const enhancesRef = $derived.by(() => {
		const ref = (task as unknown as { enhances?: unknown }).enhances;
		return typeof ref === 'string' && ref.trim() !== '' ? ref : null;
	});

	function handleIntervene() {
		if (interventionInput.trim()) {
			onIntervene(taskId, interventionInput.trim());
			interventionInput = '';
		}
	}

	function handleMarkDone() {
		if (!worker?.workerId) return;
		// Send /exit with Escape+Enter to gracefully close the worker
		onIntervene(taskId, '/exit');
		setTimeout(() => onIntervene(taskId, '\x1b'), 500);
		setTimeout(() => onIntervene(taskId, '\r'), 800);
	}

	function handleKill() {
		if (showConfirmKill) {
			onKill(taskId);
			showConfirmKill = false;
		} else {
			showConfirmKill = true;
			setTimeout(() => { showConfirmKill = false; }, 3000);
		}
	}
</script>

<div class="worker-card" class:blocked={isBlocked} style="border-left-color: {statusColor}">
	<div class="card-header">
		<div class="status-row">
			<span class="status-dot" style="background: {statusColor}"></span>
			<span class="task-name">{task.name}</span>
			{#if task.priority}
				<span class="priority-badge" style="color: {priorityColors[task.priority]}; border-color: {priorityColors[task.priority]}">{task.priority}</span>
			{/if}
			{#if task.provider && task.provider !== 'claude-code'}
				<span class="provider-badge" style="color: {providerColors[task.provider]?.color ?? '#888'}; background: {providerColors[task.provider]?.bg ?? '#1e1e2e'}">
					{providerLabels[task.provider] ?? task.provider}
				</span>
			{/if}
			<span class="status-label">{status}</span>
			{#if isRunning || isDone || isFailed || isInterrupted}
				<span class="iter-label">{elapsedLabel}</span>
			{/if}
			{#if stallCount > 0}
				<span class="stall-label">{stallCount} stall{stallCount > 1 ? 's' : ''}</span>
			{/if}
		</div>
		{#if task.description}
			<div class="task-desc">{task.description}</div>
		{/if}
		{#if isBlocked && blockingDeps.length > 0}
			<div class="blocked-row">
				<span class="blocked-label">Blocked by:</span>
				{#each blockingDeps as depName}
					<span class="dep-tag">{depName}</span>
				{/each}
			</div>
		{/if}
		{#if isInterrupted}
			<div class="interrupted-row">
				<span class="interrupted-icon">!</span>
				<span class="interrupted-text">Interrupted by server restart — can be resumed</span>
			</div>
		{/if}
		{#if isRunning && lastActivityText}
			<div class="health-row">
				<span class="pulse-dot"></span>
				<span class="health-text">{lastActivityText}</span>
			</div>
		{/if}
		{#if validation}
			<div class="validation-row" class:validation-pass={validation.passed} class:validation-fail={!validation.passed}>
				<button class="validation-toggle" onclick={() => { showValidationDetails = !showValidationDetails; }}>
					<span class="validation-icon">{validation.passed ? '✓' : '✗'}</span>
					<span class="validation-text">
						Pre-merge {validation.passed ? 'validation passed' : 'validation failed'}
					</span>
					<span class="validation-dur">{Math.round(validation.durationMs / 1000)}s</span>
					<span class="validation-arrow">{showValidationDetails ? '▾' : '▸'}</span>
				</button>
				{#if showValidationDetails}
					<div class="validation-steps">
						{#each validation.steps as step}
							<div class="v-step" class:v-step-pass={step.status === 'passed' || step.status === 'fixed'} class:v-step-fail={step.status === 'failed'} class:v-step-skip={step.status === 'skipped'}>
								<span class="v-step-icon">
									{#if step.status === 'passed' || step.status === 'fixed'}✓{:else if step.status === 'failed'}✗{:else}–{/if}
								</span>
								<span class="v-step-name">{step.name}</span>
								{#if step.durationMs}
									<span class="v-step-dur">{Math.round(step.durationMs / 1000)}s</span>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	{#if worker && isRunning}
		<div class="running-indicator">
			<div class="running-pulse"></div>
			<span class="running-text">Working — {elapsedLabel}</span>
		</div>
	{/if}

	{#if task.parentTask}
		{@const parent = allTasks.find(t => t.id === task.parentTask)}
		<div class="parent-row">
			<span class="parent-label">Parent:</span>
			<span class="parent-tag">{parent?.name ?? task.parentTask}</span>
		</div>
	{/if}

	{#if enhancesRef}
		<div class="enhances-badge">
			Enhances: <span class="enhances-ref">{enhancesRef}</span>
		</div>
	{/if}

	{#if worker?.branch}
		<div class="branch-row">
			<span class="branch-icon">⎇</span>
			<code class="branch-name">{worker.branch}</code>
		</div>
	{/if}

	{#if task.dependsOn.length > 0}
		<div class="deps-row">
			<span class="deps-label">Depends on:</span>
			{#each task.dependsOn as dep}
				<span class="dep-tag">{dep}</span>
			{/each}
		</div>
	{/if}

	{#if task.acceptanceCriteria && task.acceptanceCriteria.length > 0}
		<div class="criteria-section">
			<span class="criteria-label">Acceptance Criteria:</span>
			<ul class="criteria-list">
				{#each task.acceptanceCriteria as criterion}
					<li>{criterion}</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if isRunning && worker?.workerId}
		<div class="worker-terminal-wrap">
			<AgentTerminal reconnectSessionId={worker.workerId} cwd={worker.worktreePath || ''} keepAlive={true} />
		</div>
	{:else if displayLines.length > 0}
		<pre class="mini-terminal">{displayLines.join('\n')}</pre>
	{/if}

	{#if worker?.error}
		<div class="error-msg">{worker.error}</div>
	{/if}

	<div class="card-actions">
		{#if isRunning}
			{#if isInteractive}
				<div class="intervention-row">
					<input
						type="text"
						class="intervention-input"
						placeholder="Send input to worker..."
						bind:value={interventionInput}
						onkeydown={(e) => e.key === 'Enter' && handleIntervene()}
					/>
					<button class="btn btn-sm" onclick={handleIntervene} disabled={!interventionInput.trim()}>
						Send
					</button>
				</div>
			{/if}
			<button class="btn btn-sm btn-done" onclick={handleMarkDone}>
				Done
			</button>
			<button class="btn btn-sm btn-danger" onclick={handleKill}>
				{showConfirmKill ? 'Confirm Kill' : 'Kill'}
			</button>
		{/if}

		{#if isDone}
			<button class="btn btn-sm btn-accent" onclick={() => onMerge(taskId)}>Merge</button>
		{/if}

		{#if isDone || isFailed || isBlocked || isInterrupted}
			<button class="btn btn-sm" onclick={() => { showPrompt = !showPrompt; }}>
				{showPrompt ? 'Hide Prompt' : 'View Prompt'}
			</button>
		{/if}
	</div>

	{#if showPrompt}
		<pre class="prompt-preview">{task.prompt}</pre>
	{/if}
</div>

<style>
	.worker-card {
		background: #111118;
		border: 1px solid #1e1e2e;
		border-left: 3px solid #666;
		border-radius: 8px;
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.worker-card.blocked {
		background-image: repeating-linear-gradient(
			45deg,
			#111118,
			#111118 6px,
			#15151f 6px,
			#15151f 12px
		);
	}
	.blocked-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 16px;
		flex-wrap: wrap;
	}
	.blocked-label {
		color: #f59e0b;
		font-size: 11px;
		font-weight: 600;
	}
	.interrupted-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 16px;
	}
	.interrupted-icon {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: #f97316;
		color: #0a0a0f;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		font-weight: 700;
		flex-shrink: 0;
	}
	.interrupted-text {
		color: #f97316;
		font-size: 11px;
	}
	.health-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 16px;
	}
	.pulse-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #3b82f6;
		animation: pulse 1.5s ease-in-out infinite;
	}
	.health-text {
		color: #888;
		font-size: 11px;
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.3; }
	}

	/* Pre-merge validation */
	.validation-row {
		margin-top: 6px;
		padding: 6px 10px;
		border-radius: 4px;
		border: 1px solid #1e1e2e;
	}
	.validation-row.validation-pass {
		border-color: rgba(34, 197, 94, 0.3);
		background: rgba(34, 197, 94, 0.05);
	}
	.validation-row.validation-fail {
		border-color: rgba(245, 158, 11, 0.4);
		background: rgba(245, 158, 11, 0.08);
	}
	.validation-toggle {
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
		font: inherit;
		color: inherit;
		text-align: left;
	}
	.validation-icon {
		font-weight: bold;
	}
	.validation-pass .validation-icon { color: #22c55e; }
	.validation-fail .validation-icon { color: #f59e0b; }
	.validation-text {
		font-size: 11px;
		color: #ccc;
	}
	.validation-pass .validation-text { color: #22c55e; }
	.validation-fail .validation-text { color: #f59e0b; }
	.validation-dur {
		margin-left: auto;
		font-family: 'SF Mono', monospace;
		font-size: 10px;
		color: #555;
	}
	.validation-arrow {
		color: #666;
		font-size: 10px;
	}
	.validation-steps {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px dashed #2a2a3e;
	}
	.v-step {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 0;
		font-size: 11px;
	}
	.v-step-icon {
		width: 12px;
		text-align: center;
		font-weight: bold;
	}
	.v-step-pass .v-step-icon { color: #22c55e; }
	.v-step-fail .v-step-icon { color: #ef4444; }
	.v-step-skip .v-step-icon { color: #555; }
	.v-step-name { color: #ccc; }
	.v-step-fail .v-step-name { color: #ef4444; }
	.v-step-skip .v-step-name { color: #666; }
	.v-step-dur {
		margin-left: auto;
		font-family: 'SF Mono', monospace;
		font-size: 10px;
		color: #555;
	}
	.running-indicator {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.running-pulse {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #3b82f6;
		animation: pulse 1.5s ease-in-out infinite;
	}
	.running-text {
		color: #3b82f6;
		font-size: 11px;
		font-family: 'SF Mono', monospace;
	}
	.stall-label {
		color: #f59e0b;
		font-size: 11px;
		font-family: 'SF Mono', monospace;
	}
	.card-header {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.status-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.task-name {
		color: #e0e0e0;
		font-weight: 600;
		font-size: 14px;
	}
	.status-label {
		color: #888;
		font-size: 12px;
		margin-left: auto;
	}
	.iter-label {
		color: #888;
		font-size: 12px;
	}
	.task-desc {
		color: #888;
		font-size: 12px;
		padding-left: 16px;
	}
	.branch-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 16px;
	}
	.branch-icon {
		color: #888;
		font-size: 12px;
	}
	.branch-name {
		color: #a78bfa;
		font-size: 12px;
		background: #1a1a2e;
		padding: 1px 6px;
		border-radius: 3px;
	}
	.deps-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 16px;
		flex-wrap: wrap;
	}
	.deps-label {
		color: #888;
		font-size: 11px;
	}
	.dep-tag {
		color: #e0e0e0;
		font-size: 11px;
		background: #1a1a2e;
		padding: 1px 6px;
		border-radius: 3px;
	}
	.priority-badge {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		border: 1px solid;
		text-transform: uppercase;
		letter-spacing: 0.3px;
		font-weight: 600;
	}
	.provider-badge {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		font-weight: 500;
		letter-spacing: 0.2px;
	}
	.parent-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 16px;
	}
	.parent-label {
		color: #888;
		font-size: 11px;
	}
	.parent-tag {
		color: #a78bfa;
		font-size: 11px;
		background: rgba(167, 139, 250, 0.1);
		padding: 1px 6px;
		border-radius: 3px;
	}
	.enhances-badge {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 16px;
		color: #888;
		font-size: 11px;
	}
	.enhances-ref {
		color: #a78bfa;
		font-family: 'SF Mono', monospace;
		background: rgba(167, 139, 250, 0.1);
		padding: 1px 6px;
		border-radius: 3px;
	}
	.criteria-section {
		padding-left: 16px;
	}
	.criteria-label {
		color: #888;
		font-size: 11px;
	}
	.criteria-list {
		margin: 4px 0 0 16px;
		padding: 0;
		list-style: disc;
	}
	.criteria-list li {
		color: #ccc;
		font-size: 11px;
		line-height: 1.4;
	}
	.worker-terminal-wrap {
		height: 200px;
		border-radius: 4px;
		overflow: hidden;
		border: 1px solid #1e1e2e;
	}
	.mini-terminal {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 8px 10px;
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 11px;
		color: #ccc;
		line-height: 1.4;
		max-height: 160px;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-all;
		margin: 0;
	}
	.mini-terminal.dim {
		color: #555;
		font-style: italic;
	}
	.error-msg {
		color: #ef4444;
		font-size: 12px;
		padding: 4px 8px;
		background: rgba(239, 68, 68, 0.1);
		border-radius: 4px;
	}
	.card-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.intervention-row {
		display: flex;
		gap: 4px;
		flex: 1;
		min-width: 200px;
	}
	.intervention-input {
		flex: 1;
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 4px 8px;
		color: #e0e0e0;
		font-size: 12px;
		font-family: 'SF Mono', 'Fira Code', monospace;
		outline: none;
	}
	.intervention-input:focus {
		border-color: #a78bfa;
	}
	.btn {
		background: #1e1e2e;
		border: 1px solid #2a2a3e;
		color: #e0e0e0;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	.btn:hover {
		background: #2a2a3e;
	}
	.btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.btn-sm {
		padding: 4px 10px;
	}
	.btn-done {
		border-color: #22c55e;
		color: #22c55e;
	}
	.btn-done:hover {
		background: rgba(34, 197, 94, 0.15);
	}
	.btn-danger {
		border-color: #ef4444;
		color: #ef4444;
	}
	.btn-danger:hover {
		background: rgba(239, 68, 68, 0.15);
	}
	.btn-accent {
		border-color: #a78bfa;
		color: #a78bfa;
	}
	.btn-accent:hover {
		background: rgba(167, 139, 250, 0.15);
	}
	.prompt-preview {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 8px 10px;
		font-size: 11px;
		color: #888;
		line-height: 1.4;
		max-height: 120px;
		overflow-y: auto;
		white-space: pre-wrap;
		margin: 0;
	}
</style>
