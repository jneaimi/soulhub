export type RunStatus = 'planning' | 'approved' | 'running' | 'merging' | 'done' | 'failed' | 'cancelled' | 'archived';

export type WorkerStatus = 'pending' | 'running' | 'done' | 'failed' | 'killed' | 'stuck' | 'blocked' | 'interrupted' | 'validation_failed';

export type ProviderType = 'claude-code' | 'codex' | 'shell';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export type TaskComplexity = 'small' | 'medium' | 'large';

export interface TaskNode {
	id: string;
	name: string;
	description: string;
	prompt: string;
	provider: ProviderType;

	// Dependency graph
	dependsOn: string[];
	parentTask?: string;

	// Project management
	priority: TaskPriority;
	estimatedComplexity: TaskComplexity;
	acceptanceCriteria: string[];
	risks: string[];

	// Existing fields
	fileOwnership: string[];
	maxIterations: number;

	/** Reference to a completed task this builds on: "runId/taskId" */
	enhances?: string;
}

export interface OrchestrationPlan {
	goal: string;
	tasks: TaskNode[];
	createdAt: string;
}

export interface WorkerState {
	taskId: string;
	workerId: string;
	status: WorkerStatus;
	worktreePath: string;
	branch: string;
	iterationCount: number;
	startedAt?: string;
	completedAt?: string;
	error?: string;
	lastOutputSummary?: string;
	/** Provider used for this worker */
	providerType?: ProviderType;
	/** Pre-merge validation result (runs after worker commits, before merge eligibility) */
	validation?: WorkerValidation;
}

export interface WorkerValidation {
	passed: boolean;
	ranAt: string;
	durationMs: number;
	/** Steps run (install/typecheck/build...). Same shape as PostMergeStepResult, minus repair telemetry. */
	steps: PostMergeStepResult[];
}

export interface FailureSummary {
	taskId: string;
	taskName: string;
	exitCode: number;
	error: string;
	/** Last 500 chars of worker output */
	lastOutput: string;
	iterationsUsed: number;
}

export interface ConflictReport {
	taskA: string;
	taskB: string;
	files: string[];
	severity: 'block' | 'warn' | 'info';
	description: string;
}

export type PostMergeStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'fixed';

export interface RepairAttempt {
	strategyId: string;
	strategyName: string;
	tier: number;
	outcome: 'no-action' | 'applied-and-passed' | 'applied-but-still-failed' | 'error';
	commitHash?: string;
	durationMs: number;
	notes?: string;
}

export interface PostMergeStepResult {
	id: string;
	name: string;
	status: PostMergeStepStatus;
	blocking: boolean;
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	/** Last ~3KB of stdout/stderr for diagnostics */
	output?: string;
	/** Commit hash if this step produced a fix commit */
	fixCommit?: string;
	/** Telemetry: which repair strategies were tried and their outcomes */
	repairAttempts?: RepairAttempt[];
}

export interface OrchestrationRun {
	runId: string;
	projectName: string;
	projectPath: string;
	status: RunStatus;
	plan: OrchestrationPlan;
	workers: Record<string, WorkerState>;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	mergeLog: string[];
	failureSummaries: FailureSummary[];
	conflictReports: ConflictReport[];
	postMergeSteps?: PostMergeStepResult[];
}

export interface BoardEntry {
	timestamp: string;
	workerId: string;
	message: string;
}
