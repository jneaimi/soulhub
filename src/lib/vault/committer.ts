import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A single write operation that should produce (or contribute to) a git commit. */
export interface WriteEvent {
	action: 'create' | 'update' | 'archive' | 'move' | 'delete' | 'create-asset';
	path: string;
	previousPath?: string;
	zone?: string;
	type?: string;
	agent?: string;
	context?: string;
	at: number;
}

/** Per ADR-019. Coalesces bursts (e.g. keeper hygiene fixing 50 orphans
 *  in one heartbeat tick) into a single commit. Fire-and-forget — git
 *  failures are logged but never propagate to the writer; the daily
 *  backup task is the safety net. */
export class VaultCommitter {
	private readonly vaultDir: string;
	private pending: WriteEvent[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight = false;
	private gitAvailable: boolean | null = null;
	/** Coalesce window — short enough that a single user action commits
	 *  with minimal latency, long enough to absorb a multi-write hygiene
	 *  pass. */
	private static readonly DEBOUNCE_MS = 1500;

	constructor(vaultDir: string) {
		this.vaultDir = vaultDir;
	}

	/** Queue a write for inclusion in the next commit. Safe to call from
	 *  any vault writer; never throws. */
	enqueue(event: Omit<WriteEvent, 'at'>): void {
		this.pending.push({ ...event, at: Date.now() });
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.flush();
		}, VaultCommitter.DEBOUNCE_MS);
	}

	private async flush(): Promise<void> {
		if (this.inFlight) {
			// Re-arm — a previous flush is still running; try again shortly.
			this.timer = setTimeout(() => void this.flush(), 500);
			return;
		}
		const batch = this.pending.splice(0);
		if (batch.length === 0) return;

		// Lazy gate — skip silently if vault isn't a git repo (tests, fresh
		// installs, dev environments without the daily backup wired up).
		if (this.gitAvailable === null) {
			this.gitAvailable = await this.checkGitRepo();
		}
		if (!this.gitAvailable) return;

		this.inFlight = true;
		try {
			await this.runGit(['add', '-A']);
			const status = await this.runGit(['status', '--porcelain']);
			if (!status.trim()) {
				// Nothing to commit — every change was caught by .gitignore
				// (e.g. only `.DS_Store` got touched).
				return;
			}
			const message = buildCommitMessage(batch);
			await this.runGit(['commit', '-m', message]);
		} catch (err) {
			console.warn(
				`[vault-git] Event-driven commit failed (${batch.length} events) — ` +
					`daily backup will catch up: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			this.inFlight = false;
		}
	}

	private async checkGitRepo(): Promise<boolean> {
		try {
			await stat(join(this.vaultDir, '.git'));
			return true;
		} catch {
			return false;
		}
	}

	private runGit(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn('git', ['-C', this.vaultDir, ...args], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk.toString();
			});
			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) resolve(stdout);
				else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
			});
		});
	}
}

/** Build a human-readable commit message from a batch of write events.
 *  Single-event batches get a descriptive message. Multi-event batches
 *  are summarized — keeper hygiene runs become one line. */
export function buildCommitMessage(batch: WriteEvent[]): string {
	if (batch.length === 1) {
		const e = batch[0];
		const zone = e.zone ?? e.path.split('/')[0] ?? 'vault';
		const filename = e.path.split('/').pop() ?? e.path;
		const verb = ACTION_VERB[e.action] ?? e.action;
		return `vault(${zone}): ${verb} ${filename}`;
	}

	// Multi-event batch — summarize.
	// If everything came from one agent, lead with it ("vault(hygiene): 23 fixes").
	const agents = new Set(batch.map((e) => e.agent).filter(Boolean));
	if (agents.size === 1) {
		const agent = [...agents][0];
		// `keeper` is the agent name for hygiene runs — render as "hygiene"
		// for readability.
		const label = agent === 'keeper' ? 'hygiene' : agent;
		return `vault(${label}): ${batch.length} changes`;
	}

	// Mixed batch — break down by action.
	const byAction = new Map<string, number>();
	for (const e of batch) {
		byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
	}
	const breakdown = [...byAction.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([action, n]) => `${n} ${action}`)
		.join(', ');
	return `vault: ${batch.length} changes (${breakdown})`;
}

const ACTION_VERB: Record<WriteEvent['action'], string> = {
	create: 'create',
	update: 'update',
	archive: 'archive',
	move: 'move',
	delete: 'delete',
	'create-asset': 'add',
};
