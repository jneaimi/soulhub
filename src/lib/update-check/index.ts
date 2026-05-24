/**
 * Update-check (ADR-010) — public-distribution release-drift detection.
 *
 * The daily `update-check` scheduler task calls {@link refreshUpdateCache} to
 * fetch the public repo's latest *published* GitHub Release and write a small
 * cache file. Everything else (the version endpoint, the layout load, the
 * AppHeader banner, the doctor step) reads only that cache via
 * {@link readUpdateCache} — never live-fetches — so it stays cheap and offline-
 * safe (ADR-010 F2: the version endpoint returns in well under 50ms with the
 * network down, returning `null` on a cold cache).
 *
 * Gated behind `features.updateCheck`; meaningless on the operator's private
 * instance (which develops features before they ship), so the default is off
 * and the merge in `applyAdditiveSchemaDefaults` never reconciles the task
 * there (ADR-010 F1).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { soulHubDataFile } from '../paths.js';

/** Public repo the update-check polls. (Private canonical is jneaimi/soul-hub.) */
const PUBLIC_REPO = 'jneaimi/soulhub';
const RELEASES_LATEST = `https://api.github.com/repos/${PUBLIC_REPO}/releases/latest`;

/** Shape persisted to ~/.soul-hub/data/update-check.json. */
export interface UpdateCache {
	/** e.g. "v2.1.0" — the release tag exactly as GitHub reports it. */
	latestTag: string;
	/** ISO timestamp of the last successful fetch. */
	checkedAt: string;
	/** Human-facing release page, for the banner's "What's new" link. */
	releaseUrl: string;
}

function cachePath(): string {
	return soulHubDataFile('update-check.json');
}

/**
 * Read the cached latest-release info. Returns `null` when the cache is cold
 * (never written) or unreadable/corrupt — callers treat null as "unknown",
 * never as "up to date". Never throws.
 */
export function readUpdateCache(): UpdateCache | null {
	try {
		const raw = readFileSync(cachePath(), 'utf-8');
		const parsed = JSON.parse(raw) as Partial<UpdateCache>;
		if (typeof parsed.latestTag === 'string' && parsed.latestTag) {
			return {
				latestTag: parsed.latestTag,
				checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : '',
				releaseUrl: typeof parsed.releaseUrl === 'string' ? parsed.releaseUrl : '',
			};
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Fetch the latest published GitHub Release and write the cache. No-ops (leaves
 * any existing cache untouched) on network error, non-200, or a malformed body
 * — drift detection degrades to "stale", never crashes the scheduler tick.
 * Returns the written cache on success, `null` otherwise.
 */
export async function refreshUpdateCache(signal?: AbortSignal): Promise<UpdateCache | null> {
	try {
		const res = await fetch(RELEASES_LATEST, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'soul-hub-update-check' },
			signal,
		});
		if (!res.ok) {
			console.warn(`[update-check] ${RELEASES_LATEST} → HTTP ${res.status}; leaving cache stale`);
			return null;
		}
		const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
		const latestTag = typeof body.tag_name === 'string' ? body.tag_name : '';
		if (!latestTag) {
			console.warn('[update-check] release payload had no tag_name; leaving cache stale');
			return null;
		}
		const cache: UpdateCache = {
			latestTag,
			checkedAt: new Date().toISOString(),
			releaseUrl:
				typeof body.html_url === 'string' && body.html_url
					? body.html_url
					: `https://github.com/${PUBLIC_REPO}/releases/latest`,
		};
		writeFileSync(cachePath(), JSON.stringify(cache, null, 2) + '\n', 'utf-8');
		return cache;
	} catch (err) {
		console.warn('[update-check] refresh failed; leaving cache stale:', (err as Error).message);
		return null;
	}
}

/** Parse "v2.1.0" / "2.1.0" → [2,1,0]. Non-semver → null. */
function parseSemver(v: string): [number, number, number] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * True iff `latest` is a strictly higher semver than `current`. The `v` prefix
 * is stripped on either side. Unparseable input → false (never claim an update
 * when we can't be sure), so a garbage tag can't surface a phantom banner.
 */
export function isNewer(latest: string | null | undefined, current: string): boolean {
	if (!latest) return false;
	const a = parseSemver(latest);
	const b = parseSemver(current);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] > b[i]) return true;
		if (a[i] < b[i]) return false;
	}
	return false;
}

/** Resolved update state surfaced to the version endpoint + the layout/banner. */
export interface UpdateState {
	latestVersion: string | null;
	releaseUrl: string | null;
	checkedAt: string | null;
	updateAvailable: boolean;
}

/**
 * Resolve the full update state from the cache + the running version. Used by
 * the version endpoint and the layout load. `updateAvailable` is only ever true
 * when the cache holds a strictly-newer published tag.
 */
export function getUpdateState(currentVersion: string): UpdateState {
	const cache = readUpdateCache();
	if (!cache) {
		return { latestVersion: null, releaseUrl: null, checkedAt: null, updateAvailable: false };
	}
	return {
		latestVersion: cache.latestTag,
		releaseUrl: cache.releaseUrl || null,
		checkedAt: cache.checkedAt || null,
		updateAvailable: isNewer(cache.latestTag, currentVersion),
	};
}
