import type { EventEmitter } from 'node:events';
import type { TaskNode, ProviderType } from '../types.js';

export interface ProviderSession {
	/** Unique session ID (UUID for PTY, stringified PID for spawn) */
	id: string;
	/** EventEmitter — emits 'output' (data: string) and 'exit' (code: number) */
	emitter: EventEmitter;
	/** Whether this provider supports mid-run input injection */
	interactive: boolean;
}

export interface OrchestrationProvider {
	readonly id: ProviderType;
	readonly name: string;

	/** Check if the provider's CLI is installed and available */
	available(): Promise<boolean>;

	/**
	 * Provider-specific setup before spawning (e.g., generate CLAUDE.md).
	 * Called after worktree creation but before spawn.
	 */
	setup(
		worktreePath: string,
		task: TaskNode,
		ownershipMap: Record<string, string>,
		projectPath: string,
	): Promise<void>;

	/**
	 * Spawn the worker process. Returns a session with an EventEmitter.
	 * The emitter MUST emit:
	 *   - 'output' (data: string) — terminal/stdout output
	 *   - 'exit' (code: number) — process exited
	 */
	spawn(worktreePath: string, task: TaskNode, projectPath?: string): Promise<ProviderSession>;

	/** Whether this provider supports sending input to a running worker */
	canReceiveInput(): boolean;

	/** Send input to a running session (only if canReceiveInput() is true) */
	sendInput(sessionId: string, input: string): boolean;

	/** Kill a running session */
	kill(sessionId: string): void;

	/** Check if a session is still alive */
	isAlive(sessionId: string): boolean;
}
