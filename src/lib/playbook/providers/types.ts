/**
 * Provider abstraction for multi-LLM playbook execution.
 * Each provider wraps a CLI-based AI tool (Claude Code, Codex, etc.).
 */

export interface TaskAssignment {
	taskId: string;           // unique ID for this execution
	role: string;             // role ID from playbook spec
	task: string;             // the prompt/instruction (already resolved)
	inputFiles: string[];     // paths to input files
	outputPath: string;       // where the agent should write output
	contextPrompt?: string;   // shared context injected before task
	cwd: string;              // working directory for execution
	model?: string;           // model override
	timeout?: number;         // timeout in seconds (default 300)
	env?: Record<string, string>; // additional env vars
	skills?: string[];        // Claude Code skills to preload
	mcp?: string[];           // MCP server names to enable
}

export interface TaskResult {
	taskId: string;
	role: string;
	status: 'completed' | 'failed';
	outputPath?: string;      // path where output was written
	error?: string;
	startedAt: string;
	completedAt: string;
	provider: string;         // which provider executed this
}

export type TaskOutputCallback = (taskId: string, data: string) => void;

export interface PlaybookProvider {
	/** Provider identifier */
	readonly id: string;

	/** Human-readable name */
	readonly name: string;

	/** Check if this provider's CLI tool is installed and available */
	available(): Promise<boolean>;

	/** Execute a task assignment. Returns when the task is complete. */
	execute(task: TaskAssignment, onOutput?: TaskOutputCallback): Promise<TaskResult>;

	/** Cancel a running task */
	cancel(taskId: string): void;
}
