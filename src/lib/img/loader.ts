/** Reads `~/vault/operations/whatsapp/IMG.md` (or whatever
 *  `channels.whatsapp.img.systemPromptPath` points to) and exposes the
 *  body as the system prompt for `/img` calls. Cached in memory;
 *  invalidates on vault `reindexed` events whose path matches.
 *
 *  Same shape as `soul-loader.ts` / `heartbeat-loader.ts` — read errors
 *  keep the last-good body, and missing files cache an empty string so
 *  the engine isn't hammered on every call. */

import { getVaultEngine } from '../vault/index.js';
import { getVaultEvents, type VaultReindexEvent } from '../vault/events.js';

let cachedPath: string | null = null;
let cachedBody: string | null = null;
let listenerInstalled = false;

const FALLBACK_PROMPT =
	"You are an image agent. If the user attached an image, edit it. Otherwise generate a new image. Be concise; produce the image without preamble.";

function readFromVault(path: string): string | null {
	const engine = getVaultEngine();
	if (!engine) return null;
	const note = engine.getNote(path);
	if (!note) return null;
	return note.content.trim();
}

function installWatcherOnce(pathProvider: () => string): void {
	if (listenerInstalled) return;
	listenerInstalled = true;

	getVaultEvents().on('reindexed', (event: VaultReindexEvent) => {
		if (!event.path) {
			cachedBody = null;
			return;
		}
		const watching = pathProvider();
		if (event.path === watching) {
			cachedBody = null;
		}
	});
}

/** Returns the IMG.md body, or a baked-in fallback if the file is missing /
 *  empty. The fallback is intentionally minimal — the user is expected to
 *  edit IMG.md to grow the vocabulary, but a missing file shouldn't break
 *  `/img` for new installs. */
export function getImgSystemPrompt(path: string): string {
	installWatcherOnce(() => cachedPath ?? path);

	if (cachedPath !== path) {
		cachedPath = path;
		cachedBody = null;
	}

	if (cachedBody !== null) {
		return cachedBody.length > 0 ? cachedBody : FALLBACK_PROMPT;
	}

	const fresh = readFromVault(path);
	if (fresh === null || fresh.length === 0) {
		cachedBody = '';
		return FALLBACK_PROMPT;
	}
	cachedBody = fresh;
	return fresh;
}

/** Test-only / startup-only: clear caches. */
export function _resetImgLoaderCache(): void {
	cachedPath = null;
	cachedBody = null;
}
