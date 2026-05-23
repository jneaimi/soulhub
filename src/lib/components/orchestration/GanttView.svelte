<script lang="ts">
	import type { TaskNode, WorkerState } from '$lib/orchestration/types.js';

	const {
		tasks,
		workers,
	}: {
		tasks: TaskNode[];
		workers: Record<string, WorkerState>;
	} = $props();

	const statusColors: Record<string, string> = {
		pending: '#333',
		running: '#3b82f6',
		done: '#22c55e',
		failed: '#ef4444',
		killed: '#ef4444',
		stuck: '#f59e0b',
		blocked: '#444',
		interrupted: '#f97316',
	};

	const statusLabels: Record<string, string> = {
		pending: 'Pending',
		running: 'Running',
		done: 'Done',
		failed: 'Failed',
		killed: 'Killed',
		stuck: 'Stuck',
		blocked: 'Blocked',
		interrupted: 'Interrupted',
	};

	function getStatus(task: TaskNode): string {
		const w = workers[task.id];
		if (!w) {
			const allDepsDone = task.dependsOn.every((d) => workers[d]?.status === 'done');
			return task.dependsOn.length > 0 && !allDepsDone ? 'blocked' : 'pending';
		}
		return w.status;
	}

	function getElapsed(task: TaskNode): string {
		const w = workers[task.id];
		if (!w?.startedAt) return '';
		const start = new Date(w.startedAt).getTime();
		const end = w.completedAt ? new Date(w.completedAt).getTime() : Date.now();
		const secs = Math.floor((end - start) / 1000);
		if (secs < 60) return `${secs}s`;
		return `${Math.floor(secs / 60)}m ${secs % 60}s`;
	}

	function getProgress(task: TaskNode): number {
		const status = getStatus(task);
		if (status === 'done') return 100;
		if (status === 'failed' || status === 'killed' || status === 'stuck') return 100;
		if (status === 'pending' || status === 'blocked' || status === 'interrupted') return 0;
		// Running — show a pulsing bar at 40% (indeterminate since we don't know total time)
		return 40;
	}

	// Topological sort for display order
	const orderedTasks = $derived.by(() => {
		const visited = new Set<string>();
		const result: TaskNode[] = [];
		const byId = new Map(tasks.map((t) => [t.id, t]));

		function visit(task: TaskNode) {
			if (visited.has(task.id)) return;
			visited.add(task.id);
			for (const depId of task.dependsOn) {
				const dep = byId.get(depId);
				if (dep) visit(dep);
			}
			result.push(task);
		}

		for (const t of tasks) visit(t);
		return result;
	});

	// Task number map for dependency badges
	const taskNumbers = $derived.by(() => {
		const map = new Map<string, number>();
		orderedTasks.forEach((t, i) => map.set(t.id, i + 1));
		return map;
	});

	// Gantt now uses time-based progress, not iteration columns
	// Keep tick count for reactivity
	let now = $state(Date.now());
	$effect(() => {
		const hasRunning = tasks.some(t => getStatus(t) === 'running');
		if (!hasRunning) return;
		const timer = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(timer);
	});
</script>

