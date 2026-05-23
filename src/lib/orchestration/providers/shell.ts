import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { TaskNode } from '../types.js';
import type { OrchestrationProvider, ProviderSession } from './types.js';

/** Track active shell processes */
const activeProcesses = new Map<string, { pid: number; kill: () => void }>();

export class ShellOrchProvider implements OrchestrationProvider {
	readonly id = 'shell' as const;
	readonly name = 'Shell';

	async available(): Promise<boolean> {
		return true;
	}

	async setup(): Promise<void> {
		// Shell doesn't need any setup
	}

	async spawn(
		worktreePath: string,
		task: TaskNode,
		_projectPath?: string,
	): Promise<ProviderSession> {
		const emitter = new EventEmitter();
		emitter.setMaxListeners(10);

		const shellBinary =
			process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

		const child = spawn(shellBinary, ['-c', task.prompt], {
			cwd: worktreePath,
			env: { ...process.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const sessionId = `shell-${child.pid}`;

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
			emitter.emit('output', `Shell spawn error: ${err.message}\n`);
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
