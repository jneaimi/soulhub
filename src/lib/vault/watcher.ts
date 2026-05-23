import { watch, type FSWatcher } from 'chokidar';
import { resolve, relative, isAbsolute } from 'node:path';
import { IGNORED_FOLDERS } from './types.js';

type WatcherEvent =
	| { type: 'add' | 'change'; path: string }
	| { type: 'unlink'; path: string }
	| { type: 'governance-change'; path: string };

export class VaultWatcher {
	private watcher: FSWatcher | null = null;
	private handler: ((event: WatcherEvent) => void) | null = null;
	private suppressedPaths = new Set<string>();

	/** Temporarily suppress watcher events for a path (used during engine writes) */
	suppress(relPath: string): void {
		this.suppressedPaths.add(relPath);
		setTimeout(() => this.suppressedPaths.delete(relPath), 5000);
	}

	start(vaultRoot: string, onEvent: (event: WatcherEvent) => void): void {
		this.handler = onEvent;

		// chokidar v5 removed glob support — watch the root dir and filter in `ignored`.
		const ignoredFoldersSet = new Set(IGNORED_FOLDERS);
		this.watcher = watch(vaultRoot, {
			ignored: (path, stats) => {
				if (!stats) return false; // allow descent into unknown entries
				if (stats.isDirectory()) {
					const name = path.split('/').pop() ?? '';
					return ignoredFoldersSet.has(name);
				}
				if (!path.endsWith('.md')) return true;
				// CLAUDE.md files are watched (not ignored) so governance can
				// re-scan when zone schemas change. The emit() handler routes
				// them to a `governance-change` event instead of `add/change`
				// so they never enter the note indexer.
				return false;
			},
			persistent: true,
			awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
			ignoreInitial: true,
			cwd: vaultRoot,
		});

		const emit = (type: 'add' | 'change' | 'unlink', filePath: string) => {
			if (!this.handler) return;
			const relPath = isAbsolute(filePath)
				? relative(vaultRoot, filePath)
				: filePath;
			if (this.suppressedPaths.has(relPath)) {
				this.suppressedPaths.delete(relPath);
				return;
			}
			// Zone-governance files (CLAUDE.md at any depth, strict basename
			// match) re-trigger governance.scan() rather than note indexing.
			// All three event types (add/change/unlink) collapse to a single
			// `governance-change` since the resolver re-walks the vault tree
			// each scan — distinguishing add vs change vs unlink doesn't help.
			if (relPath === 'CLAUDE.md' || relPath.endsWith('/CLAUDE.md')) {
				this.handler({ type: 'governance-change', path: relPath });
				return;
			}
			this.handler({ type, path: relPath });
		};

		this.watcher.on('add', (p) => emit('add', p));
		this.watcher.on('change', (p) => emit('change', p));
		this.watcher.on('unlink', (p) => emit('unlink', p));
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		this.handler = null;
	}
}