<div class="gantt-wrap">
	{#if orderedTasks.length === 0}
		<div class="empty-state">No tasks to display</div>
	{:else}
		<!-- Header row -->
		<div class="gantt-grid">
			<div class="gantt-header-label">Task</div>
			<div class="gantt-header-timeline">Progress</div>
			<div class="gantt-header-status">Status</div>

			<!-- Task rows -->
			{#each orderedTasks as task, idx (task.id)}
				{@const status = getStatus(task)}
				{@const progress = getProgress(task)}
				{@const elapsed = getElapsed(task)}
				{@const taskNum = taskNumbers.get(task.id) ?? idx + 1}
				{@const isBlocked = status === 'blocked'}
				{@const isRunning = status === 'running'}
				{@const isDone = status === 'done'}

				<!-- Task label -->
				<div class="task-label" class:task-blocked={isBlocked}>
					<span class="task-num">#{taskNum}</span>
					<span class="task-name" title={task.name}>{task.name}</span>
					{#if task.provider && task.provider !== 'claude-code'}
						<span class="provider-tag" title={task.provider}>
							{task.provider === 'codex' ? 'CX' : task.provider === 'shell' ? 'SH' : String(task.provider).slice(0, 2).toUpperCase()}
						</span>
					{/if}
					{#if task.dependsOn.length > 0}
						<span class="dep-badges">
							{#each task.dependsOn as depId}
								{@const depNum = taskNumbers.get(depId)}
								{@const depWorker = workers[depId]}
								<span
									class="dep-badge"
									class:dep-done={depWorker?.status === 'done'}
									class:dep-failed={depWorker?.status === 'failed' || depWorker?.status === 'killed'}
									title="Depends on #{depNum}"
								>
									#{depNum}
								</span>
							{/each}
						</span>
					{/if}
				</div>

				<!-- Timeline bar -->
				<div class="task-timeline">
					<div class="bar-track" class:bar-blocked={isBlocked}>
						{#if !isBlocked}
							<div
								class="bar-fill"
								style="width: {isDone ? 100 : progress}%; background: {statusColors[status]}"
								class:bar-pulse={isRunning}
							>
								{#if isDone || isRunning || status === 'failed' || status === 'stuck'}
									<span class="bar-label-inner">
										{isDone ? `Done ${elapsed}` : status === 'failed' || status === 'stuck' ? `Failed ${elapsed}` : elapsed}
									</span>
								{/if}
							</div>
						{:else}
							<span class="blocked-text">
								Waiting on {task.dependsOn.map(d => `#${taskNumbers.get(d)}`).join(', ')}
							</span>
						{/if}
					</div>
				</div>

				<!-- Status cell -->
				<div class="task-status">
					<span class="status-dot" style="background: {statusColors[status]}"></span>
					<span class="status-text" style="color: {statusColors[status]}">
						{statusLabels[status] ?? status}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.gantt-wrap {
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		overflow-x: auto;
		overflow-y: hidden;
	}
	.empty-state {
		padding: 40px;
		text-align: center;
		color: #555;
		font-size: 13px;
	}
	.gantt-grid {
		display: grid;
		grid-template-columns: 220px 1fr 90px;
		min-width: 500px;
	}

	/* Header */
	.gantt-header-label {
		padding: 8px 12px;
		border-bottom: 1px solid #1e1e2e;
		border-right: 1px solid #1e1e2e;
		background: #0f0f15;
	}
	.gantt-header-timeline {
		display: flex;
		align-items: center;
		padding: 8px 8px;
		border-bottom: 1px solid #1e1e2e;
		background: #0f0f15;
		gap: 0;
	}
	.iter-header {
		flex: 1;
		text-align: center;
		color: #555;
		font-size: 10px;
		font-family: 'SF Mono', 'Fira Code', monospace;
	}
	.gantt-header-status {
		padding: 8px 12px;
		border-bottom: 1px solid #1e1e2e;
		border-left: 1px solid #1e1e2e;
		background: #0f0f15;
		color: #555;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		display: flex;
		align-items: center;
	}

	/* Task label */
	.task-label {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 12px;
		height: 44px;
		border-bottom: 1px solid #1a1a24;
		border-right: 1px solid #1e1e2e;
		background: #0f0f15;
		overflow: hidden;
	}
	.task-blocked {
		opacity: 0.6;
	}
	.task-num {
		color: #555;
		font-size: 10px;
		font-family: 'SF Mono', monospace;
		flex-shrink: 0;
	}
	.task-name {
		color: #e0e0e0;
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.dep-badges {
		display: flex;
		gap: 3px;
		flex-shrink: 0;
	}
	.provider-tag {
		font-size: 9px;
		font-family: 'SF Mono', monospace;
		padding: 0 3px;
		border-radius: 2px;
		background: #1e1e2e;
		color: #888;
		flex-shrink: 0;
	}
	.dep-badge {
		font-size: 9px;
		font-family: 'SF Mono', monospace;
		padding: 1px 4px;
		border-radius: 3px;
		background: #1e1e2e;
		color: #888;
		border: 1px solid #333;
	}
	.dep-done {
		border-color: #22c55e44;
		color: #22c55e;
		background: #22c55e11;
	}
	.dep-failed {
		border-color: #ef444444;
		color: #ef4444;
		background: #ef444411;
	}

	/* Timeline bar */
	.task-timeline {
		display: flex;
		align-items: center;
		padding: 0 8px;
		height: 44px;
		border-bottom: 1px solid #1a1a24;
	}
	.bar-track {
		width: 100%;
		height: 28px;
		background: #1a1a24;
		border-radius: 4px;
		position: relative;
		overflow: hidden;
		display: flex;
		align-items: center;
	}
	.bar-blocked {
		background: repeating-linear-gradient(
			-45deg,
			#1a1a24,
			#1a1a24 4px,
			#222230 4px,
			#222230 8px
		);
	}
	.bar-fill {
		height: 100%;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		padding-right: 8px;
		transition: width 0.5s ease;
		min-width: 0;
	}
	.bar-pulse {
		animation: pulse-glow 2s ease-in-out infinite;
	}
	@keyframes pulse-glow {
		0%, 100% { opacity: 0.85; }
		50% { opacity: 1; }
	}
	.bar-label-inner {
		color: #fff;
		font-size: 10px;
		font-family: 'SF Mono', monospace;
		font-weight: 600;
		white-space: nowrap;
		text-shadow: 0 1px 2px rgba(0,0,0,0.5);
	}
	.bar-label-outer {
		color: #888;
		font-size: 10px;
		font-family: 'SF Mono', monospace;
		margin-left: 6px;
		position: absolute;
		left: calc(var(--progress, 0) + 4px);
	}
	.blocked-text {
		color: #9ca3af;
		font-size: 10px;
		font-family: 'SF Mono', monospace;
		padding: 0 8px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Status cell */
	.task-status {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 12px;
		height: 44px;
		border-bottom: 1px solid #1a1a24;
		border-left: 1px solid #1e1e2e;
	}
	.status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.status-text {
		font-size: 11px;
		font-weight: 500;
	}
</style>
