<script lang="ts">
	import type { OrchestrationPlan, TaskPriority, TaskComplexity } from '$lib/orchestration/types.js';

	const {
		plan,
		runId,
		onApprove,
		onEdit,
	}: {
		plan: OrchestrationPlan;
		runId: string;
		onApprove: () => void;
		onEdit: (plan: OrchestrationPlan) => void;
	} = $props();

	let expandedPrompts: Record<string, boolean> = $state({});
	let showAddForm = $state(false);
	let formError = $state('');
	let createWarnings = $state<string[]>([]);
	let warningsTimer: ReturnType<typeof setTimeout> | null = null;

	// Validation state
	let validationResult = $state<
		| {
				valid: boolean;
				errors: string[];
				warnings: string[];
				crossRunConflicts?: Array<{ runId: string; taskId: string; file?: string; message?: string }>;
		  }
		| null
	>(null);
	let validating = $state(false);

	// New task form state
	let newName = $state('');
	let newDesc = $state('');
	let newPrompt = $state('');
	let newProvider = $state<'claude-code' | 'codex' | 'shell'>('claude-code');
	let newFiles = $state('');
	let newDeps = $state<string[]>([]);
	let newMaxIter = $state(8);
	let newPriority = $state<TaskPriority>('medium');
	let newComplexity = $state<TaskComplexity>('medium');
	let newCriteria = $state('');
	let newRisks = $state('');
	let newParent = $state('');
	let newEnhances = $state('');

	let providerAvailability = $state<Record<string, boolean>>({
		'claude-code': true,
		'codex': false,
		'shell': true,
	});

	$effect(() => {
		fetch('/api/orchestration/providers')
			.then((r) => r.json())
			.then((data) => {
				if (data.providers) {
					providerAvailability = data.providers;
				}
			})
			.catch(() => {});
	});

	const priorityColors: Record<TaskPriority, string> = {
		critical: '#ef4444',
		high: '#f59e0b',
		medium: '#3b82f6',
		low: '#666',
	};

	const complexityColors: Record<TaskComplexity, string> = {
		small: '#22c55e',
		medium: '#3b82f6',
		large: '#f59e0b',
	};

	function togglePrompt(taskId: string) {
		expandedPrompts = { ...expandedPrompts, [taskId]: !expandedPrompts[taskId] };
	}

	function getEnhances(task: OrchestrationPlan['tasks'][number]): string | undefined {
		const ref = (task as unknown as { enhances?: unknown }).enhances;
		return typeof ref === 'string' && ref.trim() !== '' ? ref : undefined;
	}

	function generateTaskId(name: string): string {
		return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
			|| `task-${Date.now().toString(36)}`;
	}

	async function addTask() {
		if (!newName.trim() || !newPrompt.trim()) return;
		formError = '';

		const res = await fetch(`/api/orchestration/${runId}/tasks`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				id: generateTaskId(newName),
				name: newName.trim(),
				description: newDesc.trim(),
				prompt: newPrompt.trim(),
				provider: newProvider,
				dependsOn: [...newDeps],
				parentTask: newParent || undefined,
				priority: newPriority,
				estimatedComplexity: newComplexity,
				acceptanceCriteria: newCriteria.split('\n').map(s => s.trim()).filter(Boolean),
				risks: newRisks.split('\n').map(s => s.trim()).filter(Boolean),
				fileOwnership: newFiles.split(',').map(f => f.trim()).filter(Boolean),
				maxIterations: newMaxIter,
				enhances: newEnhances.trim() || undefined,
			}),
		});

		const result = await res.json().catch(() => ({}));

		if (!res.ok) {
			formError = result?.error || 'Failed to create task';
			return;
		}

		if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
			createWarnings = result.warnings as string[];
			if (warningsTimer) clearTimeout(warningsTimer);
			warningsTimer = setTimeout(() => {
				createWarnings = [];
				warningsTimer = null;
			}, 10000);
		}

		onEdit(plan); // signals parent to refetch

		// Reset form
		newName = '';
		newDesc = '';
		newPrompt = '';
		newProvider = 'claude-code';
		newFiles = '';
		newDeps = [];
		newMaxIter = 8;
		newPriority = 'medium';
		newComplexity = 'medium';
		newCriteria = '';
		newRisks = '';
		newParent = '';
		newEnhances = '';
		formError = '';
		showAddForm = false;
	}

	async function validatePlan() {
		validating = true;
		try {
			const res = await fetch(`/api/orchestration/${runId}/tasks/validate`, { method: 'POST' });
			const body = await res.json();
			validationResult = {
				valid: !!body.valid,
				errors: Array.isArray(body.errors) ? body.errors : [],
				warnings: Array.isArray(body.warnings) ? body.warnings : [],
				crossRunConflicts: Array.isArray(body.crossRunConflicts) ? body.crossRunConflicts : undefined,
			};
		} catch {
			validationResult = { valid: false, errors: ['Validation request failed'], warnings: [] };
		}
		validating = false;
	}

	$effect(() => {
		return () => {
			if (warningsTimer) clearTimeout(warningsTimer);
		};
	});

	async function removeTask(taskId: string) {
		await fetch(`/api/orchestration/${runId}/tasks/${taskId}`, { method: 'DELETE' });
		onEdit(plan); // signals parent to refetch
	}

	function toggleDep(taskId: string) {
		if (newDeps.includes(taskId)) {
			newDeps = newDeps.filter(d => d !== taskId);
		} else {
			newDeps = [...newDeps, taskId];
		}
	}

	// Build simple text DAG
	const dagText = $derived(buildDag(plan.tasks));

	function buildDag(tasks: OrchestrationPlan['tasks']): string {
		if (tasks.length === 0) return '';

		const lines: string[] = [];
		const visited = new Set<string>();

		// Find roots (no dependencies)
		const roots = tasks.filter((t) => t.dependsOn.length === 0);

		function walk(task: typeof tasks[0], indent: string, isLast: boolean): void {
			if (visited.has(task.id)) {
				lines.push(`${indent}${isLast ? '└── ' : '├── '}${task.name} (ref)`);
				return;
			}
			visited.add(task.id);
			lines.push(`${indent}${isLast ? '└── ' : '├── '}${task.name}`);

			// Find children (tasks that depend on this one)
			const children = tasks.filter((t) => t.dependsOn.includes(task.id));
			const nextIndent = indent + (isLast ? '    ' : '│   ');
			children.forEach((child, i) => {
				walk(child, nextIndent, i === children.length - 1);
			});
		}

		roots.forEach((root, i) => {
			walk(root, '', i === roots.length - 1);
		});

		return lines.join('\n');
	}
