import { existsSync } from 'node:fs';
import {
	mkdir,
	writeFile,
	readFile,
	readdir,
	rm,
	stat,
	open,
	appendFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OrchestrationRun, WorkerState, BoardEntry } from './types.js';

const BASE_DIR = join(homedir(), '.soul-hub', 'orchestration');

const ID_RE = /^[\w-]+$/;

function validateId(id: string): void {
	if (!ID_RE.test(id)) {
		throw new Error(`Invalid ID: ${id}`);
	}
}

export function getRunDir(runId: string): string {
	validateId(runId);
	return join(BASE_DIR, runId);
}

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

// ── Run persistence ──────────────────────────────────────────────

export async function saveRun(run: OrchestrationRun): Promise<void> {
	const dir = getRunDir(run.runId);
	await ensureDir(dir);
	await writeFile(join(dir, 'run.json'), JSON.stringify(run, null, 2), 'utf-8');
}

export async function loadRun(runId: string): Promise<OrchestrationRun | null> {
	try {
		const data = await readFile(join(getRunDir(runId), 'run.json'), 'utf-8');
		return JSON.parse(data) as OrchestrationRun;
	} catch {
		return null;
	}
}

export async function listRuns(limit = 20): Promise<OrchestrationRun[]> {
	try {
		await ensureDir(BASE_DIR);
		const entries = await readdir(BASE_DIR, { withFileTypes: true });
		const runs: OrchestrationRun[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const run = await loadRun(entry.name);
			if (run) runs.push(run);
		}

		runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return runs.slice(0, limit);
	} catch {
		return [];
	}
}

export async function listActiveRuns(): Promise<OrchestrationRun[]> {
	const all = await listRuns(999);
	return all.filter(
		(r) =>
			r.status === 'running' ||
			r.status === 'approved' ||
			r.status === 'planning' ||
			r.status === 'merging',
	);
}

