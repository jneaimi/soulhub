import type { PlaybookProvider, TaskAssignment, TaskResult, TaskOutputCallback } from './types.js';
import { spawnSession, writeInput, killSession } from '$lib/pty/manager.js';
import type { PtySession } from '$lib/pty/manager.js';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from '$lib/config.js';

export class ClaudeProvider implements PlaybookProvider {
	readonly id = 'claude';
	readonly name = 'Claude Code';

	/** Track active sessions for cancellation */
	private activeSessions = new Map<string, PtySession>();

	async available(): Promise<boolean> {
		try {
			const binaryPath = config.resolved.claudeBinary;
			return existsSync(binaryPath);
		} catch {
			return false;
		}
	}

	async execute(task: TaskAssignment, onOutput?: TaskOutputCallback): Promise<TaskResult> {
		const startedAt = new Date().toISOString();

		// Build the prompt: OUTPUT PATH FIRST (most important), then task, then context
		const promptParts: string[] = [];

		// OUTPUT PATH FIRST — this is the #1 priority
		promptParts.push(`You are an automated agent. Your output MUST be written to:\n${task.outputPath}\n\nAfter completing your analysis, use the Write tool to save your findings to the exact path above. The system detects completion by monitoring this file.`);

		promptParts.push(`## Task\n\n${task.task}`);

		if (task.inputFiles.length > 0) {
			promptParts.push(`## Input Files\n\n${task.inputFiles.map(f => `- ${f}`).join('\n')}`);
		}

		// Only inject context if it's small (< 100 lines)
		// Large context causes paste issues in Claude Code — agent should Read files instead
		if (task.contextPrompt) {
			const lineCount = task.contextPrompt.split('\n').length;
			if (lineCount < 100) {
				promptParts.push(task.contextPrompt);
			} else {
				promptParts.push(`## Prior Phase Context\n\nContext from prior phases is available. Read the input files listed above for full details.`);
			}
		}

		if (task.skills && task.skills.length > 0) {
			promptParts.push(`## Skills\n\n${task.skills.join(', ')}`);
		}

		if (task.mcp && task.mcp.length > 0) {
			promptParts.push(`## MCP Tools\n\n${task.mcp.join(', ')}`);
		}

		// Remind at the end too
		promptParts.push(`REMINDER: Write your complete output to ${task.outputPath} using the Write tool.`);

		const fullPrompt = promptParts.join('\n\n');

		// Ensure output directory exists before spawning
		const { mkdir } = await import('node:fs/promises');
		const { dirname } = await import('node:path');
		await mkdir(dirname(task.outputPath), { recursive: true });

		console.log(`[playbook/claude] Spawning task ${task.taskId} → output: ${task.outputPath}`);

		// Spawn Claude Code session
		// Use project root (cwd) as working directory — playbook dirs aren't git repos
		// and would trigger workspace trust prompts
		const session = spawnSession({
			prompt: fullPrompt,
			cwd: process.cwd(),
			model: task.model,
			env: task.env,
			// Isolate headless agents from user/project MCP servers (Stitch etc. need auth and block)
			// --strict-mcp-config = ONLY use --mcp-config, ignore ~/.claude.json and .mcp.json
			// --mcp-config accepts inline JSON strings — must have {"mcpServers":{}} schema
			extraArgs: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
		});

		this.activeSessions.set(task.taskId, session);

		// Forward output to callback
		if (onOutput) {
			session.emitter.on('output', (data: string) => {
				onOutput(task.taskId, data);
			});
		}

		// Wait for completion: output file created OR process exit OR timeout
		const timeoutMs = (task.timeout || 300) * 1000;

		try {
			const result = await new Promise<TaskResult>((resolve, reject) => {
				let completed = false;
				let watchdog: ReturnType<typeof setInterval> | null = null;

				const cleanup = () => {
					completed = true;
					if (watchdog) clearInterval(watchdog);
					this.activeSessions.delete(task.taskId);
				};

				// Timeout handler
				const timeoutHandle = setTimeout(() => {
					if (completed) return;
					cleanup();
					killSession(session.id);
					resolve({
						taskId: task.taskId,
						role: task.role,
						status: 'failed',
						error: `Timeout after ${task.timeout || 300}s`,
						startedAt,
						completedAt: new Date().toISOString(),
						provider: this.id,
					});
				}, timeoutMs);

				// Watch for output file creation (poll every 5s)
				watchdog = setInterval(async () => {
					if (completed) return;
					try {
						const s = await stat(task.outputPath);
						if (s.isFile() && s.size > 0) {
							// Output file found — wait 3s for agent to finish writing, then exit
							setTimeout(() => {
								if (completed) return;
								writeInput(session.id, '/exit\n');
								// Give it 5s to exit gracefully
								setTimeout(() => {
									if (completed) return;
									cleanup();
									clearTimeout(timeoutHandle);
									resolve({
										taskId: task.taskId,
										role: task.role,
										status: 'completed',
										outputPath: task.outputPath,
										startedAt,
										completedAt: new Date().toISOString(),
										provider: this.id,
									});
								}, 5000);
							}, 3000);
						}
					} catch {
						// File doesn't exist yet — keep polling
					}
				}, 5000);

				// Handle process exit
				session.emitter.on('exit', (code: number) => {
					if (completed) return;
					cleanup();
					clearTimeout(timeoutHandle);

					// Check if output file exists (agent may have written it before exiting)
					const hasOutput = existsSync(task.outputPath);
					resolve({
						taskId: task.taskId,
						role: task.role,
						status: hasOutput ? 'completed' : 'failed',
						outputPath: hasOutput ? task.outputPath : undefined,
						error: hasOutput ? undefined : `Agent exited with code ${code} without producing output`,
						startedAt,
						completedAt: new Date().toISOString(),
						provider: this.id,
					});
				});
			});

			return result;
		} catch (error) {
			this.activeSessions.delete(task.taskId);
			return {
				taskId: task.taskId,
				role: task.role,
				status: 'failed',
				error: error instanceof Error ? error.message : String(error),
				startedAt,
				completedAt: new Date().toISOString(),
				provider: this.id,
			};
		}
	}

	cancel(taskId: string): void {
		const session = this.activeSessions.get(taskId);
		if (session) {
			killSession(session.id);
			this.activeSessions.delete(taskId);
		}
	}
}
