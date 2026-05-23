import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import type { TaskNode } from '../types.js';
import type { OrchestrationProvider, ProviderSession } from './types.js';

const execFileAsync = promisify(execFile);

/** Track active Codex processes for kill/isAlive */
const activeProcesses = new Map<string, { pid: number; kill: () => void }>();

export class CodexOrchProvider implements OrchestrationProvider {
	readonly id = 'codex' as const;
	readonly name = 'OpenAI Codex';

	async available(): Promise<boolean> {
		try {
			await execFileAsync('which', ['codex']);
			return true;
		} catch {
			return false;
		}
	}

	async setup(): Promise<void> {
		// Codex doesn't need CLAUDE.md or special setup.
		// File ownership rules are embedded in the task prompt by the PM.
	}

	async spawn(
		worktreePath: string,
		task: TaskNode,
		_projectPath?: string,
	): Promise<ProviderSession> {
		const emitter = new EventEmitter();
		emitter.setMaxListeners(10);

		const args = ['exec', '--full-auto', '--skip-git-repo-check', task.prompt];

		const child = spawn('codex', args, {
			cwd: worktreePath,
			env: { ...process.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const sessionId = `codex-${child.pid}`;

		activeProcesses.set(sessionId, {
			pid: child.pid!,
			kill: () => child.kill('SIGTERM'),
		});

		child.stdout?.on('data', (data: Buffer) => {
			emitter.emit('output', data.toString());
		});

		child.stderr?.on('data', (data: Buffer) => {
			emitter.emit('output', data.toString());
		});

		child.on('close', (code: number | null) => {
			activeProcesses.delete(sessionId);
			emitter.emit('exit', code ?? 1);
		});

		child.on('error', (err: Error) => {
			activeProcesses.delete(sessionId);
			emitter.emit('output', `Codex spawn error: ${err.message}\n`);
			emitter.emit('exit', 1);
		});

		return {
			id: sessionId,
			emitter,
			interactive: false,
		};
	}

	canReceiveInput(): boolean {
		return false;
	}

	sendInput(): boolean {
		return false;
	}

	kill(sessionId: string): void {
		const proc = activeProcesses.get(sessionId);
		if (proc) {
			proc.kill();
			activeProcesses.delete(sessionId);
		}
	}

	isAlive(sessionId: string): boolean {
		return activeProcesses.has(sessionId);
	}
}