export async function deleteRun(runId: string): Promise<void> {
	const dir = getRunDir(runId);
	if (existsSync(dir)) {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Archive a run: clean worktrees and branches but keep run data as read-only history.
 */
export async function archiveRun(runId: string): Promise<void> {
	const run = await loadRun(runId);
	if (!run) return;

	// Clean worktrees and branches for this run
	const { listWorktrees, removeWorktree, deleteBranch } = await import('./worktree.js');
	try {
		const worktrees = await listWorktrees(run.projectPath, runId);
		for (const wt of worktrees) {
			await removeWorktree(wt.path, true).catch(() => {});
			await deleteBranch(run.projectPath, wt.branch).catch(() => {});
		}
	} catch { /* best effort */ }

	// Mark as archived and save
	run.status = 'archived';
	if (!run.completedAt) run.completedAt = new Date().toISOString();
	await saveRun(run);
}

// ── Plan persistence ─────────────────────────────────────────────

export async function savePlan(run: OrchestrationRun): Promise<void> {
	const dir = getRunDir(run.runId);
	await ensureDir(dir);
	await writeFile(join(dir, 'plan.json'), JSON.stringify(run.plan, null, 2), 'utf-8');
}

// ── Worker state ─────────────────────────────────────────────────

export async function saveWorkerState(runId: string, state: WorkerState): Promise<void> {
	const dir = join(getRunDir(runId), 'workers');
	await ensureDir(dir);
	validateId(state.taskId);
	await writeFile(join(dir, `${state.taskId}.status.json`), JSON.stringify(state, null, 2), 'utf-8');
}

export async function loadWorkerState(runId: string, taskId: string): Promise<WorkerState | null> {
	try {
		validateId(taskId);
		const data = await readFile(join(getRunDir(runId), 'workers', `${taskId}.status.json`), 'utf-8');
		return JSON.parse(data) as WorkerState;
	} catch {
		return null;
	}
}

// ── Worker output logs ───────────────────────────────────────────

const OUTPUT_MAX_BYTES = 512_000; // 500KB per worker log

export async function appendWorkerOutput(runId: string, taskId: string, data: string): Promise<void> {
	const dir = join(getRunDir(runId), 'workers');
	await ensureDir(dir);
	validateId(taskId);
	const logFile = join(dir, `${taskId}.output.log`);

	try {
		const s = await stat(logFile);
		if (s.size > OUTPUT_MAX_BYTES) return; // cap reached
	} catch { /* file doesn't exist yet */ }

	await appendFile(logFile, data, 'utf-8');
}

export async function readWorkerOutputTail(runId: string, taskId: string, bytes = 4096): Promise<string> {
	try {
		validateId(taskId);
		const logFile = join(getRunDir(runId), 'workers', `${taskId}.output.log`);
		const s = await stat(logFile);
		const fh = await open(logFile, 'r');
		const start = Math.max(0, s.size - bytes);
		const buf = Buffer.alloc(Math.min(bytes, s.size));
		try {
			await fh.read(buf, 0, buf.length, start);
		} finally {
			await fh.close();
		}
		return buf.toString('utf-8');
	} catch {
		return '';
	}
}

// ── Board (human-readable status) ────────────────────────────────

export async function updateBoard(runId: string, entry: BoardEntry): Promise<void> {
	const dir = getRunDir(runId);
	await ensureDir(dir);
	const boardFile = join(dir, 'board.md');

	const run = await loadRun(runId);
	if (!run) return;

	const lines: string[] = [
		`# Orchestration Board — ${run.plan.goal}`,
		`Run: ${run.runId} | Status: ${run.status} | Started: ${run.startedAt || 'pending'}`,
		'',
		'## Workers',
		'| Task | Priority | Complexity | Worker | Status | Branch | Iterations |',
		'|------|----------|------------|--------|--------|--------|------------|',
	];

	for (const task of run.plan.tasks) {
		const w = run.workers[task.id];
		const pri = task.priority || '—';
		const cpx = task.estimatedComplexity || '—';
		if (!w) {
			lines.push(`| ${task.name} | ${pri} | ${cpx} | — | pending | — | — |`);
			continue;
		}
		const icon = w.status === 'done' ? '\u2713' : w.status === 'running' ? '\u25cf' : w.status === 'failed' ? '\u2717' : '\u25cb';
		lines.push(`| ${task.name} | ${pri} | ${cpx} | ${w.workerId} | ${icon} ${w.status} | ${w.branch} | ${w.iterationCount}/${task.maxIterations} |`);
	}

	// Append the new decision entry
	lines.push('', '## Decisions');

	// Read existing decisions from board if it exists
	try {
		const existing = await readFile(boardFile, 'utf-8');
		const decisionsMatch = existing.match(/## Decisions\n([\s\S]*?)(?=\n## |$)/);
		if (decisionsMatch) {
			lines.push(decisionsMatch[1].trim());
		}
	} catch { /* first write */ }

	lines.push(`- [${entry.timestamp}] ${entry.workerId}: ${entry.message}`);

	// Requests section
	const requests = await listWorkerRequests(runId);
	if (requests.length > 0) {
		lines.push('', '## Requests');
		for (const req of requests) {
			lines.push(`- [${req.taskId}] ${req.content}`);
		}
	}

	await writeFile(boardFile, lines.join('\n') + '\n', 'utf-8');
}

export async function readBoard(runId: string): Promise<string> {
	try {
		return await readFile(join(getRunDir(runId), 'board.md'), 'utf-8');
	} catch {
		return '';
	}
}

// ── Regenerate board from run state (no entry needed) ────────────

export async function regenerateBoard(runId: string): Promise<void> {
	const run = await loadRun(runId);
	if (!run) return;

	const dir = getRunDir(runId);
	const boardFile = join(dir, 'board.md');

	const lines: string[] = [
		`# Orchestration Board — ${run.plan.goal}`,
		`Run: ${run.runId} | Status: ${run.status} | Started: ${run.startedAt || 'pending'}`,
		'',
		'## Workers',
		'| Task | Priority | Complexity | Worker | Status | Branch | Iterations |',
		'|------|----------|------------|--------|--------|--------|------------|',
	];

	for (const task of run.plan.tasks) {
		const w = run.workers[task.id];
		const pri = task.priority || '—';
		const cpx = task.estimatedComplexity || '—';
		if (!w) {
			lines.push(`| ${task.name} | ${pri} | ${cpx} | — | pending | — | — |`);
			continue;
		}
		const icon = w.status === 'done' ? '\u2713' : w.status === 'running' ? '\u25cf' : w.status === 'failed' ? '\u2717' : '\u25cb';
		lines.push(`| ${task.name} | ${pri} | ${cpx} | ${w.workerId} | ${icon} ${w.status} | ${w.branch} | ${w.iterationCount}/${task.maxIterations} |`);
	}

	// Preserve existing decisions
	try {
		const existing = await readFile(boardFile, 'utf-8');
		const decisionsMatch = existing.match(/## Decisions\n([\s\S]*?)(?=\n## |$)/);
		if (decisionsMatch && decisionsMatch[1].trim()) {
			lines.push('', '## Decisions', decisionsMatch[1].trim());
		}
	} catch { /* no existing board */ }

	const requests = await listWorkerRequests(runId);
	if (requests.length > 0) {
		lines.push('', '## Requests');
		for (const req of requests) {
			lines.push(`- [${req.taskId}] ${req.content}`);
		}
	}

	await writeFile(boardFile, lines.join('\n') + '\n', 'utf-8');
}

// ── Ownership map ────────────────────────────────────────────────

export async function saveOwnershipMap(runId: string, map: Record<string, string>): Promise<void> {
	const dir = getRunDir(runId);
	await ensureDir(dir);
	await writeFile(join(dir, 'ownership.json'), JSON.stringify(map, null, 2), 'utf-8');
}

export async function loadOwnershipMap(runId: string): Promise<Record<string, string>> {
	try {
		const data = await readFile(join(getRunDir(runId), 'ownership.json'), 'utf-8');
		return JSON.parse(data) as Record<string, string>;
	} catch {
		return {};
	}
}

// ── Worker requests ──────────────────────────────────────────────

export async function listWorkerRequests(runId: string): Promise<Array<{ taskId: string; content: string }>> {
	const dir = join(getRunDir(runId), 'requests');
	try {
		const files = await readdir(dir);
		const requests: Array<{ taskId: string; content: string }> = [];

		for (const file of files) {
			if (!file.endsWith('.md')) continue;
			const taskId = file.replace('.md', '');
			try {
				const content = await readFile(join(dir, file), 'utf-8');
				requests.push({ taskId, content: content.trim() });
			} catch { /* skip unreadable */ }
		}

		return requests;
	} catch {
		return [];
	}
}