</script>

<div class="plan-editor">
	<div class="plan-header">
		<h2 class="plan-title">Plan Review</h2>
		<div class="plan-goal">{plan.goal}</div>
	</div>

	{#if dagText}
		<div class="dag-section">
			<div class="section-label">Task Graph</div>
			<pre class="dag-display">{dagText}</pre>
		</div>
	{/if}

	<div class="tasks-section">
		<div class="section-label">Tasks ({plan.tasks.length})</div>

		{#each plan.tasks as task, i}
			<div class="task-item">
				<div class="task-header-row">
					<span class="task-num">#{i + 1}</span>
					<span class="task-name">{task.name}</span>
					{#if task.priority}
						<span class="badge priority-badge" style="color: {priorityColors[task.priority]}; border-color: {priorityColors[task.priority]}">{task.priority}</span>
					{/if}
					{#if task.estimatedComplexity}
						<span class="badge complexity-badge" style="color: {complexityColors[task.estimatedComplexity]}; border-color: {complexityColors[task.estimatedComplexity]}">{task.estimatedComplexity}</span>
					{/if}
					<span class="task-provider">{task.provider}</span>
					{#if task.provider && task.provider !== 'claude-code'}
						<span class="task-provider-tag">{task.provider}</span>
					{/if}
					<button class="remove-task-btn" onclick={() => removeTask(task.id)} title="Remove task">&times;</button>
				</div>

				{#if task.description}
					<div class="task-desc">{task.description}</div>
				{/if}

				{#if task.parentTask}
					{@const parent = plan.tasks.find(t => t.id === task.parentTask)}
					<div class="parent-row">
						<span class="parent-label">Parent:</span>
						<span class="parent-tag">{parent?.name ?? task.parentTask}</span>
					</div>
				{/if}

				{#if getEnhances(task)}
					<div class="enhances-row">
						<span class="enhances-label">Enhances:</span>
						<span class="enhances-ref">{getEnhances(task)}</span>
					</div>
				{/if}

				{#if task.fileOwnership.length > 0}
					<div class="ownership-row">
						<span class="ownership-label">Owns:</span>
						{#each task.fileOwnership as file}
							<code class="ownership-file">{file}</code>
						{/each}
					</div>
				{/if}

				{#if task.dependsOn.length > 0}
					<div class="deps-row">
						<span class="deps-label">Depends on:</span>
						{#each task.dependsOn as dep}
							{@const depTask = plan.tasks.find((t) => t.id === dep)}
							<span class="dep-tag">{depTask?.name ?? dep}</span>
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

				{#if task.risks && task.risks.length > 0}
					<div class="risks-section">
						<span class="risks-label">Risks:</span>
						<ul class="risks-list">
							{#each task.risks as risk}
								<li>{risk}</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="task-meta">
					<span>Complexity: {task.estimatedComplexity}</span>
				</div>

				<button class="toggle-prompt" onclick={() => togglePrompt(task.id)}>
					{expandedPrompts[task.id] ? 'Hide Prompt' : 'Show Prompt'}
				</button>

				{#if expandedPrompts[task.id]}
					<pre class="prompt-block">{task.prompt}</pre>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Add Task -->
	<div class="add-task-section">
		{#if !showAddForm}
			<button class="btn-add-task" onclick={() => showAddForm = true}>+ Add Task</button>
		{:else}
			<div class="add-task-form">
				{#if formError}
					<div class="form-error">{formError}</div>
				{/if}
				<div class="form-row">
					<label class="form-label">Name *</label>
					<input class="form-input" bind:value={newName} placeholder="e.g. Auth API" />
				</div>
				<div class="form-row">
					<label class="form-label">Description</label>
					<input class="form-input" bind:value={newDesc} placeholder="What this task does" />
				</div>
				<div class="form-row-inline">
					<div class="form-row">
						<label class="form-label">Priority</label>
						<select class="form-select" bind:value={newPriority}>
							<option value="critical">Critical</option>
							<option value="high">High</option>
							<option value="medium">Medium</option>
							<option value="low">Low</option>
						</select>
					</div>
					<div class="form-row">
						<label class="form-label">Complexity</label>
						<select class="form-select" bind:value={newComplexity}>
							<option value="small">Small</option>
							<option value="medium">Medium</option>
							<option value="large">Large</option>
						</select>
					</div>
					<div class="form-row">
						<label class="form-label">Provider</label>
						<select class="form-select" bind:value={newProvider}>
							<option value="claude-code">Claude Code {providerAvailability['claude-code'] ? '' : '(unavailable)'}</option>
							<option value="codex" disabled={!providerAvailability['codex']}>
								Codex {providerAvailability['codex'] ? '' : '(not installed)'}
							</option>
							<option value="shell">Shell</option>
						</select>
					</div>
				</div>
				{#if plan.tasks.length > 0}
					<div class="form-row">
						<label class="form-label">Parent Task</label>
						<select class="form-select" bind:value={newParent}>
							<option value="">None</option>
							{#each plan.tasks as existing}
								<option value={existing.id}>{existing.name}</option>
							{/each}
						</select>
					</div>
				{/if}
				<div class="form-row">
					<label class="form-label">File Ownership</label>
					<input class="form-input" bind:value={newFiles} placeholder="src/lib/auth.ts, src/routes/api/auth/" />
					<span class="form-hint">Comma-separated file/dir paths this task owns</span>
				</div>
				<div class="form-row">
					<label class="form-label">Enhances (optional)</label>
					<input
						class="form-input"
						bind:value={newEnhances}
						placeholder="runId/taskId — reference to completed task"
					/>
					<span class="form-hint">Reference a completed task this builds on</span>
				</div>
				<div class="form-row">
					<label class="form-label">Prompt *</label>
					<textarea class="form-textarea" bind:value={newPrompt} rows="6"
						placeholder="Full prompt for the worker agent. Be specific — the worker has no other context."></textarea>
				</div>
				<div class="form-row">
					<label class="form-label">Acceptance Criteria</label>
					<textarea class="form-textarea form-textarea-sm" bind:value={newCriteria} rows="3"
						placeholder="One criterion per line"></textarea>
				</div>
				<div class="form-row">
					<label class="form-label">Risks</label>
					<textarea class="form-textarea form-textarea-sm" bind:value={newRisks} rows="3"
						placeholder="One risk per line"></textarea>
				</div>
				{#if plan.tasks.length > 0}
					<div class="form-row">
						<label class="form-label">Depends On</label>
						<div class="dep-checkboxes">
							{#each plan.tasks as existing}
								<label class="dep-checkbox-label">
									<input type="checkbox" checked={newDeps.includes(existing.id)}
										onchange={() => toggleDep(existing.id)} />
									{existing.name}
								</label>
							{/each}
						</div>
					</div>
				{/if}
				<div class="form-row">
					<label class="form-label">Max Iterations</label>
					<input class="form-input form-input-sm" type="number" min="1" max="20" bind:value={newMaxIter} />
				</div>
				<div class="form-actions">
					<button class="btn-cancel" onclick={() => { showAddForm = false; formError = ''; }}>Cancel</button>
					<button class="btn-save" onclick={addTask} disabled={!newName.trim() || !newPrompt.trim()}>Add Task</button>
				</div>
			</div>
		{/if}
	</div>

	{#if createWarnings.length > 0}
		<div class="warning-banner">
			{#each createWarnings as warning}
				<div class="warning-item">
					<svg class="warning-icon" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2">
						<path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<span>{warning}</span>
				</div>
			{/each}
		</div>
	{/if}

	{#if validationResult}
		<div
			class="validation-result"
			class:valid={validationResult.valid}
			class:invalid={!validationResult.valid}
		>
			<div class="validation-head">
				{#if validationResult.valid}
					<span class="validation-icon">✓</span> Plan is valid
				{:else}
					<span class="validation-icon">✗</span> Plan has issues
				{/if}
			</div>

			{#each validationResult.errors as err}
				<div class="validation-error">{err}</div>
			{/each}
			{#each validationResult.warnings as warn}
				<div class="validation-warning">{warn}</div>
			{/each}

			{#if validationResult.crossRunConflicts && validationResult.crossRunConflicts.length > 0}
				<div class="validation-crossrun">
					<div class="validation-crossrun-label">Cross-run conflicts</div>
					{#each validationResult.crossRunConflicts as conflict}
						<div class="validation-warning">
							{conflict.message ??
								`${conflict.runId}/${conflict.taskId}${conflict.file ? ` — ${conflict.file}` : ''}`}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<div class="plan-actions">
		<button
			class="btn btn-validate"
			onclick={validatePlan}
			disabled={validating || plan.tasks.length === 0}
		>
			{validating ? 'Validating...' : 'Validate'}
		</button>
		<button class="btn btn-approve" onclick={onApprove} disabled={plan.tasks.length === 0}>
			Approve &amp; Start
		</button>
	</div>
</div>

<style>
	.plan-editor {
		background: #111118;
		border: 1px solid #1e1e2e;
		border-radius: 8px;
		overflow: hidden;
	}
	.plan-header {
		padding: 14px;
		border-bottom: 1px solid #1e1e2e;
	}
	.plan-title {
		color: #e0e0e0;
		font-size: 16px;
		font-weight: 600;
		margin: 0 0 6px;
	}
	.plan-goal {
		color: #a78bfa;
		font-size: 14px;
	}
	.dag-section {
		padding: 10px 14px;
		border-bottom: 1px solid #1e1e2e;
	}
	.section-label {
		color: #888;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 6px;
	}
	.dag-display {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 10px 12px;
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 12px;
		color: #ccc;
		line-height: 1.5;
		margin: 0;
		overflow-x: auto;
	}
	.tasks-section {
		padding: 10px 14px;
	}
	.task-item {
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 10px 12px;
		margin-bottom: 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.task-header-row {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.task-num {
		color: #555;
		font-size: 12px;
		font-family: 'SF Mono', monospace;
	}
	.task-name {
		color: #e0e0e0;
		font-size: 14px;
		font-weight: 600;
	}
	.badge {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		border: 1px solid;
		text-transform: uppercase;
		letter-spacing: 0.3px;
		font-weight: 600;
	}
	.task-provider {
		color: #888;
		font-size: 11px;
		background: #1a1a2e;
		padding: 1px 6px;
		border-radius: 3px;
		margin-left: auto;
	}
	.task-provider-tag {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 3px;
		background: rgba(16, 185, 129, 0.1);
		color: #10b981;
		font-family: 'SF Mono', monospace;
	}
	.task-desc {
		color: #888;
		font-size: 12px;
		padding-left: 24px;
	}
	.parent-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 24px;
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
	.ownership-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 24px;
		flex-wrap: wrap;
	}
	.ownership-label {
		color: #888;
		font-size: 11px;
	}
	.ownership-file {
		color: #22c55e;
		font-size: 11px;
		background: rgba(34, 197, 94, 0.1);
		padding: 1px 6px;
		border-radius: 3px;
	}
	.deps-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 24px;
		flex-wrap: wrap;
	}
	.deps-label {
		color: #888;
		font-size: 11px;
	}
	.dep-tag {
		color: #f59e0b;
		font-size: 11px;
		background: rgba(245, 158, 11, 0.1);
		padding: 1px 6px;
		border-radius: 3px;
	}
	.criteria-section {
		padding-left: 24px;
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
		font-size: 12px;
		line-height: 1.4;
	}
	.risks-section {
		padding-left: 24px;
	}
	.risks-label {
		color: #f59e0b;
		font-size: 11px;
	}
	.risks-list {
		margin: 4px 0 0 16px;
		padding: 0;
		list-style: disc;
	}
	.risks-list li {
		color: #f59e0b;
		font-size: 12px;
		line-height: 1.4;
	}
	.task-meta {
		color: #555;
		font-size: 11px;
		padding-left: 24px;
	}
	.toggle-prompt {
		align-self: flex-start;
		margin-left: 24px;
		background: none;
		border: none;
		color: #888;
		font-size: 11px;
		cursor: pointer;
		padding: 2px 0;
		text-decoration: underline;
	}
	.toggle-prompt:hover {
		color: #a78bfa;
	}
	.prompt-block {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		padding: 8px 10px;
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 11px;
		color: #888;
		line-height: 1.4;
		max-height: 200px;
		overflow-y: auto;
		white-space: pre-wrap;
		margin: 0 0 0 24px;
	}
	.plan-actions {
		padding: 14px;
		border-top: 1px solid #1e1e2e;
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.btn-approve {
		background: #a78bfa;
		color: #0a0a0f;
		border: none;
		border-radius: 6px;
		padding: 8px 20px;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
	}
	.btn-approve:hover:not(:disabled) {
		background: #b99dff;
	}
	.btn-approve:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.btn-validate {
		background: transparent;
		border: 1px solid #555;
		color: #888;
		border-radius: 6px;
		padding: 8px 16px;
		font-size: 13px;
		cursor: pointer;
	}
	.btn-validate:hover:not(:disabled) {
		border-color: #888;
		color: #e0e0e0;
	}
	.btn-validate:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.warning-banner {
		margin: 0 14px 10px;
		background: rgba(245, 158, 11, 0.08);
		border: 1px solid rgba(245, 158, 11, 0.25);
		border-radius: 6px;
		padding: 8px 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.warning-item {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #f59e0b;
		font-size: 12px;
	}
	.warning-icon {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
	}
	.enhances-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding-left: 24px;
	}
	.enhances-label {
		color: #888;
		font-size: 11px;
	}
	.enhances-ref {
		color: #a78bfa;
		font-size: 11px;
		font-family: 'SF Mono', monospace;
		background: rgba(167, 139, 250, 0.1);
		padding: 1px 6px;
		border-radius: 3px;
	}
	.validation-result {
		margin: 0 14px 10px;
		padding: 10px 14px;
		border-radius: 6px;
		font-size: 12px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.validation-result.valid {
		background: rgba(34, 197, 94, 0.08);
		border: 1px solid rgba(34, 197, 94, 0.25);
		color: #22c55e;
	}
	.validation-result.invalid {
		background: rgba(239, 68, 68, 0.08);
		border: 1px solid rgba(239, 68, 68, 0.25);
		color: #ef4444;
	}
	.validation-head {
		font-weight: 600;
	}
	.validation-icon {
		font-weight: 700;
		margin-right: 4px;
	}
	.validation-error {
		color: #ef4444;
		padding-left: 16px;
		margin-top: 4px;
	}
	.validation-warning {
		color: #f59e0b;
		padding-left: 16px;
		margin-top: 4px;
	}
	.validation-crossrun {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid rgba(255, 255, 255, 0.06);
	}
	.validation-crossrun-label {
		color: #888;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		padding-left: 16px;
		margin-bottom: 2px;
	}
	.remove-task-btn {
		background: none;
		border: none;
		color: #555;
		font-size: 16px;
		cursor: pointer;
		padding: 0 4px;
		margin-left: 4px;
		line-height: 1;
	}
	.remove-task-btn:hover {
		color: #ef4444;
	}
	.add-task-section {
		padding: 10px 14px;
		border-top: 1px solid #1e1e2e;
	}
	.btn-add-task {
		background: transparent;
		border: 1px dashed #333;
		color: #888;
		width: 100%;
		padding: 10px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
	}
	.btn-add-task:hover {
		border-color: #a78bfa;
		color: #a78bfa;
	}
	.add-task-form {
		border: 1px solid #1e1e2e;
		border-radius: 6px;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.form-error {
		color: #ef4444;
		font-size: 12px;
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.3);
		border-radius: 4px;
		padding: 6px 10px;
	}
	.form-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.form-row-inline {
		display: flex;
		gap: 10px;
	}
	.form-row-inline .form-row {
		flex: 1;
	}
	.form-label {
		color: #888;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.4px;
	}
	.form-input, .form-select, .form-textarea {
		background: #0a0a0f;
		border: 1px solid #1e1e2e;
		border-radius: 4px;
		color: #e0e0e0;
		padding: 7px 10px;
		font-size: 13px;
		font-family: inherit;
	}
	.form-input:focus, .form-select:focus, .form-textarea:focus {
		outline: none;
		border-color: #a78bfa;
	}
	.form-input-sm {
		width: 80px;
	}
	.form-textarea {
		resize: vertical;
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 12px;
		line-height: 1.5;
	}
	.form-textarea-sm {
		font-family: inherit;
		font-size: 13px;
	}
	.form-hint {
		color: #555;
		font-size: 10px;
	}
	.dep-checkboxes {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.dep-checkbox-label {
		display: flex;
		align-items: center;
		gap: 4px;
		color: #888;
		font-size: 12px;
		cursor: pointer;
	}
	.dep-checkbox-label input {
		accent-color: #a78bfa;
	}
	.form-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}
	.btn-cancel {
		background: transparent;
		border: 1px solid #333;
		color: #888;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	.btn-cancel:hover {
		border-color: #555;
		color: #e0e0e0;
	}
	.btn-save {
		background: #a78bfa;
		color: #0a0a0f;
		border: none;
		padding: 6px 14px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
	}
	.btn-save:hover:not(:disabled) {
		background: #b99dff;
	}
	.btn-save:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@media (max-width: 768px) {
		.form-row-inline {
			flex-direction: column;
			gap: 10px;
		}
	}
</style>
