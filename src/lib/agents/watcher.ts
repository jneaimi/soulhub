/**
 * Lightweight filesystem watcher for the two agent lanes.
 *
 * Watches `~/.claude/agents/` and `~/.soul-hub/data/agents/` for `.md` and
 * `.yaml`/`.yml` add/change/unlink events. On any event, bumps the store
 * version so consumers can detect a change without diffing the full list.
 *
 * The /agents page already polls every 30s; this watcher keeps the data
 * fresh between polls when an external editor (or a Soul Hub write) modifies
 * an agent file. No SSE, no broadcast — minimum-viable for Phase 2.
 */

import { watch, type FSWatcher } from 'chokidar';
import { existsSync, mkdirSync } from 'node:fs';

import { laneADir, laneBDir, bumpStoreVersion } from './store.js';

let watchers: FSWatcher[] = [];

export function initAgentsWatcher(): void {
	if (watchers.length > 0) return; // already running

	const aDir = laneADir();
	const bDir = laneBDir();

	// Lane B may not exist yet on a fresh install — create so chokidar has
	// something to watch. Lane A might not exist on a non-Claude-Code system;
	// in that case we just skip watching it.
	mkdirSync(bDir, { recursive: true });

	const targets: { dir: string; label: string; ext: RegExp }[] = [];
	if (existsSync(aDir)) targets.push({ dir: aDir, label: 'A', ext: /\.md$/i });
	targets.push({ dir: bDir, label: 'B', ext: /\.ya?ml$/i });

	for (const t of targets) {
		const w = watch(t.dir, {
			persistent: true,
			ignoreInitial: true, // don't re-emit existing files at boot
			depth: 0, // top-level only
			ignored: (filePath: string) => {
				if (filePath === t.dir) return false;
				return !t.ext.test(filePath);
			},
		});

		const onEvent = (path: string) => {
			console.log(`[agents/watcher] lane ${t.label} change: ${path}`);
			bumpStoreVersion();
		};

		w.on('add', onEvent);
		w.on('change', onEvent);
		w.on('unlink', onEvent);
		w.on('error', (err: unknown) => {
			console.warn(`[agents/watcher] lane ${t.label} error:`, (err as Error).message);
		});

		watchers.push(w);
	}

	console.log(`[agents/watcher] watching ${targets.length} lane(s)`);
}

export async function shutdownAgentsWatcher(): Promise<void> {
	const ws = watchers;
	watchers = [];
	await Promise.all(ws.map((w) => w.close()));
}
