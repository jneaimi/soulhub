/** ADR-033 Layer 1 — multi-path persona-bundle loader.
 *
 *  Reads a configurable set of vault files (soul.md, identity.md,
 *  user-profile.md, boundaries.md) and exposes them as a composable
 *  string bundle for the orchestrator system prompt. Cached in memory;
 *  vault `reindexed` events invalidate matching cache entries, so editing
 *  `operations/soul.md` in Obsidian hot-reloads the persona without a PM2
 *  restart.
 *
 *  Sibling of `channels/whatsapp/soul-loader.ts`, which serves the
 *  single-file heartbeat path with the same caching pattern. The two
 *  modules stay separate (instead of consolidating) because the
 *  heartbeat reads ONE file and the chat orchestrator reads multiple —
 *  consolidation can happen in a future cleanup once the chat path has
 *  stabilised. The cache here is independent; the per-path mtime + path
 *  match logic mirrors the soul-loader to keep behaviour predictable. */

import { createHash } from 'node:crypto';
import { getVaultEngine } from '../vault/index.js';
import { getVaultEvents, type VaultReindexEvent } from '../vault/events.js';

export interface PersonaPaths {
	soul?: string;
	userProfile?: string;
	boundaries?: string;
	identity?: string;
}

export interface PersonaBundle {
	soul: string;
	userProfile: string;
	boundaries: string;
	identity: string;
	/** Stable hash of the composed bundle. Surfaced in `DecideV2Telemetry`
	 *  so the audit dashboard can detect persona drift across edits — see
	 *  ADR-033 §Engines as validation surface, plays 1 and 4. */
	hash: string;
	/** True when at least one of the four files returned a non-empty body.
	 *  Used by the system-prompt builder to decide whether to emit the
	 *  persona section at all (empty bundle = silent fallback to the
	 *  pre-ADR-033 plain prompt). */
	hasContent: boolean;
}

const cache = new Map<string, string>();
let listenerInstalled = false;

function readBody(path: string): string {
	const engine = getVaultEngine();
	if (!engine) return '';
	const note = engine.getNote(path);
	// `content` is already frontmatter-stripped per VaultNote contract.
	return note ? note.content.trim() : '';
}

function installWatcherOnce(): void {
	if (listenerInstalled) return;
	listenerInstalled = true;
	getVaultEvents().on('reindexed', (event: VaultReindexEvent) => {
		// Manual full-scans omit `path` — bust the whole cache.
		if (!event.path) {
			cache.clear();
			return;
		}
		cache.delete(event.path);
	});
}

function getBody(path: string | undefined): string {
	if (!path) return '';
	installWatcherOnce();
	const cached = cache.get(path);
	if (cached !== undefined) return cached;
	const fresh = readBody(path);
	cache.set(path, fresh);
	return fresh;
}

/** Read the configured persona files and return the composed bundle. */
export function getPersonaBundle(paths: PersonaPaths): PersonaBundle {
	const soul = getBody(paths.soul);
	const userProfile = getBody(paths.userProfile);
	const boundaries = getBody(paths.boundaries);
	const identity = getBody(paths.identity);
	const hasContent = !!(soul || userProfile || boundaries || identity);
	const concat = `${soul}\n---\n${userProfile}\n---\n${boundaries}\n---\n${identity}`;
	const hash = createHash('sha1').update(concat).digest('hex').slice(0, 12);
	return { soul, userProfile, boundaries, identity, hash, hasContent };
}

/** Test-only / startup-only: clear all cached entries. */
export function _resetPersonaCache(): void {
	cache.clear();
}
