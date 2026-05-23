/** Per-conversation cache for the most recent `/img` output. Lets a
 *  user follow up with `/save <title>` (no attachment) and have the
 *  bot's last generated image picked up automatically — the natural
 *  "discuss then save" flow that makes `/img` feel native.
 *
 *  In-memory by design: image buffers are 1–8 MB each, the TTL is
 *  short (10 min), and the only consumer is the same Node process
 *  that wrote the entry. Process restart drops the cache — acceptable,
 *  same trade-off as a stale conversation history would imply.
 *
 *  Eviction: 60-second sweep removes expired entries; size cap
 *  (`MAX_ENTRIES`) triggers LRU eviction synchronously on insert. */

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 50;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface CachedImage {
	buffer: Buffer;
	mimetype: string;
	prompt: string;
	ts: number;
}

const cache = new Map<string, CachedImage>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweep(): void {
	if (sweepTimer) return;
	sweepTimer = setInterval(() => {
		const cutoff = Date.now() - TTL_MS;
		for (const [key, entry] of cache) {
			if (entry.ts < cutoff) cache.delete(key);
		}
	}, SWEEP_INTERVAL_MS);
	// `unref` so the sweep doesn't keep the process alive on shutdown.
	if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

function evictOldestIfNeeded(): void {
	if (cache.size < MAX_ENTRIES) return;
	// Map iteration order is insertion order; the first key is the oldest
	// remaining entry by our usage pattern (we re-insert on each `remember`).
	const oldestKey = cache.keys().next().value;
	if (oldestKey !== undefined) cache.delete(oldestKey);
}

/** Store the most recent `/img` output for this conversation. Re-keying
 *  removes the previous entry first so insertion order = recency. */
export function rememberLastImage(
	conversationKey: string,
	entry: { buffer: Buffer; mimetype: string; prompt: string },
): void {
	ensureSweep();
	cache.delete(conversationKey);
	evictOldestIfNeeded();
	cache.set(conversationKey, { ...entry, ts: Date.now() });
}

/** Retrieve the most recent `/img` output for this conversation, or
 *  `undefined` if absent / expired. Hits update the entry's `ts` so
 *  /save → discuss → /save again still works within a single window. */
export function getLastImage(conversationKey: string): CachedImage | undefined {
	const entry = cache.get(conversationKey);
	if (!entry) return undefined;
	if (Date.now() - entry.ts > TTL_MS) {
		cache.delete(conversationKey);
		return undefined;
	}
	return entry;
}

/** Drop a specific conversation's cached image (called after a successful
 *  /save so a second /save can't accidentally write the same image twice). */
export function forgetLastImage(conversationKey: string): void {
	cache.delete(conversationKey);
}

/** Test-only — wipe everything. */
export function _resetImageCache(): void {
	cache.clear();
	if (sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = null;
	}
}

/** Diagnostic — current cache size. Surfaced in `/api/channels/whatsapp/status`
 *  if we ever want a "how many people are mid-flow" gauge. */
export function getCacheSize(): number {
	return cache.size;
}

// ----- Inbound user-image cache --------------------------------------------
//
// Symmetric to the bot-output cache above, but for the *inbound* side: when
// the user sends an image, we stash it so a follow-up `/img <prompt>` (no
// fresh attachment) can edit that image. Same TTL + sweep + LRU policy;
// distinct map so the two directions don't clobber each other.

interface CachedUserImage {
	buffer: Buffer;
	mimetype: string;
	ts: number;
}

const userCache = new Map<string, CachedUserImage>();
let userSweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureUserSweep(): void {
	if (userSweepTimer) return;
	userSweepTimer = setInterval(() => {
		const cutoff = Date.now() - TTL_MS;
		for (const [key, entry] of userCache) {
			if (entry.ts < cutoff) userCache.delete(key);
		}
	}, SWEEP_INTERVAL_MS);
	if (typeof userSweepTimer.unref === 'function') userSweepTimer.unref();
}

function evictOldestUserIfNeeded(): void {
	if (userCache.size < MAX_ENTRIES) return;
	const oldestKey = userCache.keys().next().value;
	if (oldestKey !== undefined) userCache.delete(oldestKey);
}

/** Store the user's most recent inbound image for this conversation. */
export function rememberLastUserImage(
	conversationKey: string,
	entry: { buffer: Buffer; mimetype: string },
): void {
	ensureUserSweep();
	userCache.delete(conversationKey);
	evictOldestUserIfNeeded();
	userCache.set(conversationKey, { ...entry, ts: Date.now() });
}

/** Retrieve the user's last inbound image, or `undefined` if absent / expired.
 *  Hits update `ts` so a `/img → reply → /img` chain stays fresh. */
export function getLastUserImage(conversationKey: string): CachedUserImage | undefined {
	const entry = userCache.get(conversationKey);
	if (!entry) return undefined;
	if (Date.now() - entry.ts > TTL_MS) {
		userCache.delete(conversationKey);
		return undefined;
	}
	return entry;
}

/** Drop a specific conversation's inbound cache. Reserved for future flows
 *  (e.g. an explicit "forget that photo" slash command). */
export function forgetLastUserImage(conversationKey: string): void {
	userCache.delete(conversationKey);
}
