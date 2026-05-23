import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Manages a shared context workspace for a playbook run.
 * All agents in the run can read/write to this workspace.
 */
export class PlaybookContext {
	readonly dir: string;
	private locked = false;
	private pendingWrites: Array<{ path: string; content: string }> = [];

	constructor(runDir: string) {
		this.dir = join(runDir, 'context');
	}

	/** Initialize the context directory */
	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
	}

	/** Read a file from context */
	async read(relativePath: string): Promise<string> {
		return readFile(join(this.dir, relativePath), 'utf-8');
	}

	/** Lock context for read-only mode (used during parallel phases) */
	lock(): void {
		this.locked = true;
		this.pendingWrites = [];
	}

	/** Unlock and flush all pending writes (called after parallel phase completes) */
	async unlock(): Promise<void> {
		this.locked = false;
		for (const { path, content } of this.pendingWrites) {
			await this._writeToDisk(path, content);
		}
		this.pendingWrites = [];
	}

	/** Check if context is locked */
	isLocked(): boolean {
		return this.locked;
	}

	/** Queue a write for after unlock (used by parallel assignments) */
	queueWrite(relativePath: string, content: string): void {
		this.pendingWrites.push({ path: relativePath, content });
	}

	/** Write a file to context */
	async write(relativePath: string, content: string): Promise<void> {
		if (this.locked) {
			this.queueWrite(relativePath, content);
			return;
		}
		await this._writeToDisk(relativePath, content);
	}

	/** Append to a file in context (creates if doesn't exist) */
	async append(relativePath: string, content: string): Promise<void> {
		if (this.locked) {
			this.queueWrite(relativePath, content);
			return;
		}
		const fullPath = join(this.dir, relativePath);
		let existing = '';
		try { existing = await readFile(fullPath, 'utf-8'); } catch { /* new file */ }
		await writeFile(fullPath, existing + content, 'utf-8');
	}

	private async _writeToDisk(relativePath: string, content: string): Promise<void> {
		const fullPath = join(this.dir, relativePath);
		await mkdir(join(fullPath, '..'), { recursive: true });
		await writeFile(fullPath, content, 'utf-8');
	}

	/** List files in context */
	async list(): Promise<string[]> {
		if (!existsSync(this.dir)) return [];
		const entries = await readdir(this.dir, { recursive: true, withFileTypes: true });
		return entries.filter(e => e.isFile()).map(e => {
			// Build relative path from parent path + name
			const parent = e.parentPath || '';
			const rel = parent.replace(this.dir, '').replace(/^\//, '');
			return rel ? `${rel}/${e.name}` : e.name;
		});
	}

	/** Build a context prompt summarizing available files for agent injection */
	async buildContextPrompt(): Promise<string> {
		const files = await this.list();
		if (files.length === 0) return '';

		const sections: string[] = ['## Shared Context\n\nThe following files are available from prior phases:\n'];

		for (const file of files) {
			try {
				const content = await this.read(file);
				// Truncate large files to 2000 chars
				const truncated = content.length > 2000
					? content.slice(0, 2000) + '\n\n... (truncated)'
					: content;
				sections.push(`### ${file}\n\`\`\`\n${truncated}\n\`\`\`\n`);
			} catch {
				sections.push(`### ${file}\n(could not read)\n`);
			}
		}

		return sections.join('\n');
	}

	/** Clean up the context directory */
	async destroy(): Promise<void> {
		if (existsSync(this.dir)) {
			await rm(this.dir, { recursive: true, force: true });
		}
	}
}
