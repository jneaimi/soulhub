<script lang="ts">
	import type { ConflictReport, OrchestrationRun, PostMergeStepResult, RunStatus, WorkerState } from '$lib/orchestration/types.js';
	import AgentTerminal from '$lib/components/AgentTerminal.svelte';
	import WorkerCard from '$lib/components/orchestration/WorkerCard.svelte';
	import BoardView from '$lib/components/orchestration/BoardView.svelte';
	import PlanEditor from '$lib/components/orchestration/PlanEditor.svelte';
	import MergeControl from '$lib/components/orchestration/MergeControl.svelte';
	import GanttView from '$lib/components/orchestration/GanttView.svelte';

	const { data } = $props();

	let run: OrchestrationRun = $state(data.run);
	let board = $state('');
	let boardRequests: Array<{ taskId: string; content: string }> = $state([]);
	let workerOutputs: Record<string, string[]> = $state({});
	let sseConnected = $state(false);
	let error = $state('');
	let generating = $state(false);
	let pmSessionId = $state<string | null>(null);
	let pmCollapsed = $state(false);
	let viewMode = $state<'cards' | 'gantt'>('cards');
	let resuming = $state(false);
	let mergePhase = $state<{ phase: string; message: string; current: number; total: number; scanResults?: Array<{ taskId: string; taskName: string; branch: string; hasConflicts: boolean; conflictFiles: string[] }> } | null>(null);
	let taskPollTimer: ReturnType<typeof setInterval> | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	const isActive = $derived(
		run.status === 'running' || run.status === 'approved' || run.status === 'merging',
	);

	const isPlanning = $derived(run.status === 'planning');
	const isDone = $derived(run.status === 'done');
	const isFailed = $derived(run.status === 'failed' || run.status === 'cancelled');

	const statusColors: Record<RunStatus, string> = {
		planning: '#888',
		approved: '#3b82f6',
		running: '#3b82f6',
		merging: '#f59e0b',
		done: '#22c55e',
		failed: '#ef4444',
		cancelled: '#888',
		archived: '#555',
	};

	const doneTasks = $derived(
		Object.entries(run.workers).filter(([id, w]) => id !== '_pm' && w.status === 'done').length,
	);
	const totalTasks = $derived(run.plan.tasks.length);

	const interruptedWorkers = $derived(
		Object.entries(run.workers).filter(
			([id, w]) => id !== '_pm' && (w.status as string) === 'interrupted',
		),
	);
	const interruptedCount = $derived(interruptedWorkers.length);
	const hasInterrupted = $derived(interruptedCount > 0);

	const conflictReports = $derived(run.conflictReports ?? []);
	const blockingConflictCount = $derived(
		conflictReports.filter((c) => c.severity === 'block').length,
	);
	let conflictsExpanded = $state(false);

	function cleanConflictFile(raw: string): string {
		// Raw format from git merge-tree: "100644 abc123 1 path/to/file.ts"
		const parts = raw.trim().split(/\s+/);
		if (parts.length >= 4 && /^\d{6}$/.test(parts[0])) {
			return parts.slice(3).join(' ');
		}
		return raw.trim();
	}

	function uniqueConflictFiles(files: string[]): string[] {
		const cleaned = files.map(cleanConflictFile).filter((f) => f.length > 0);
		return [...new Set(cleaned)];
	}

	function stripAnsi(str: string): string {
		return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
	}
	const failureSummaries = $derived(run.failureSummaries ?? []);

	// Task polling — picks up tasks created/updated by PM via API
	let lastTaskSnapshot = '';

	function taskFingerprint(tasks: typeof run.plan.tasks): string {
		return tasks.map(t => `${t.id}:${t.name}:${t.dependsOn.join(',')}:${t.fileOwnership.join(',')}:${t.priority}:${t.estimatedComplexity}`).join('|');
	}

	let taskPollCount = 0;

	function startTaskPolling() {
		if (taskPollTimer) return;
		lastTaskSnapshot = taskFingerprint(run.plan.tasks);
		taskPollTimer = setInterval(async () => {
			taskPollCount++;
			const res = await fetch(`/api/orchestration/${run.runId}/tasks`);
			if (res.ok) {
				const taskData = await res.json();
				if (taskData.tasks) {
					const newSnapshot = taskFingerprint(taskData.tasks);
					// Refresh on fingerprint change OR every 5th poll (catch subtle changes)
					if (newSnapshot !== lastTaskSnapshot || taskPollCount % 5 === 0) {
						lastTaskSnapshot = newSnapshot;
						await refreshRun();
					}
				}
			}
			// Check if PM died
			const pmWorker = run.workers['_pm'];
			if (pmWorker && pmWorker.status === 'failed') {
				stopTaskPolling();
				generating = false;
				error = 'PM session failed — try again or add tasks manually';
			}
		}, 3000);
	}

	function stopTaskPolling() {
		if (taskPollTimer) {
			clearInterval(taskPollTimer);
			taskPollTimer = null;
		}
	}

	// Poll for run state and board when SSE isn't connected
	function startPolling() {
		if (pollTimer) return;
		pollTimer = setInterval(async () => {
			try {
				const [runRes, boardRes] = await Promise.all([
					fetch(`/api/orchestration/${run.runId}`),
					fetch(`/api/orchestration/${run.runId}/board`),
				]);
				if (runRes.ok) {
					const updated = await runRes.json();
					run = updated;
				}
				if (boardRes.ok) {
					const bd = await boardRes.json();
					board = bd.board;
					boardRequests = bd.requests;
				}
			} catch { /* ignore polling errors */ }
		}, 3000);
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// Generate plan via interactive PM session (headless PTY)
	async function generatePlan() {
		generating = true;
		error = '';

		try {
			const res = await fetch(`/api/orchestration/${run.runId}/plan`, {
				method: 'PATCH',
			});

			const result = await res.json();
			if (!res.ok) {
				error = result.error || 'Plan generation failed';
				generating = false;
				return;
			}

			pmSessionId = result.sessionId;
			startTaskPolling();
			// Auto-clear generating after 10s — PM needs time to read codebase
			setTimeout(() => { generating = false; }, 10000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Network error';
			generating = false;
		}
	}

	// Approve plan and start SSE stream
	async function approvePlan() {
		error = '';

		// Keep PM alive for execution-phase consultation; just stop task polling and collapse
		stopTaskPolling();
		pmCollapsed = true;

		try {
			const res = await fetch(`/api/orchestration/${run.runId}/plan`, {
				method: 'PUT',
			});

			if (!res.ok) {
				const body = await res.json();
				error = body.error || 'Failed to approve plan';
				return;
			}

			// Read SSE stream
			const reader = res.body?.getReader();
			if (!reader) {
				startPolling();
				return;
			}

			sseConnected = true;
			const decoder = new TextDecoder();
			let buffer = '';

			try {
				while (true) {
					const { done: streamDone, value } = await reader.read();
					if (streamDone) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					let currentEvent = '';
					for (const line of lines) {
						if (line.startsWith('event: ')) {
							currentEvent = line.slice(7);
						} else if (line.startsWith('data: ')) {
							const raw = line.slice(6);
							if (raw === '[DONE]') {
								sseConnected = false;
								await refreshRun();
								return;
							}
							try {
								const payload = JSON.parse(raw);
								handleSSEEvent(currentEvent, payload);
							} catch { /* skip malformed data */ }
							currentEvent = '';
						}
					}
				}
			} finally {
				reader.releaseLock();
				sseConnected = false;
				startPolling();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'SSE connection failed';
			sseConnected = false;
			startPolling();
		}
	}

	function killPm() {
		if (!pmSessionId) return;
		fetch('/api/pty', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'kill', sessionId: pmSessionId }),
		}).catch(() => {});
		pmSessionId = null;
		stopTaskPolling();
	}

	function handleSSEEvent(event: string, payload: Record<string, unknown>) {
		if (event === 'approved') {
			run = { ...run, status: 'running', startedAt: new Date().toISOString() };
		} else if (event === 'worker_dispatched') {
			const { taskId, workerId } = payload as { taskId: string; workerId: string };
			const newWorker: WorkerState = {
				taskId,
				workerId,
				status: 'running',
				worktreePath: '',
				branch: `orch/${run.runId}/${taskId}`,
				iterationCount: 0,
				startedAt: new Date().toISOString(),
			};
			run = { ...run, workers: { ...run.workers, [taskId]: newWorker } };
		} else if (event === 'worker_output') {
			const { taskId, data: outputData } = payload as { taskId: string; data: string };
			const existing = workerOutputs[taskId] ?? [];
			const newLines = outputData.split('\n');
			const combined = [...existing, ...newLines];
			workerOutputs = { ...workerOutputs, [taskId]: combined.slice(-200) };
		} else if (event === 'worker_exit') {
			const { taskId, exitCode, resolvedStatus } = payload as { taskId: string; exitCode: number; resolvedStatus?: string };
			const w = run.workers[taskId];
			if (w) {
				// Use server-resolved status if available (handles exit code 129 = done on macOS)
				const status = resolvedStatus || (exitCode === 0 ? 'done' : 'failed');
				const updated: WorkerState = {
					...w,
					status: status as WorkerState['status'],
					completedAt: new Date().toISOString(),
				};
				run = { ...run, workers: { ...run.workers, [taskId]: updated } };
			}
			// Refresh to pick up validation data written after the transition
			refreshRun();
		} else if (event === 'worker_validation_step') {
			// Live per-step progress during pre-merge validation (optional fine-grain update).
			// Final state is also pulled via refreshRun after worker_exit.
			refreshRun();
		} else if (event === 'run_status') {
			const { status } = payload as { status: RunStatus };
			run = { ...run, status };
		} else if (event === 'conflicts_detected') {
			const { conflicts } = payload as { conflicts: ConflictReport[] };
			run = { ...run, conflictReports: conflicts };
		} else if (event === 'merge_progress') {
			const { phase, message, current, total, scanResults } = payload as {
				phase: string; message: string; current: number; total: number;
				scanResults?: Array<{ taskId: string; taskName: string; branch: string; hasConflicts: boolean; conflictFiles: string[] }>;
			};
			mergePhase = { phase, message, current, total, scanResults: scanResults ?? mergePhase?.scanResults };
			// Refresh run data periodically during merge to pick up mergeLog updates
			if (phase === 'scan_complete' || phase === 'complete' || current % 2 === 0) {
				refreshRun();
			}
			// Clear phase when merge is done
			if (phase === 'complete') {
				setTimeout(() => { mergePhase = null; }, 5000);
			}
		} else if (event === 'post_merge_step') {
			// Live post-merge checklist progress. Merge new step result into run state.
			const step = payload as unknown as PostMergeStepResult;
			const existing = run.postMergeSteps ?? [];
			const idx = existing.findIndex((s) => s.id === step.id);
			const next = [...existing];
			if (idx >= 0) next[idx] = step;
			else next.push(step);
			run = { ...run, postMergeSteps: next };
		} else if (event === 'pm_notification') {
			// PM notification — already delivered to PM terminal session; refresh run for updated state
			refreshRun();
		}
	}

	async function refreshRun() {
		try {
			const [runRes, boardRes] = await Promise.all([
				fetch(`/api/orchestration/${run.runId}`),
				fetch(`/api/orchestration/${run.runId}/board`),
			]);
			if (runRes.ok) run = await runRes.json();
			if (boardRes.ok) {
				const bd = await boardRes.json();
				board = bd.board;
				boardRequests = bd.requests;
			}
		} catch { /* ignore */ }
	}

	async function handleIntervene(taskId: string, input: string) {
		try {
			await fetch(`/api/orchestration/${run.runId}/workers`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'intervene', taskId, input }),
			});
		} catch { /* ignore */ }
	}

	async function handleKill(taskId: string) {
		try {
			const res = await fetch(`/api/orchestration/${run.runId}/workers`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'kill', taskId }),
			});
			if (res.ok) await refreshRun();
		} catch { /* ignore */ }
	}

	async function handleMergeSingle(taskId: string) {
		try {
			const res = await fetch(`/api/orchestration/${run.runId}/merge`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ taskId }),
			});
			if (res.ok) await refreshRun();
		} catch { /* ignore */ }
	}

	async function handleMergeAll() {
		// Optimistic disable: flip to 'merging' locally so the button disables
		// immediately, without waiting for the SSE round-trip.
		mergePhase = { phase: 'starting', message: 'Starting merge...', current: 0, total: 0 };
		if (run.status !== 'merging') run = { ...run, status: 'merging' };
		try {
			const res = await fetch(`/api/orchestration/${run.runId}/merge`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			if (res.ok) await refreshRun();
			else {
				const body = await res.json().catch(() => ({}));
				error = body.error || 'Failed to start merge';
				// Revert optimistic flip on failure
				await refreshRun();
			}
		} catch { await refreshRun(); }
	}

	async function handleCancel() {
		try {
			await fetch(`/api/orchestration/${run.runId}`, { method: 'DELETE' });
			await refreshRun();
		} catch { /* ignore */ }
	}

	async function handleReopen() {
		try {
			const res = await fetch(`/api/orchestration/${run.runId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reopen' }),
			});
			if (res.ok) await refreshRun();
			else {
				const body = await res.json();
				error = body.error || 'Failed to reopen';
			}
		} catch { /* ignore */ }
	}

	async function handleResume() {
		resuming = true;
		error = '';

		try {
			const res = await fetch(`/api/orchestration/${run.runId}/resume`, {
				method: 'POST',
			});

			if (!res.ok) {
				const body = await res.json();
				error = body.error || 'Resume failed';
				resuming = false;
				return;
			}

			const reader = res.body?.getReader();
			if (!reader) {
				await refreshRun();
				resuming = false;
				return;
			}

			sseConnected = true;
			const decoder = new TextDecoder();
			let buffer = '';

			try {
				while (true) {
					const { done: streamDone, value } = await reader.read();
					if (streamDone) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					let currentEvent = '';
					for (const line of lines) {
						if (line.startsWith('event: ')) {
							currentEvent = line.slice(7);
						} else if (line.startsWith('data: ')) {
							const raw = line.slice(6);
							if (raw === '[DONE]') {
								sseConnected = false;
								await refreshRun();
								resuming = false;
								return;
							}
							try {
								const payload = JSON.parse(raw);
								if (currentEvent === 'resumed') {
									await refreshRun();
								} else {
									handleSSEEvent(currentEvent, payload);
								}
							} catch { /* skip malformed */ }
							currentEvent = '';
						}
					}
				}
			} finally {
				reader.releaseLock();
				sseConnected = false;
				resuming = false;
				startPolling();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Resume failed';
			resuming = false;
		}
	}

	async function handleCleanup() {
		try {
			await fetch(`/api/orchestration/${run.runId}?deleteBranches=true`, { method: 'DELETE' });
			await refreshRun();
		} catch { /* ignore */ }
	}

	// On mount: reconnect to PM session if one exists, start polling
	$effect(() => {
		if (isActive && !sseConnected) {
			startPolling();
			refreshRun();
		}

		return () => { stopPolling(); };
	});

	// PM reconnection — separate effect so it doesn't kill task polling
	$effect(() => {
		if ((isPlanning || isActive) && !pmSessionId) {
			const pmWorker = run.workers['_pm'];
			if (pmWorker && pmWorker.status === 'running') {
				fetch(`/api/sessions/${pmWorker.workerId}`).then(res => {
					if (res.ok) {
						return res.json();
					}
					return null;
				}).then(data => {
					if (data && data.alive) {
						pmSessionId = pmWorker.workerId;
						pmCollapsed = isActive || run.plan.tasks.length > 0;
						if (isPlanning) startTaskPolling();
					}
				}).catch(() => {});
			}
		}
	});

	// Task polling cleanup on unmount
	$effect(() => {
		return () => { stopTaskPolling(); };
	});
</script>

<div class="run-page">
<div class="run-detail">
	<!-- Header -->
	<div class="run-header">
		<div class="header-top">
			<a href="/workspace/{data.projectName}/orchestration" class="back-link">&larr; Back</a>
			<span class="header-goal">{run.plan.goal}</span>
			<div class="header-actions">
				{#if isActive}
					<button class="btn btn-danger-sm" onclick={handleCancel}>Cancel</button>
				{/if}
				{#if isFailed && !hasInterrupted}
					<button class="btn btn-accent-sm" onclick={handleReopen}>Reopen</button>
				{/if}
				{#if isActive || isDone}
					<button class="btn btn-accent-sm" onclick={handleMergeAll}>Merge All</button>
				{/if}
			</div>
		</div>
		<div class="header-meta">
			<span class="run-id-label">Run: {run.runId}</span>
			<span class="status-badge" style="color: {statusColors[run.status]}">
				<span class="status-dot" style="background: {statusColors[run.status]}"></span>
				{run.status}
			</span>
			{#if totalTasks > 0}
				<span class="worker-progress">
					{doneTasks}/{totalTasks} workers done
					{#if interruptedCount > 0}
						<span class="interrupted-count">({interruptedCount} interrupted)</span>
					{/if}
				</span>
			{/if}
			{#if sseConnected}
				<span class="sse-indicator">LIVE</span>
			{/if}
		</div>
	</div>

	{#if error}
		<div class="error-banner">{error}</div>
	{/if}

	{#if conflictReports.length > 0}
		<div class="conflict-banner">
			<button class="conflict-banner-header" onclick={() => conflictsExpanded = !conflictsExpanded}>
				<span class="conflict-icon">!</span>
				<span class="conflict-title">
					{#if blockingConflictCount > 0}
						{blockingConflictCount} blocking conflict{blockingConflictCount !== 1 ? 's' : ''} detected
					{:else}
						{conflictReports.length} conflict warning{conflictReports.length !== 1 ? 's' : ''}
					{/if}
				</span>
				<span class="conflict-toggle">{conflictsExpanded ? 'Hide' : 'Show details'}</span>
			</button>
			{#if conflictsExpanded}
				{#each conflictReports as conflict}
					<div
						class="conflict-item"
						class:conflict-block={conflict.severity === 'block'}
						class:conflict-warn={conflict.severity === 'warn'}
					>
						<div class="conflict-head-row">
							<span class="conflict-severity">{conflict.severity === 'block' ? 'BLOCK' : conflict.severity === 'warn' ? 'WARN' : 'INFO'}</span>
							<span class="conflict-desc">{conflict.description}</span>
						</div>
						{#if conflict.files.length > 0}
							{@const cleanFiles = uniqueConflictFiles(conflict.files)}
							{#if cleanFiles.length > 0}
								<div class="conflict-files">
									{#each cleanFiles.slice(0, 5) as file}
										<code class="conflict-file">{file}</code>
									{/each}
									{#if cleanFiles.length > 5}
										<span class="conflict-more">+{cleanFiles.length - 5} more</span>
									{/if}
								</div>
							{/if}
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	{/if}

	{#if failureSummaries.length > 0 && !isPlanning}
		<div class="failure-summary-section">
			<div class="failure-summary-header">
				<span class="failure-title">Failure Summary</span>
				<span class="failure-count">{failureSummaries.length} failure{failureSummaries.length !== 1 ? 's' : ''}</span>
			</div>
			{#each failureSummaries as failure}
				<div class="failure-item">
					<div class="failure-task-row">
						<span class="failure-dot"></span>
						<span class="failure-task-name">{failure.taskName}</span>
						<span class="failure-iterations">{failure.iterationsUsed} stall{failure.iterationsUsed !== 1 ? 's' : ''}</span>
					</div>
					<div class="failure-error">{failure.error}</div>
					{#if failure.lastOutput}
						<pre class="failure-output">{stripAnsi(failure.lastOutput).slice(0, 300)}</pre>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if pmSessionId}
		<div class="pm-session-section" class:pm-active={isActive}>
			<button class="pm-header" onclick={() => pmCollapsed = !pmCollapsed}>
				{#if generating}
					<span class="pm-badge"><span class="spinner"></span> PM Analyzing...</span>
				{:else if isActive}
					<span class="pm-badge pm-badge-live">PM Advisor</span>
				{:else}
					<span class="pm-badge pm-badge-ready">PM Session</span>
				{/if}
				<span class="pm-hint">
					{#if generating}
						The PM is reading your codebase and generating tasks.
					{:else if isActive}
						PM is monitoring workers. Ask questions or request advice.
					{:else}
						Review the tasks below. Ask the PM to adjust, add details, or re-generate.
					{/if}
				</span>
				<span class="pm-header-actions">
					{#if !generating}
						<span
							class="pm-kill-link"
							role="button"
							tabindex="0"
							onclick={(e) => { e.stopPropagation(); killPm(); }}
							onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); killPm(); } }}
						>Kill</span>
					{/if}
					<span class="pm-toggle">{pmCollapsed ? 'Show' : 'Hide'}</span>
				</span>
			</button>
			<div class="pm-terminal-wrap" class:pm-hidden={pmCollapsed}>
				<AgentTerminal reconnectSessionId={pmSessionId} cwd={data.projectPath ?? ''} keepAlive={true} />
			</div>
		</div>
	{:else if isActive && !generating}
		<div class="pm-session-section pm-dead">
			<div class="pm-header">
				<span class="pm-badge" style="color: #555">PM Session Ended</span>
				<span class="pm-hint">The PM session is no longer active. You can reopen it to consult on failures or plan changes.</span>
				<button class="btn btn-accent-sm" onclick={generatePlan}>Reopen PM</button>
			</div>
		</div>
	{/if}

	{#if hasInterrupted && isFailed}
		<div class="recovery-banner">
			<div class="recovery-header">
				<span class="recovery-icon">!</span>
				<span class="recovery-title">Run Interrupted</span>
			</div>
			<p class="recovery-desc">
				This run was interrupted by a server restart. {interruptedCount} worker{interruptedCount > 1 ? 's' : ''} need{interruptedCount === 1 ? 's' : ''} to be re-dispatched.
				Completed workers will be preserved.
			</p>
			<div class="recovery-workers">
				{#each interruptedWorkers as [taskId, _worker] (taskId)}
					{@const task = run.plan.tasks.find(t => t.id === taskId)}
					<div class="recovery-worker-item">
						<span class="recovery-worker-dot"></span>
						<span class="recovery-worker-name">{task?.name ?? taskId}</span>
						<span class="recovery-worker-status">interrupted</span>
					</div>
				{/each}
			</div>
			<div class="recovery-actions">
				<button class="btn-resume" onclick={handleResume} disabled={resuming}>
					{#if resuming}
						<span class="spinner"></span> Resuming...
					{:else}
						Resume Run
					{/if}
				</button>
				<button class="btn btn-accent-sm" onclick={handleReopen}>
					Reopen as Planning
				</button>
			</div>
		</div>
	{/if}

	<!-- Planning state: Generate + Review + Approve -->
	{#if isPlanning}
		{#if !pmSessionId && !generating}
			<div class="generate-section">
				{#if run.plan.tasks.length === 0}
					<p class="generate-hint">The PM will analyze your codebase and break the goal into parallel tasks for worker agents.</p>
					<button class="btn-generate" onclick={generatePlan}>
						Generate Plan
					</button>
					<p class="generate-or">or add tasks manually below</p>
				{:else}
					<button class="btn-generate btn-generate-secondary" onclick={generatePlan}>
						Open PM Session
					</button>
					<p class="generate-or">Discuss and refine the plan with the PM</p>
				{/if}
			</div>
		{/if}

		{#if !pmSessionId && generating}
			<div class="generate-section">
				<span class="spinner"></span>
				<p class="generate-hint">Spawning PM session...</p>
			</div>
		{/if}
		<PlanEditor
			plan={run.plan}
			runId={run.runId}
			onApprove={approvePlan}
			onEdit={async () => { await refreshRun(); }}
		/>

		{#if run.plan.tasks.length > 0}
			<div class="view-toggle-row">
				<span class="view-toggle-label">Preview</span>
				<div class="view-toggle">
					<button class="toggle-btn" class:active={viewMode === 'cards'} onclick={() => viewMode = 'cards'}>Cards</button>
					<button class="toggle-btn" class:active={viewMode === 'gantt'} onclick={() => viewMode = 'gantt'}>Gantt</button>
				</div>
			</div>
			{#if viewMode === 'gantt'}
				<GanttView tasks={run.plan.tasks} workers={run.workers} />
			{/if}
		{/if}
	{/if}

	<!-- Active/Done/Failed: show worker grid -->
	{#if !isPlanning}
		<div class="view-toggle-row">
			<span class="view-toggle-label">Workers</span>
			<div class="view-toggle">
				<button class="toggle-btn" class:active={viewMode === 'cards'} onclick={() => viewMode = 'cards'}>Cards</button>
				<button class="toggle-btn" class:active={viewMode === 'gantt'} onclick={() => viewMode = 'gantt'}>Gantt</button>
			</div>
		</div>

		{#if viewMode === 'cards'}
			<div class="worker-grid">
				{#each run.plan.tasks as task (task.id)}
					<WorkerCard
						taskId={task.id}
						{task}
						worker={run.workers[task.id] ?? null}
						allTasks={run.plan.tasks}
						outputLines={workerOutputs[task.id] ?? []}
						onIntervene={handleIntervene}
						onKill={handleKill}
						onMerge={handleMergeSingle}
					/>
				{/each}
			</div>
		{:else}
			<GanttView tasks={run.plan.tasks} workers={run.workers} />
		{/if}

		<!-- Merge controls -->
		{#if run.status === 'merging' || isDone || run.mergeLog.length > 0}
			<MergeControl
				{run}
				{mergePhase}
				onMergeAll={handleMergeAll}
				onMergeSingle={handleMergeSingle}
				onCleanup={handleCleanup}
			/>
		{/if}

		<!-- Board -->
		<BoardView {board} requests={boardRequests} />
	{/if}
</div>
</div>

<style>
	.run-page {
		height: 100vh;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}
	.run-detail {
		max-width: 960px;
		margin: 0 auto;
		padding: 24px 20px 80px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.run-header {
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 14px 16px;
	}
	.header-top {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 8px;
	}
	.back-link {
		color: #888;
		text-decoration: none;
		font-size: 13px;
		flex-shrink: 0;
	}
	.back-link:hover {
		color: #a78bfa;
	}
	.header-goal {
		color: #e0e0e0;
		font-size: 16px;
		font-weight: 600;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.header-actions {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}
	.header-meta {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.run-id-label {
		color: #555;
		font-size: 11px;
		font-family: 'SF Mono', monospace;
	}
	.status-badge {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
	}
	.status-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		display: inline-block;
	}
	.worker-progress {
		color: #888;
		font-size: 12px;
	}
	.sse-indicator {
		color: #22c55e;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 1px;
		padding: 2px 6px;
		background: rgba(34, 197, 94, 0.1);
		border-radius: 3px;
	}
	.error-banner {
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.3);
		border-radius: 6px;
		padding: 10px 14px;
		color: #ef4444;
		font-size: 13px;
	}
	.recovery-banner {
		background: rgba(249, 115, 22, 0.06);
		border: 1px solid rgba(249, 115, 22, 0.25);
		border-radius: 8px;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.recovery-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.recovery-icon {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: #f97316;
		color: #0a0a0f;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
		flex-shrink: 0;
	}
	.recovery-title {
		color: #f97316;
		font-size: 15px;
		font-weight: 600;
	}
	.recovery-desc {
		color: #888;
		font-size: 13px;
		margin: 0;
		line-height: 1.5;
	}
	.recovery-workers {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.recovery-worker-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-left: 4px;
	}
	.recovery-worker-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #f97316;
		flex-shrink: 0;
	}
	.recovery-worker-name {
		color: #e0e0e0;
		font-size: 12px;
	}
	.recovery-worker-status {
		color: #f97316;
		font-size: 11px;
		font-family: 'SF Mono', monospace;
		margin-left: auto;
	}
	.recovery-actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.btn-resume {
		background: #f97316;
		color: #0a0a0f;
		border: none;
		border-radius: 6px;
		padding: 8px 20px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.btn-resume:hover:not(:disabled) {
		background: #fb923c;
	}
	.btn-resume:disabled {
		opacity: 0.7;
		cursor: wait;
	}
	.interrupted-count {
		color: #f97316;
		font-size: 11px;
	}
	.worker-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 12px;
	}
	.view-toggle-row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.view-toggle-label {
		color: #888;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.view-toggle {
		display: flex;
		gap: 2px;
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 2px;
		width: fit-content;
	}
	.toggle-btn {
		padding: 4px 14px;
		border: none;
		background: transparent;
		color: #888;
		font-size: 12px;
		cursor: pointer;
		border-radius: 4px;
	}
	.toggle-btn:hover {
		color: #e0e0e0;
	}
	.toggle-btn.active {
		background: #a78bfa;
		color: #0a0a0f;
		font-weight: 600;
	}
	.btn {
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
		border: 1px solid;
	}
	.btn-danger-sm {
		border-color: #ef4444;
		color: #ef4444;
		background: transparent;
		padding: 4px 12px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	.btn-danger-sm:hover {
		background: rgba(239, 68, 68, 0.15);
	}
	.btn-accent-sm {
		border-color: #a78bfa;
		color: #a78bfa;
		background: transparent;
		padding: 4px 12px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	.btn-accent-sm:hover {
		background: rgba(167, 139, 250, 0.15);
	}

	.generate-section {
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 24px;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}
	.generate-hint {
		color: #888;
		font-size: 13px;
		margin: 0;
		max-width: 500px;
	}
	.generate-or {
		color: #555;
		font-size: 11px;
		margin: 0;
	}
	.pm-session-section {
		background: #111118;
		border: 1px solid #a78bfa33;
		border-radius: 8px;
	}
	.pm-header {
		padding: 10px 14px;
		border-bottom: 1px solid #1e1e2e;
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		background: none;
		border-top: none;
		border-left: none;
		border-right: none;
		cursor: pointer;
		text-align: left;
	}
	.pm-header:hover {
		background: #1a1a24;
	}
	.pm-toggle {
		margin-left: auto;
		color: #555;
		font-size: 11px;
		flex-shrink: 0;
	}
	.pm-toggle:hover {
		color: #a78bfa;
	}
	.pm-badge {
		color: #a78bfa;
		font-size: 12px;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}
	.pm-hint {
		color: #888;
		font-size: 12px;
	}
	.pm-badge-ready {
		color: #22c55e;
	}
	.pm-badge-live {
		color: #3b82f6;
	}
	.pm-active {
		border-color: rgba(59, 130, 246, 0.3);
	}
	.pm-dead {
		border-color: #1e1e2e;
		opacity: 0.7;
	}
	.pm-dead .pm-header {
		cursor: default;
	}
	.pm-header-actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
	}
	.pm-header-actions .pm-toggle {
		margin-left: 0;
	}
	.pm-kill-link {
		color: #ef4444;
		font-size: 11px;
		cursor: pointer;
	}
	.pm-kill-link:hover {
		text-decoration: underline;
	}
	.pm-terminal-wrap {
		height: 400px;
	}
	.pm-hidden {
		display: none;
	}
	.conflict-banner {
		background: rgba(239, 68, 68, 0.06);
		border: 1px solid rgba(239, 68, 68, 0.25);
		border-radius: 8px;
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.conflict-banner-header {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		text-align: left;
	}
	.conflict-toggle {
		margin-left: auto;
		color: #555;
		font-size: 11px;
	}
	.conflict-banner-header:hover .conflict-toggle {
		color: #e0e0e0;
	}
	.conflict-icon {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: #ef4444;
		color: #fff;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 11px;
		font-weight: 700;
		flex-shrink: 0;
	}
	.conflict-title {
		color: #ef4444;
		font-size: 14px;
		font-weight: 600;
	}
	.conflict-item {
		padding: 6px 8px;
		border-radius: 4px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.conflict-head-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.conflict-block {
		background: rgba(239, 68, 68, 0.08);
	}
	.conflict-warn {
		background: rgba(245, 158, 11, 0.08);
	}
	.conflict-severity {
		font-size: 10px;
		font-weight: 700;
		font-family: 'SF Mono', monospace;
		letter-spacing: 0.5px;
		flex-shrink: 0;
	}
	.conflict-block .conflict-severity { color: #ef4444; }
	.conflict-warn .conflict-severity { color: #f59e0b; }
	.conflict-desc {
		color: #e0e0e0;
		font-size: 12px;
	}
	.conflict-files {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding-left: 4px;
	}
	.conflict-file {
		font-size: 10px;
		color: #888;
		background: #1a1a24;
		padding: 1px 6px;
		border-radius: 3px;
	}
	.conflict-more {
		color: #555;
		font-size: 10px;
	}
	.failure-summary-section {
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		overflow: hidden;
	}
	.failure-summary-header {
		padding: 10px 14px;
		border-bottom: 1px solid #1e1e2e;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.failure-title {
		color: #ef4444;
		font-size: 13px;
		font-weight: 600;
	}
	.failure-count {
		color: #888;
		font-size: 11px;
	}
	.failure-item {
		padding: 10px 14px;
		border-bottom: 1px solid #1a1a24;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.failure-item:last-child {
		border-bottom: none;
	}
	.failure-task-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.failure-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #ef4444;
		flex-shrink: 0;
	}
	.failure-task-name {
		color: #e0e0e0;
		font-size: 13px;
		font-weight: 500;
	}
	.failure-iterations {
		color: #888;
		font-size: 11px;
		margin-left: auto;
	}
	.failure-error {
		color: #ef4444;
		font-size: 12px;
		padding-left: 14px;
	}
	.failure-output {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 6px 8px;
		font-size: 10px;
		color: #888;
		margin: 0;
		margin-left: 14px;
		max-height: 80px;
		overflow-y: auto;
		white-space: pre-wrap;
		word-break: break-all;
	}
	.btn-generate {
		background: #a78bfa;
		color: #0a0a0f;
		border: none;
		border-radius: 6px;
		padding: 10px 28px;
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.btn-generate:hover:not(:disabled) {
		background: #b99dff;
	}
	.btn-generate:disabled {
		opacity: 0.7;
		cursor: wait;
	}
	.btn-generate-secondary {
		background: transparent;
		border: 1px solid #a78bfa;
		color: #a78bfa;
	}
	.btn-generate-secondary:hover {
		background: rgba(167, 139, 250, 0.1);
	}
	.spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		border: 2px solid #0a0a0f;
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	@media (max-width: 768px) {
		.worker-grid {
			grid-template-columns: 1fr;
		}
		.header-top {
			flex-wrap: wrap;
		}
		.header-meta {
			flex-wrap: wrap;
			gap: 8px;
		}
	}
</style>
