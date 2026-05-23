/** Reads `operations/soul.md` (or whatever `heartbeat.soulPath` points to)
 *  and exposes the body as the heartbeat's system prompt. Cached in
 *  memory; invalidates on vault `reindexed` events whose path matches.
 *
 *  Read errors keep the last-good body — the heartbeat must never be
 *  blocked by a transient vault state. */

import { getVaultEngine } from '../vault/index.js';
import { getVaultEvents, type VaultReindexEvent } from '../vault/events.js';

let cachedSoulPath: string | null = null;
let cachedBody: string | null = null;
let listenerInstalled = false;

function readSoulFromVault(soulPath: string): string | null {
	const engine = getVaultEngine();
	if (!engine) return null;
	const note = engine.getNote(soulPath);
	if (!note) return null;
	// `content` is already frontmatter-stripped per VaultNote contract.
	return note.content.trim();
}

function installWatcherOnce(soulPathProvider: () => string): void {
	if (listenerInstalled) return;
	listenerInstalled = true;

	getVaultEvents().on('reindexed', (event: VaultReindexEvent) => {
		// Manual full-scans omit `path`; we re-read on next call by busting
		// the cache wholesale. Watcher events with a matching path also bust.
		if (!event.path) {
			cachedBody = null;
			return;
		}
		const watching = soulPathProvider();
		if (event.path === watching) {
			cachedBody = null;
		}
	});
}

/** Get the soul body. Returns empty string if the file is missing — the
 *  caller (heartbeat composer) treats empty body as "no personality
 *  override, fall back to a neutral system prompt". */
export function getSoulBody(soulPath: string): string {
	installWatcherOnce(() => cachedSoulPath ?? soulPath);

	if (cachedSoulPath !== soulPath) {
		// Path changed in settings — bust the cache.
		cachedSoulPath = soulPath;
		cachedBody = null;
	}

	if (cachedBody !== null) return cachedBody;

	const fresh = readSoulFromVault(soulPath);
	if (fresh === null) {
		// On miss, cache an empty string so we don't hammer the engine
		// every tick. The reindex listener will bust it when the file appears.
		cachedBody = '';
		return '';
	}
	cachedBody = fresh;
	return fresh;
}

/** Test-only / startup-only: clear caches. */
export function _resetSoulLoaderCache(): void {
	cachedSoulPath = null;
	cachedBody = null;
}
