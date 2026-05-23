<script lang="ts">
	import type { OrchestrationRun } from '$lib/orchestration/types.js';

	interface MergeScanResult {
		taskId: string;
		taskName: string;
		branch: string;
		hasConflicts: boolean;
		conflictFiles: string[];
	}

	interface MergePhase {
		phase: string;
		message: string;
		current: number;
		total: number;
		scanResults?: MergeScanResult[];
	}

	const {
		run,
		mergePhase = null,
		onMergeAll,
		onMergeSingle,
		onCleanup,
	}: {
		run: OrchestrationRun;
		mergePhase?: MergePhase | null;
		onMergeAll: () => void;
		onMergeSingle: (taskId: string) => void;
		onCleanup: () => void;
	} = $props();

	let cleanupStep = $state<0 | 1 | 2>(0); // 0=idle, 1=first click, 2=confirmed
	let showLog = $state(false);

	// Use scan results from live SSE if available
	const scanResults = $derived(mergePhase?.scanResults ?? []);
	const isScanning = $derived(mergePhase?.phase === 'scanning');
	const isMerging = $derived(
		mergePhase != null && ['merging_clean', 'resolving_conflict'].includes(mergePhase.phase),
	);
	const isValidating = $derived(mergePhase?.phase === 'validating');
	const isComplete = $derived(mergePhase?.phase === 'complete');
	const mergeActive = $derived(run.status === 'merging');

	const progress = $derived.by(() => {
		if (!mergePhase || mergePhase.total === 0) return 0;
		return Math.round((mergePhase.current / mergePhase.total) * 100);
	});

	// Build per-task merge status from mergeLog (branch-based matching)
	const taskMergeStatus = $derived.by(() => {
		const status: Record<string, 'merged' | 'conflict' | 'pending'> = {};
		for (const task of run.plan.tasks) {
			const worker = run.workers[task.id];
			if (!worker || worker.status !== 'done' || !worker.branch) continue;

			const branch = worker.branch;
			const hasMerged = run.mergeLog.some(
				(l) => l.includes(branch) && (l.includes('Merged') || l.includes('(clean)') || l.includes('AI resolved') || l.includes('auto-resolved') || l.includes('already merged')),
			);
			const hasConflict = run.mergeLog.some(
				(l) => l.includes(branch) && (l.includes('could not resolve') || l.includes('manual intervention')),
			);

			if (hasMerged) status[task.id] = 'merged';
			else if (hasConflict) status[task.id] = 'conflict';
			else status[task.id] = 'pending';
		}
		return status;
	});

	const completedWorkerTasks = $derived(
		run.plan.tasks.filter((t) => {
			const w = run.workers[t.id];
			return w && w.status === 'done';
		}),
	);

	const mergedCount = $derived(
		Object.values(taskMergeStatus).filter((s) => s === 'merged').length,
	);
	const conflictCount = $derived(
		Object.values(taskMergeStatus).filter((s) => s === 'conflict').length,
	);
	const allMerged = $derived(
		completedWorkerTasks.length > 0 &&
		completedWorkerTasks.every((t) => taskMergeStatus[t.id] === 'merged'),
	);

	const conflictReports = $derived(run.conflictReports ?? []);
	const hasBlockingConflicts = $derived(
		conflictReports.some((c) => c.severity === 'block'),
	);
	const canMergeAll = $derived(
		!hasBlockingConflicts && !allMerged && completedWorkerTasks.length > 0 && !mergeActive,
	);

	const postMergeSteps = $derived(run.postMergeSteps ?? []);
	const hasPostMergeSteps = $derived(postMergeSteps.length > 0);
	let expandedStep = $state<string | null>(null);
	let logEl = $state<HTMLDivElement | null>(null);

	// Auto-scroll merge log to bottom as new entries arrive
	$effect(() => {
		if (!showLog || !logEl) return;
		run.mergeLog.length; // dependency
		queueMicrotask(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; });
	});

	function handleCleanup() {
		if (cleanupStep === 0) {
			cleanupStep = 1;
			setTimeout(() => { if (cleanupStep === 1) cleanupStep = 0; }, 5000);
		} else if (cleanupStep === 1) {
			cleanupStep = 2;
			setTimeout(() => { if (cleanupStep === 2) cleanupStep = 0; }, 5000);
		} else {
			onCleanup();
			cleanupStep = 0;
		}
	}
</script>

