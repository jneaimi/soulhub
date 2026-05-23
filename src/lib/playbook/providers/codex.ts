import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { PlaybookProvider, TaskAssignment, TaskResult, TaskOutputCallback } from './types.js';

const execFileAsync = promisify(execFile);

export class CodexProvider implements PlaybookProvider {
	readonly id = 'codex';
	readonly name = 'OpenAI Codex';

	/** Track active processes for cancellation */
	private activeProcesses = new Map<string, { kill: () => void }>();

	async available(): Promise<boolean> {
		try {
			await execFileAsync('which', ['codex']);
			return true;
		} catch {
			return false;
		}
	}

	async execute(task: TaskAssignment, onOutput?: TaskOutputCallback): Promise<TaskResult> {
		const startedAt = new Date().toISOString();

		// Build the prompt
		const promptParts: string[] = [];

		if (task.contextPrompt) {
			promptParts.push(task.contextPrompt);
		}

		promptParts.push(`## Your Task\n\n${task.task}`);

		if (task.inputFiles.length > 0) {
			for (const file of task.inputFiles) {
				try {
					const content = await readFile(file, 'utf-8');
					const truncated = content.length > 5000
						? content.slice(0, 5000) + '\n\n... (truncated)'
						: content;
					promptParts.push(`\n## Input: ${file}\n\`\`\`\n${truncated}\n\`\`\``);
				} catch {
					promptParts.push(`\n## Input: ${file}\n(could not read)`);
				}
			}
		}

		promptParts.push(`\n## Output\n\nWrite your complete output to: ${task.outputPath}\n\nIMPORTANT: You MUST write your output to the exact path above using the appropriate file writing tool.`);

		const fullPrompt = promptParts.join('\n\n');

		// Write prompt to temp file for long prompts
		const promptFile = join(tmpdir(), `codex-prompt-${task.taskId}.md`);
		await mkdir(dirname(promptFile), { recursive: true });
		await writeFile(promptFile, fullPrompt, 'utf-8');

		// Build codex command args
		const args: string[] = ['exec'];

		const model = task.model || 'o4-mini';
		args.push('-m', model);

		args.push('--full-auto');
		args.push('--skip-git-repo-check');

		// Read prompt from file to avoid shell escaping issues
		const promptContent = await readFile(promptFile, 'utf-8');
		args.push(promptContent);

		// Ensure output directory exists
		await mkdir(dirname(task.outputPath), { recursive: true });

		try {
			const result = await new Promise<TaskResult>((resolve) => {
				let completed = false;
				let stdout = '';
				let stderr = '';

				const timeoutMs = (task.timeout || 300) * 1000;

				const child = spawn('codex', args, {
					cwd: task.cwd,
					env: {
						...process.env,
						...(task.env || {}),
					},
					stdio: ['pipe', 'pipe', 'pipe'],
				});

				this.activeProcesses.set(task.taskId, {
					kill: () => child.kill('SIGTERM'),
				});

				const timeoutHandle = setTimeout(() => {
					if (completed) return;
					completed = true;
					child.kill('SIGTERM');
					this.activeProcesses.delete(task.taskId);
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

				child.stdout.on('data', (data: Buffer) => {
					const chunk = data.toString();
					stdout += chunk;
					if (onOutput) onOutput(task.taskId, chunk);
				});

				child.stderr.on('data', (data: Buffer) => {
					stderr += data.toString();
				});

				child.on('close', async (code: number | null) => {
					if (completed) return;
					completed = true;
					clearTimeout(timeoutHandle);
					this.activeProcesses.delete(task.taskId);

					const hasOutput = existsSync(task.outputPath);

					if (hasOutput) {
						resolve({
							taskId: task.taskId,
							role: task.role,
							status: 'completed',
							outputPath: task.outputPath,
							startedAt,
							completedAt: new Date().toISOString(),
							provider: this.id,
						});
					} else if (stdout.trim()) {
						try {
							await writeFile(task.outputPath, stdout, 'utf-8');
							resolve({
								taskId: task.taskId,
								role: task.role,
								status: 'completed',
								outputPath: task.outputPath,
								startedAt,
								completedAt: new Date().toISOString(),
								provider: this.id,
							});
						} catch (writeErr) {
							resolve({
								taskId: task.taskId,
								role: task.role,
								status: 'failed',
								error: `Codex produced output but failed to write: ${writeErr}`,
								startedAt,
								completedAt: new Date().toISOString(),
								provider: this.id,
							});
						}
					} else {
						resolve({
							taskId: task.taskId,
							role: task.role,
							status: 'failed',
							error: `Codex exited with code ${code} without producing output${stderr ? ': ' + stderr.slice(0, 200) : ''}`,
							startedAt,
							completedAt: new Date().toISOString(),
							provider: this.id,
						});
					}
				});

				child.on('error', (err: Error) => {
					if (completed) return;
					completed = true;
					clearTimeout(timeoutHandle);
					this.activeProcesses.delete(task.taskId);
					resolve({
						taskId: task.taskId,
						role: task.role,
						status: 'failed',
						error: `Codex spawn error: ${err.message}`,
						startedAt,
						completedAt: new Date().toISOString(),
						provider: this.id,
					});
				});
			});

			try { await unlink(promptFile); } catch { /* ok */ }

			return result;
		} catch (error) {
			this.activeProcesses.delete(task.taskId);
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
		const proc = this.activeProcesses.get(taskId);
		if (proc) {
			proc.kill();
			this.activeProcesses.delete(taskId);
		}
	}
}
