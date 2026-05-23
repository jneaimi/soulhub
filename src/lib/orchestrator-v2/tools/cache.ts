/** ADR-028 Phase 4a — in-session tool result cache.
 *
 *  Wraps read-only `execute()` bodies with a memo keyed on
 *  `<toolName>:<sha1(canonical(args))>`. Identical follow-up calls within
 *  the TTL window short-circuit the underlying fetch/DB/LLM call and
 *  return the cached `ToolResult` in <1ms.
 *
 *  **Scope:** in-process, in-memory only. Cleared on PM2 reload. Across
 *  workers a future Redis-backed variant could share the cache, but the
 *  common case (single user, single chat turn that fans into 2-3 tool
 *  calls) is already covered by the in-process map.
 *
 *  **Safety:** never wrap a tool that mutates state (vault-save, agent
 *  dispatch, reminder schedule, classification correction, etc.). Wrap
 *  only pure read tools that derive their result from a stable upstream
 *  (DB row, IMAP envelope, vault index). When in doubt, do not wrap.
 *
 *  **Canonicalization:** `JSON.stringify` with sorted keys, so
 *  `{a:1,b:2}` and `{b:2,a:1}` hash identically. Undefined values are
 *  dropped before serialisation so optional-arg variations don't fragment
 *  the cache.
 *
 *  **Errors:** when `execute` throws OR returns an `*-error` kind, the
 *  result is NOT cached — we don't want to pin a transient failure for
 *  30s. Successful results are cached regardless of kind. */

import { createHash } from 'node:crypto';

import type { ToolResult } from './index.js';

export interface ToolCacheOptions<Args = unknown> {
	/** TTL in milliseconds. Default 30_000 (30s). The orchestrator burst
	 *  pattern is 0-3 calls in a 1-3s window, but msg-N drill-down on a
	 *  list result reuses the same `inbox-list-queued` args within a
	 *  follow-up turn that might land 30-60s later. 30s covers both
	 *  without going stale on a fresh inbox tick. */
	ttlMs?: number;
	/** Cap on cache size. LRU-style eviction not implemented (yet);
	 *  oldest-first eviction triggered only when the cap is breached. */
	maxEntries?: number;
	/** Optional closure-derived key suffix — used when a tool's behaviour
	 *  depends on state outside its `args` (e.g. `conversationKey`,
	 *  per-user account, time-of-day bucket). The returned string is
	 *  appended to the canonical args before hashing so different
	 *  contexts get different cache slots. Stable for a given closure;
	 *  changes only between calls of `withToolCache`, not per-invocation
	 *  unless the function captures state itself. */
	scope?: () => string;
	/** Optional args canonicalizer — runs BEFORE the cache key is
	 *  computed. Use this to fill schema defaults so the LLM passing
	 *  `{}` vs `{ limit: 20 }` hashes to the same slot. The returned
	 *  object is also what `execute` receives — keep the shape identical
	 *  to the original `Args` type. */
	normalizeArgs?: (args: Args) => Args;
}

interface CacheEntry {
	result: ToolResult;
	expiresAt: number;
	insertedAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 256;

const cache = new Map<string, CacheEntry>();

/** Drop entries past their TTL. Cheap O(n) sweep — n is bounded by
 *  `maxEntries` and called only on a cache miss / eviction path. */
function sweepExpired(now: number): void {
	for (const [key, entry] of cache) {
		if (entry.expiresAt <= now) cache.delete(key);
	}
}

function evictOldest(): void {
	const firstKey = cache.keys().next().value;
	if (firstKey !== undefined) cache.delete(firstKey);
}

function canonicalArgs(args: unknown): string {
	if (args === undefined || args === null || typeof args !== 'object') {
		return JSON.stringify(args ?? null);
	}
	return JSON.stringify(sortKeysDeep(args));
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			const v = obj[key];
			if (v === undefined) continue;
			out[key] = sortKeysDeep(v);
		}
		return out;
	}
	return value;
}

function cacheKey(toolName: string, args: unknown, scopeSalt: string): string {
	const canon = canonicalArgs(args);
	const hash = createHash('sha1')
		.update(canon)
		.update('|')
		.update(scopeSalt)
		.digest('hex')
		.slice(0, 16);
	return `${toolName}:${hash}`;
}

/** Tagged kinds that represent a failed tool call. Caching these would
 *  pin a transient error in front of a retry that would succeed.
 *  Updated whenever a new `*-error` variant lands in `ToolResult`. */
const ERROR_KINDS = new Set([
	'web-search-error',
	'vault-search-error',
	'image-error',
	'dispatch-error',
	'invoke-skill-error',
	'youtube-error',
	'tiktok-error',
	'vault-save-error',
	'reminder-error',
]);

function isErrorResult(result: ToolResult): boolean {
	return ERROR_KINDS.has(result.kind);
}

/** Decorator that wraps a tool's `execute` body with cache lookup +
 *  store. The wrapped function preserves the original `args → result`
 *  signature so callsites in `tools/index.ts` change by exactly one
 *  call: `execute: withToolCache('foo', async (args) => {...})`.
 *
 *  Important — wrap ONLY read-only tools. Wrapping a write tool will
 *  drop a real DB mutation on cache hit. */
export function withToolCache<Args>(
	toolName: string,
	execute: (args: Args) => Promise<ToolResult>,
	opts: ToolCacheOptions<Args> = {},
): (args: Args) => Promise<ToolResult> {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const scope = opts.scope;
	const normalizeArgs = opts.normalizeArgs;

	return async (rawArgs: Args): Promise<ToolResult> => {
		const args = normalizeArgs ? normalizeArgs(rawArgs) : rawArgs;
		const now = Date.now();
		const scopeSalt = scope ? scope() : '';
		const key = cacheKey(toolName, args, scopeSalt);
		const hit = cache.get(key);
		if (hit && hit.expiresAt > now) {
			const ageMs = now - hit.insertedAt;
			console.log(`[tool-cache] HIT ${toolName} age=${ageMs}ms key=${key.slice(-16)}`);
			return hit.result;
		}

		const result = await execute(args);

		if (!isErrorResult(result)) {
			if (cache.size >= maxEntries) {
				sweepExpired(now);
				while (cache.size >= maxEntries) evictOldest();
			}
			cache.set(key, {
				result,
				expiresAt: now + ttlMs,
				insertedAt: now,
			});
			console.log(`[tool-cache] STORE ${toolName} ttlMs=${ttlMs} key=${key.slice(-16)}`);
		}
		return result;
	};
}

/** Test-only — clears the cache. Not exposed from the barrel. */
export function _resetToolCacheForTests(): void {
	cache.clear();
}

/** Diagnostic — current cache size. Used by future status endpoint /
 *  log lines; safe to call from anywhere. */
export function toolCacheSize(): number {
	return cache.size;
}
