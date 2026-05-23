/**
 * Types for Claude Code's JSONL session format.
 * Treat as external schema — tolerate unknown event types and extra keys.
 */

export interface ClaudeUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation?: {
		ephemeral_5m_input_tokens?: number;
		ephemeral_1h_input_tokens?: number;
	};
	service_tier?: string;
}

export interface ClaudeContentBlock {
	type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string;
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
}

export interface ClaudeMessage {
	role: 'user' | 'assistant' | string;
	model?: string;
	usage?: ClaudeUsage;
	content?: string | ClaudeContentBlock[];
}

/** Sub-agent rollup attached to user tool_result events for Agent invocations. */
export interface ToolUseResult {
	status?: 'completed' | 'error' | string;
	prompt?: string;
	agentId?: string;
	agentType?: string;
	content?: ClaudeContentBlock[] | string;
	totalDurationMs?: number;
	totalTokens?: number;
	totalToolUseCount?: number;
	usage?: ClaudeUsage;
	toolStats?: Record<string, number>;
}

export interface ClaudeEvent {
	type: string;
	uuid?: string;
	parentUuid?: string | null;
	isSidechain?: boolean;
	timestamp?: string;
	cwd?: string;
	sessionId?: string;
	gitBranch?: string;
	version?: string;
	userType?: string;
	entrypoint?: string;
	requestId?: string;
	slug?: string;
	promptId?: string;
	message?: ClaudeMessage;
	attachment?: {
		type: string;
		hookName?: string;
		toolUseID?: string;
		hookEvent?: string;
		content?: string;
	};
	toolUseResult?: ToolUseResult;
	sourceToolAssistantUUID?: string;
	sourceToolUseID?: string;
	permissionMode?: string;
	subtype?: string;
	// file-history-snapshot
	messageId?: string;
	snapshot?: {
		messageId?: string;
		timestamp?: string;
		trackedFileBackups?: Record<string, unknown>;
	};
	isSnapshotUpdate?: boolean;
	// last-prompt
	lastPrompt?: string;
	// queue-operation
	operation?: string;
	// allow forward-compat fields
	[k: string]: unknown;
}

export interface ClaudeSession {
	jsonlPath: string;
	sessionId: string;
	cwd: string;
	gitBranch?: string;
	model?: string;
	firstTimestamp?: string;
	lastTimestamp?: string;
	events: ClaudeEvent[];
}

/** Lightweight ref returned by the linker before parsing the full session. */
export interface ClaudeSessionRef {
	jsonlPath: string;
	sessionId: string;
	cwd: string;
	firstTimestamp?: string;
	sizeBytes: number;
}

export interface CostBreakdown {
	totalUsd: number | null;
	byModel: Record<string, number | null>;
	tokens: {
		input: number;
		output: number;
		cacheCreate: number;
		cacheRead: number;
	};
}

export interface SubagentRollup {
	agentId: string;
	agentType: string;
	status: string;
	descriptionPrompt?: string; // first 200 chars
	totalDurationMs?: number;
	totalTokens?: number;
	totalToolUseCount?: number;
	usage?: ClaudeUsage;
	toolStats?: Record<string, number>;
	cost?: number | null;
	subagentJsonlPath?: string; // deterministic path; may not exist if Anthropic schema differs
}

export interface FileSnapshot {
	messageId: string;
	timestamp?: string;
	paths: string[]; // file paths in the snapshot
}

export interface SessionSummary {
	sessionId: string;
	cwd: string;
	gitBranch?: string;
	model?: string;
	firstTimestamp?: string;
	lastTimestamp?: string;
	durationMs?: number;
	eventCount: number;
	cost: CostBreakdown;
	toolCallCount: number;
	toolBreakdown: Record<string, number>;
	filesTouched: string[];
	fileSnapshots: FileSnapshot[];
	subagents: SubagentRollup[];
	errorCount: number;
	firstPrompt?: string;
	lastPrompt?: string;
}
