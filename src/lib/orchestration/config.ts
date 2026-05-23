import { config } from '$lib/config.js';

export function getOrchestrationConfig() {
	return config.orchestration;
}

export function getMaxWorkers(): number {
	return config.orchestration?.maxWorkers ?? 4;
}

export function getMaxIterations(): number {
	return config.orchestration?.maxIterationsPerWorker ?? 8;
}

export function getWorktreeDir(): string {
	return config.orchestration?.worktreeDir ?? '.worktrees';
}

export function getDepInstaller(): 'pnpm' | 'npm' | 'auto' {
	return config.orchestration?.depInstaller ?? 'auto';
}
