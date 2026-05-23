/** Playbook YAML spec types — the foundation for multi-agent orchestration */

// ─── Spec Types (what users write in playbook.yaml) ───

export interface PlaybookInput {
	id: string;
	type: 'text' | 'string' | 'number' | 'file' | 'path' | 'select';
	description?: string;
	required?: boolean;
	default?: string | number;
	options?: string[]; // for type: select
}

export interface PlaybookRole {
	id: string;
	provider: string; // 'claude' | 'codex' | etc. — extensible
	model?: string;
	agent: string; // path to role definition markdown (relative to playbook dir)
	reasoning?: 'low' | 'medium' | 'high' | 'xhigh'; // for codex provider
	sandbox?: string; // for codex provider
	skills?: string[];     // Claude Code skills to preload
	mcp?: string[];        // MCP server names to enable
}

export interface PlaybookAssignment {
	role: string; // role ID reference
	task: string; // prompt/instruction for the agent
	input?: string | string[]; // variable refs: $inputs.X, $phases.X.Y
	output: string; // output file path (relative to run dir)
}

export type PhaseType = 'sequential' | 'parallel' | 'handoff' | 'human' | 'gate' | 'consensus';

export interface PlaybookPhase {
	id: string;
	type: PhaseType;
	depends_on?: string[];
	assignments: PlaybookAssignment[];
	// Conditional — skip phase based on input value
	skip_if?: string; // e.g. "$inputs.enable_critic == false"
	// Handoff-specific
	loop_until?: string;
	max_iterations?: number;
	between?: string[]; // role IDs for handoff
	// Human-specific
	prompt?: string; // question/instruction for human
	timeout?: string; // e.g. '72h', '30m'
	on_timeout?: 'skip' | 'cancel' | 'use_default' | 'notify_again';
}

export interface PlaybookOutputItem {
	type: 'project' | 'knowledge' | 'artifact' | 'media' | 'patch' | 'action' | 'playbook';
	target?: string;
	file?: string;
	source?: string;
	vault_zone?: string;
	description?: string;
}

export interface PlaybookOutputSafety {
	branch?: string; // git branch pattern, e.g. 'playbook/$name-$runId'
	commit?: boolean;
	pr?: 'auto' | 'optional' | 'none';
	rollback?: 'git' | 'none';
}

export interface PlaybookOutput {
	type: 'project' | 'knowledge' | 'artifact' | 'media' | 'patch' | 'action' | 'playbook' | 'composite';
	target?: string;
	file?: string;
	source?: string;
	vault_zone?: string;
	items?: PlaybookOutputItem[]; // for composite type
	vault_capture?: boolean; // default true
	on_complete?: {
		notify?: boolean;
		next?: string; // suggest next playbook
	};
	safety?: PlaybookOutputSafety;
}

export interface PlaybookOnFailure {
	land_partial?: boolean; // save completed phase outputs (default true)
	resume_from?: string; // allow restart from this phase
	strategy?: 'halt' | 'skip';
}

export interface PlaybookPersistence {
	mode: 'ephemeral' | 'durable';
	stale_warning?: string; // e.g. '48h'
}

// ─── Hook Types ───

export interface PlaybookHook {
	id: string;
	run: string;             // shell command (supports $inputs.X variable substitution)
	output?: string;         // JSON output file — engine reads structured data
	timeout?: number;        // seconds, default 30
}

export interface PlaybookHooks {
	pre_run?: PlaybookHook[];
	pre_phase?: PlaybookHook[];
	post_phase?: PlaybookHook[];
	post_run?: PlaybookHook[];
}

// ─── Prerequisites ───

export interface PlaybookPrerequisite {
	name: string;            // e.g. 'gitnexus', 'eslint', 'python3'
	check: string;           // shell command to verify (exit 0 = installed)
	install?: string;        // install instruction for user
	required?: boolean;      // default true — false means optional enhancement
}

export interface PlaybookSpec {
	name: string;
	type: 'playbook';
	description?: string;
	inputs?: PlaybookInput[];
	roles: PlaybookRole[];
	phases: PlaybookPhase[];
	output: PlaybookOutput;
	on_failure?: PlaybookOnFailure;
	persistence?: PlaybookPersistence;
	hooks?: PlaybookHooks;
	prerequisites?: PlaybookPrerequisite[];
	timeout_strategy?: 'auto' | 'static';  // 'auto' = use hook output, default 'static'
}

// ─── Runtime Types (engine state during execution) ───

export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type AssignmentStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AssignmentResult {
	role: string;
	provider: string;
	status: AssignmentStatus;
	output?: string; // path to output file
	startedAt?: string;
	completedAt?: string;
	error?: string;
	iteration?: number; // for handoff loops
}

export interface PhaseResult {
	id: string;
	type: PhaseType;
	status: PhaseStatus;
	assignments: AssignmentResult[];
	startedAt?: string;
	completedAt?: string;
	iterations?: number; // for handoff phases
	error?: string;
}

export interface PlaybookRun {
	runId: string;
	playbookName: string;
	playbookDir: string;
	status: RunStatus;
	phases: PhaseResult[];
	startedAt: string;
	completedAt?: string;
	resolvedInputs: Record<string, string | number>;
	contextDir: string; // path to shared context workspace
	outputDir: string; // path to run outputs
}