<div class="merge-control">
	<!-- Header -->
	<div class="merge-header">
		<span class="merge-title">Merge Control</span>
		{#if mergedCount > 0 || conflictCount > 0}
			<span class="merge-stats">
				{#if mergedCount > 0}
					<span class="stat-merged">{mergedCount} merged</span>
				{/if}
				{#if conflictCount > 0}
					<span class="stat-conflict">{conflictCount} conflicts</span>
				{/if}
			</span>
		{/if}
		<div class="merge-actions-top">
			<button
				class="btn btn-accent"
				onclick={onMergeAll}
				disabled={!canMergeAll}
				title={hasBlockingConflicts ? 'Blocking conflicts — resolve before merging' : mergeActive ? 'Merge in progress' : ''}
			>
				{#if mergeActive}
					<span class="spinner-sm"></span> Merging...
				{:else}
					Merge All
				{/if}
			</button>
		</div>
	</div>

	<!-- Live progress bar during merge -->
	{#if mergeActive && mergePhase}
		<div class="merge-progress-section">
			<div class="merge-progress-bar-bg">
				<div
					class="merge-progress-bar-fill"
					class:resolving={mergePhase.phase === 'resolving_conflict'}
					style="width: {progress}%"
				></div>
			</div>
			<div class="merge-progress-label">
				{#if isScanning}
					<span class="phase-icon scanning-icon"></span>
				{:else if mergePhase.phase === 'resolving_conflict'}
					<span class="phase-icon resolving-icon"></span>
				{:else if isValidating}
					<span class="phase-icon validating-icon"></span>
				{:else}
					<span class="phase-icon merging-icon"></span>
				{/if}
				<span class="phase-text">{mergePhase.message}</span>
				{#if mergePhase.total > 0}
					<span class="phase-count">{mergePhase.current}/{mergePhase.total}</span>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Scan results preview (shown after scan, before/during merge) -->
	{#if scanResults.length > 0}
		<div class="scan-results">
			<div class="scan-header">Scan Results</div>
			{#each scanResults as scan (scan.taskId)}
				{@const status = taskMergeStatus[scan.taskId]}
				<div class="scan-row" class:scan-clean={!scan.hasConflicts} class:scan-conflict={scan.hasConflicts} class:scan-done={status === 'merged'}>
					<span class="scan-icon">
						{#if status === 'merged'}
							<span style="color:#22c55e">&#x2713;</span>
						{:else if status === 'conflict'}
							<span style="color:#ef4444">&#x2717;</span>
						{:else if scan.hasConflicts}
							<span style="color:#f59e0b">!</span>
						{:else}
							<span style="color:#22c55e">&#x25cb;</span>
						{/if}
					</span>
					<span class="scan-name">{scan.taskName}</span>
					{#if scan.hasConflicts && status !== 'merged'}
						<span class="scan-conflict-count">{scan.conflictFiles.length} file{scan.conflictFiles.length !== 1 ? 's' : ''}</span>
					{/if}
					<span class="scan-status-label">
						{#if status === 'merged'}
							merged
						{:else if status === 'conflict'}
							failed
						{:else if scan.hasConflicts}
							needs AI
						{:else}
							clean
						{/if}
					</span>
				</div>
			{/each}
		</div>
	{:else if completedWorkerTasks.length > 0}
		<!-- Fallback: show task list from run data when no scan results -->
		<div class="scan-results">
			{#each completedWorkerTasks as task (task.id)}
				{@const status = taskMergeStatus[task.id]}
				{@const worker = run.workers[task.id]}
				<div class="scan-row" class:scan-done={status === 'merged'} class:scan-conflict={status === 'conflict'}>
					<span class="scan-icon">
						{#if status === 'merged'}
							<span style="color:#22c55e">&#x2713;</span>
						{:else if status === 'conflict'}
							<span style="color:#ef4444">&#x2717;</span>
						{:else}
							<span style="color:#888">&#x25cb;</span>
						{/if}
					</span>
					<span class="scan-name">{task.name}</span>
					<code class="scan-branch">{worker?.branch ?? ''}</code>
					<span class="scan-status-label">
						{#if status === 'merged'}merged{:else if status === 'conflict'}conflict{:else}pending{/if}
					</span>
					{#if status === 'pending' && !mergeActive}
						<button class="btn btn-sm" onclick={() => onMergeSingle(task.id)}>Merge</button>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="merge-empty">No completed workers to merge</div>
	{/if}

	<!-- Post-merge developer checklist -->
	{#if hasPostMergeSteps}
		<div class="checklist">
			<div class="checklist-header">Post-merge checklist</div>
			{#each postMergeSteps as step (step.id)}
				<div
					class="step-row"
					class:step-running={step.status === 'running'}
					class:step-passed={step.status === 'passed'}
					class:step-fixed={step.status === 'fixed'}
					class:step-failed={step.status === 'failed'}
					class:step-skipped={step.status === 'skipped'}
				>
					<button
						class="step-main"
						onclick={() => { expandedStep = expandedStep === step.id ? null : step.id; }}
						disabled={!step.output}
					>
						<span class="step-icon">
							{#if step.status === 'running'}
								<span class="step-spin"></span>
							{:else if step.status === 'passed'}
								&#x2713;
							{:else if step.status === 'fixed'}
								&#x2713;
							{:else if step.status === 'failed'}
								&#x2717;
							{:else if step.status === 'skipped'}
								&#x2013;
							{:else}
								&#x25cb;
							{/if}
						</span>
						<span class="step-name">{step.name}</span>
						{#if step.status === 'fixed'}
							<span class="step-badge step-badge-fixed">fixed by AI</span>
						{:else if !step.blocking && step.status === 'failed'}
							<span class="step-badge step-badge-advisory">advisory</span>
						{:else if step.status === 'skipped'}
							<span class="step-badge">skipped</span>
						{/if}
						{#if step.durationMs}
							<span class="step-duration">{Math.round(step.durationMs / 1000)}s</span>
						{/if}
					</button>
					{#if expandedStep === step.id && step.output}
						<pre class="step-output">{step.output}</pre>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<!-- Collapsible merge log -->
	{#if run.mergeLog.length > 0}
		<div class="merge-log-section">
			<button class="merge-log-toggle" onclick={() => showLog = !showLog}>
				<span class="merge-log-title">Merge Log ({run.mergeLog.length})</span>
				<span class="merge-log-arrow">{showLog ? 'Hide' : 'Show'}</span>
			</button>
			{#if showLog}
				<div class="merge-log" bind:this={logEl}>
					{#each run.mergeLog as entry}
						<div class="merge-log-entry">{entry}</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Cleanup: separated, 3-click confirmation -->
	<div class="cleanup-section">
		<button
			class="btn-cleanup"
			class:cleanup-warn={cleanupStep === 1}
			class:cleanup-final={cleanupStep === 2}
			onclick={handleCleanup}
		>
			{#if cleanupStep === 0}
				Cleanup Run
			{:else if cleanupStep === 1}
				Click again to confirm
			{:else}
				DELETE — this cannot be undone
			{/if}
		</button>
		{#if cleanupStep > 0}
			<span class="cleanup-hint">Deletes run data, worktrees, and branches</span>
		{/if}
	</div>
</div>

<style>
	.merge-control {
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		overflow: hidden;
	}
	.merge-header {
		padding: 10px 14px;
		border-bottom: 1px solid #1e1e2e;
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.merge-title {
		color: #e0e0e0;
		font-size: 13px;
		font-weight: 600;
	}
	.merge-stats {
		display: flex;
		gap: 8px;
		font-size: 11px;
	}
	.stat-merged { color: #22c55e; }
	.stat-conflict { color: #ef4444; }
	.merge-actions-top {
		display: flex;
		gap: 6px;
		margin-left: auto;
	}
	.merge-empty {
		padding: 20px 14px;
		color: #555;
		font-size: 13px;
		text-align: center;
	}

	/* Progress bar */
	.merge-progress-section {
		padding: 10px 14px;
		border-bottom: 1px solid #1e1e2e;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.merge-progress-bar-bg {
		height: 4px;
		background: #1e1e2e;
		border-radius: 2px;
		overflow: hidden;
	}
	.merge-progress-bar-fill {
		height: 100%;
		background: #a78bfa;
		border-radius: 2px;
		transition: width 0.4s ease;
	}
	.merge-progress-bar-fill.resolving {
		background: #f59e0b;
	}
	.merge-progress-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: #888;
	}
	.phase-icon {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.scanning-icon {
		border: 1.5px solid #3b82f6;
		border-top-color: transparent;
		animation: spin 0.6s linear infinite;
	}
	.merging-icon {
		border: 1.5px solid #a78bfa;
		border-top-color: transparent;
		animation: spin 0.6s linear infinite;
	}
	.resolving-icon {
		border: 1.5px solid #f59e0b;
		border-top-color: transparent;
		animation: spin 0.6s linear infinite;
	}
	.validating-icon {
		border: 1.5px solid #22c55e;
		border-top-color: transparent;
		animation: spin 0.6s linear infinite;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}
	.phase-text {
		color: #ccc;
	}
	.phase-count {
		color: #555;
		font-family: 'SF Mono', monospace;
		font-size: 11px;
		margin-left: auto;
	}

	/* Scan results */
	.scan-results {
		padding: 6px 14px;
	}
	.scan-header {
		color: #555;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		padding: 4px 0;
	}
	.scan-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 0;
		border-bottom: 1px solid #1a1a24;
	}
	.scan-row:last-child {
		border-bottom: none;
	}
	.scan-row.scan-done {
		opacity: 0.5;
	}
	.scan-icon {
		font-size: 12px;
		width: 16px;
		text-align: center;
		flex-shrink: 0;
	}
	.scan-name {
		color: #e0e0e0;
		font-size: 13px;
	}
	.scan-branch {
		color: #a78bfa;
		font-size: 10px;
		background: #1a1a2e;
		padding: 1px 6px;
		border-radius: 3px;
		margin-left: auto;
	}
	.scan-conflict-count {
		color: #f59e0b;
		font-size: 10px;
		font-family: 'SF Mono', monospace;
		margin-left: auto;
	}
	.scan-status-label {
		color: #555;
		font-size: 11px;
		min-width: 52px;
		text-align: right;
	}
	.scan-row.scan-conflict .scan-status-label {
		color: #ef4444;
	}
	.scan-row.scan-done .scan-status-label {
		color: #22c55e;
	}

	/* Post-merge checklist */
	.checklist {
		border-top: 1px solid #1e1e2e;
		padding: 8px 14px;
	}
	.checklist-header {
		color: #555;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		padding: 4px 0;
	}
	.step-row {
		border-bottom: 1px solid #1a1a24;
	}
	.step-row:last-child { border-bottom: none; }
	.step-main {
		width: 100%;
		background: none;
		border: none;
		padding: 6px 0;
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		color: inherit;
		font: inherit;
		text-align: left;
	}
	.step-main:disabled { cursor: default; }
	.step-main:not(:disabled):hover { background: #1a1a24; }
	.step-icon {
		width: 16px;
		text-align: center;
		font-weight: bold;
		flex-shrink: 0;
	}
	.step-passed .step-icon { color: #22c55e; }
	.step-fixed .step-icon { color: #f59e0b; }
	.step-failed .step-icon { color: #ef4444; }
	.step-skipped .step-icon { color: #555; }
	.step-name {
		font-size: 12px;
		color: #e0e0e0;
	}
	.step-failed .step-name { color: #ef4444; }
	.step-skipped .step-name { color: #888; }
	.step-badge {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		background: #1a1a2e;
		color: #888;
	}
	.step-badge-fixed {
		background: rgba(245, 158, 11, 0.15);
		color: #f59e0b;
	}
	.step-badge-advisory {
		background: rgba(107, 114, 128, 0.2);
		color: #888;
	}
	.step-duration {
		margin-left: auto;
		font-family: 'SF Mono', monospace;
		font-size: 10px;
		color: #555;
	}
	.step-spin {
		display: inline-block;
		width: 10px;
		height: 10px;
		border: 1.5px solid #a78bfa;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}
	.step-output {
		background: #0a0a10;
		color: #888;
		font-family: 'SF Mono', monospace;
		font-size: 10px;
		padding: 8px 10px;
		margin: 2px 0 6px 24px;
		border-radius: 4px;
		max-height: 220px;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	/* Collapsible log */
	.merge-log-section {
		border-top: 1px solid #1e1e2e;
	}
	.merge-log-toggle {
		width: 100%;
		padding: 8px 14px;
		background: none;
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.merge-log-toggle:hover {
		background: #1a1a24;
	}
	.merge-log-title {
		color: #555;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.merge-log-arrow {
		color: #555;
		font-size: 11px;
	}
	.merge-log {
		padding: 0 14px 8px;
	}
	.merge-log-entry {
		color: #888;
		font-size: 11px;
		font-family: 'SF Mono', monospace;
		padding: 2px 0;
	}

	/* Buttons */
	.btn {
		background: #1e1e2e;
		border: 1px solid #2a2a3e;
		color: #e0e0e0;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	.btn:hover { background: #2a2a3e; }
	.btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.btn-sm { padding: 3px 8px; }
	.btn-accent {
		border-color: #a78bfa;
		color: #a78bfa;
		padding: 5px 14px;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.btn-accent:hover { background: rgba(167, 139, 250, 0.15); }
	.btn-danger {
		border-color: #ef4444;
		color: #ef4444;
		padding: 5px 14px;
	}
	.btn-danger:hover { background: rgba(239, 68, 68, 0.15); }
	.spinner-sm {
		display: inline-block;
		width: 10px;
		height: 10px;
		border: 1.5px solid #a78bfa;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	/* Cleanup — isolated at bottom */
	.cleanup-section {
		border-top: 1px solid #1e1e2e;
		padding: 8px 14px;
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.btn-cleanup {
		background: transparent;
		border: 1px solid #333;
		color: #555;
		border-radius: 4px;
		padding: 4px 12px;
		font-size: 11px;
		cursor: pointer;
	}
	.btn-cleanup:hover { color: #888; border-color: #444; }
	.btn-cleanup.cleanup-warn {
		border-color: #f59e0b;
		color: #f59e0b;
	}
	.btn-cleanup.cleanup-final {
		border-color: #ef4444;
		color: #ef4444;
		background: rgba(239, 68, 68, 0.1);
		font-weight: 600;
	}
	.cleanup-hint {
		color: #555;
		font-size: 10px;
	}
</style>
