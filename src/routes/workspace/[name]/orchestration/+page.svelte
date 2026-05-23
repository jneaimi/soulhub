<script lang="ts">
	import type { OrchestrationRun, RunStatus } from '$lib/orchestration/types.js';

	const { data } = $props();

	let runs: OrchestrationRun[] = $state(data.runs);
	let goal = $state('');
	let creating = $state(false);
	let error = $state('');

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

	async function createRun() {
		if (!goal.trim()) {
			error = 'Goal is required';
			return;
		}

		creating = true;
		error = '';

		try {
			const res = await fetch('/api/orchestration', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					projectName: data.projectName,
					projectPath: data.projectPath,
					goal: goal.trim(),
				}),
			});

			const result = await res.json();
			if (!res.ok) {
				error = result.error || 'Failed to create run';
				return;
			}

			// Navigate to the new run
			window.location.href = `/workspace/${data.projectName}/orchestration/${result.runId}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Network error';
		} finally {
			creating = false;
		}
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
			' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
	}

	function workerCount(run: OrchestrationRun): string {
		const total = run.plan.tasks.length;
		const done = Object.values(run.workers).filter((w) => w.status === 'done').length;
		return `${done}/${total}`;
	}
</script>

<div class="orch-page">
<div class="orch-list">
	<div class="page-header">
		<a href="/workspace/{data.projectName}" class="back-link">&larr; Back</a>
		<h1 class="page-title">Orchestration</h1>
	</div>

	<div class="create-section">
		<div class="create-row">
			<input
				type="text"
				class="goal-input"
				placeholder="What should the agents build?"
				bind:value={goal}
				onkeydown={(e) => e.key === 'Enter' && createRun()}
			/>
			<button class="btn btn-primary" onclick={createRun} disabled={creating}>
				{creating ? 'Creating...' : 'New Orchestration'}
			</button>
		</div>
		{#if error}
			<div class="error-msg">{error}</div>
		{/if}
	</div>

	{#if runs.length === 0}
		<div class="empty-state">
			No orchestration runs yet. Enter a goal above to start one.
		</div>
	{:else}
		<div class="runs-list">
			{#each runs as run}
				<a href="/workspace/{data.projectName}/orchestration/{run.runId}" class="run-card">
					<div class="run-card-top">
						<span class="run-status-dot" style="background: {statusColors[run.status]}"></span>
						<span class="run-goal">{run.plan.goal}</span>
						<span class="run-status">{run.status}</span>
					</div>
					<div class="run-card-bottom">
						<span class="run-id">{run.runId.slice(0, 20)}...</span>
						<span class="run-workers">{workerCount(run)} workers done</span>
						<span class="run-date">{formatDate(run.createdAt)}</span>
					</div>
				</a>
			{/each}
		</div>
	{/if}
</div>
</div>

<style>
	.orch-page {
		height: 100vh;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}
	.orch-list {
		max-width: 800px;
		margin: 0 auto;
		padding: 24px 20px;
	}
	.page-header {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 24px;
	}
	.back-link {
		color: #888;
		text-decoration: none;
		font-size: 13px;
	}
	.back-link:hover {
		color: #a78bfa;
	}
	.page-title {
		color: #e0e0e0;
		font-size: 20px;
		font-weight: 600;
		margin: 0;
	}
	.create-section {
		margin-bottom: 24px;
	}
	.create-row {
		display: flex;
		gap: 8px;
	}
	.goal-input {
		flex: 1;
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 10px 14px;
		color: #e0e0e0;
		font-size: 14px;
		outline: none;
	}
	.goal-input:focus {
		border-color: #a78bfa;
	}
	.goal-input::placeholder {
		color: #555;
	}
	.btn-primary {
		background: #a78bfa;
		color: #0a0a0f;
		border: none;
		border-radius: 6px;
		padding: 10px 18px;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}
	.btn-primary:hover {
		background: #b99dff;
	}
	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.error-msg {
		color: #ef4444;
		font-size: 13px;
		margin-top: 6px;
	}
	.empty-state {
		color: #555;
		text-align: center;
		padding: 48px 20px;
		font-size: 14px;
	}
	.runs-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.run-card {
		display: block;
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		padding: 12px 16px;
		text-decoration: none;
		transition: border-color 0.15s;
	}
	.run-card:hover {
		border-color: #a78bfa;
	}
	.run-card-top {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}
	.run-status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.run-goal {
		color: #e0e0e0;
		font-size: 14px;
		font-weight: 500;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.run-status {
		color: #888;
		font-size: 12px;
	}
	.run-card-bottom {
		display: flex;
		align-items: center;
		gap: 16px;
		padding-left: 16px;
	}
	.run-id {
		color: #555;
		font-size: 11px;
		font-family: 'SF Mono', monospace;
	}
	.run-workers {
		color: #888;
		font-size: 12px;
	}
	.run-date {
		color: #555;
		font-size: 12px;
		margin-left: auto;
	}

	@media (max-width: 768px) {
		.create-row {
			flex-direction: column;
		}
		.run-card-bottom {
			flex-wrap: wrap;
			gap: 8px;
		}
	}
</style>
