/**
 * TikTok fetch — orchestrates the three tiers per ADR-024.
 *
 *   Tier A (yt-dlp --print metadata)            — always tried; produces metadata.
 *   Tier B (yt-dlp -x audio + whisper.cpp STT)  — fired on transcript/full modes.
 *   Tier C (Gemini multimodal on the mp4)       — fired on summary/full modes.
 *
 * Public surface: `fetchTikTok(input, opts)` → outcome (Result-shaped union).
 * Capability probe: `probeCapabilities()` re-exported from whisper module.
 *
 * Why a Result union over throwing: orchestrator-v2's tool layer wants
 * structured failure metadata (which tier failed, raw error) so the LLM can
 * compose a useful reply.
 */

import { canonicalizeTikTokUrl, UrlCanonicalizationError } from './url.js';
import { fetchTikTokMetadata } from './metadata.js';
import { fetchTikTokMetadataViaTikwm } from './tikwm.js';
import { downloadTikTokAudio } from './download.js';
import { transcribeWav, probeCapabilities } from './whisper.js';
import { fetchTikTokViaGemini } from './gemini.js';
import {
	TRANSCRIPT_MAX_CHARS,
	type TikTokConfigSlice,
	type TikTokFetchMode,
	type TikTokFetchOutcome,
	type TikTokFetchResult,
	type TikTokMetadata,
} from './types.js';

// ──────────────────────────────────────────────
// In-process result cache (videoId → result, 10-min TTL)
//
// Why: orchestrator-v2 sometimes dispatches `tiktokFetch` 3-4× per user message
// with different modes (transcript → metadata → summary → full). Each call
// previously re-ran yt-dlp metadata + download from scratch — same video,
// same IP, ~30s apart — which trips TikTok's anti-bot ("Unexpected response
// from webpage request") and spreads the rate-limit to subsequent legitimate
// calls. Caching the result by videoId eliminates the amplification.
//
// Merge semantics: a cached `metadata`-only result is upgraded in place when a
// later call computes transcript or summary, so mode escalation only ever
// runs the missing tier(s) — not the whole pipeline again.
// ──────────────────────────────────────────────

interface CacheEntry {
	result: TikTokFetchResult;
	expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 50;
const cache = new Map<string, CacheEntry>();

function modeIsSatisfied(r: TikTokFetchResult, mode: TikTokFetchMode): boolean {
	if (mode === 'metadata') return true;
	if (r.isPhotoPost) return true; // photo posts have no transcript/summary by design
	if (mode === 'transcript') return !!r.transcript;
	if (mode === 'summary') return !!r.summary;
	if (mode === 'full') return !!r.transcript && !!r.summary;
	return false;
}

function getCachedResult(videoId: string, mode: TikTokFetchMode): TikTokFetchResult | null {
	const entry = cache.get(videoId);
	if (!entry) return null;
	if (entry.expiresAt < Date.now()) {
		cache.delete(videoId);
		return null;
	}
	return modeIsSatisfied(entry.result, mode) ? entry.result : null;
}

function mergeIntoCache(videoId: string, result: TikTokFetchResult): void {
	const existing = cache.get(videoId);
	const merged: TikTokFetchResult = existing
		? {
				...existing.result,
				...result,
				transcript: result.transcript ?? existing.result.transcript,
				transcriptLang: result.transcriptLang ?? existing.result.transcriptLang,
				transcriptSource:
					result.transcriptSource !== 'none'
						? result.transcriptSource
						: existing.result.transcriptSource,
				summary: result.summary ?? existing.result.summary,
				costUsd: result.costUsd ?? existing.result.costUsd,
				// Keep the more-informative note (a cache-hit on the prior turn
				// shouldn't shadow a real note like 'whisper-not-installed').
				note: result.note ?? existing.result.note,
			}
		: result;
	cache.set(videoId, { result: merged, expiresAt: Date.now() + CACHE_TTL_MS });

	// Lazy GC — sweep expired entries when the cache grows
	if (cache.size > CACHE_MAX_ENTRIES) {
		const now = Date.now();
		for (const [k, v] of cache) {
			if (v.expiresAt < now) cache.delete(k);
		}
	}
}

/** Detect TikTok's anti-bot signature in a yt-dlp error message. TikTok's
 *  anti-bot has at least three distinct surfaces — the captcha/interstitial
 *  ("Unexpected response from webpage request"), the JS-challenge page where
 *  the extractor can't find the rehydration blob ("Unable to extract universal
 *  data for rehydration"), and outright HTTP 403/429. We treat all of these
 *  as the same condition: yt-dlp can't reach video data right now, retry
 *  later. Validated against the 2026-05-10 WhatsApp test where the bare
 *  "Unexpected response" check missed the rehydration variant and the model
 *  emitted a misleading "private/region-locked" reply. */
function isTikTokRateLimited(errMsg: string): boolean {
	return (
		/Unexpected response from webpage request/i.test(errMsg) ||
		/Unable to extract universal data/i.test(errMsg) ||
		/Unable to (?:find|extract) video data/i.test(errMsg) ||
		/blocked|rate.?limit|too many requests/i.test(errMsg) ||
		/HTTP Error 4(?:03|29)/i.test(errMsg) ||
		/Sign in to confirm you'?re not a bot/i.test(errMsg)
	);
}

/** Read any live cache entry for a videoId regardless of whether it
 *  satisfies a particular mode. Used on rate-limit fallback so we can surface
 *  prior-fetched metadata instead of an empty degraded shell. */
function peekCacheForRecovery(videoId: string): TikTokFetchResult | null {
	const entry = cache.get(videoId);
	if (!entry) return null;
	if (entry.expiresAt < Date.now()) {
		cache.delete(videoId);
		return null;
	}
	return entry.result;
}

/** Visible for tests: clear the cache between runs. */
export function _clearTikTokCache(): void {
	cache.clear();
}

export type {
	TikTokFetchMode,
	TikTokFetchOutcome,
	TikTokFetchResult,
	TikTokConfigSlice,
	TikTokCapabilities,
} from './types.js';

export { probeCapabilities } from './whisper.js';

export interface FetchTikTokOpts {
	mode: TikTokFetchMode;
	/** Settings slice — required for transcript/summary modes (controls the
	 *  daily quota + duration cap). When omitted or `enabled: false`, Tier
	 *  B/C are skipped and the result returns metadata-only with a `note`. */
	tiktokConfig?: TikTokConfigSlice;
	/** True when the daily Gemini cap has already been hit for this account.
	 *  Caller is responsible for checking + incrementing — `fetchTikTok`
	 *  doesn't touch the counter store directly so it stays pure. */
	summaryQuotaExceeded?: boolean;
	signal?: AbortSignal;
}

/** Top-level fetch. Tier A is always attempted; if it fails, the whole
 *  fetch fails (we have nothing to show the user). Tier B/C are conditional
 *  on `mode`, capability, and quota. */
export async function fetchTikTok(
	input: string,
	opts: FetchTikTokOpts,
): Promise<TikTokFetchOutcome> {
	const startedAt = Date.now();

	// Stage 1 — canonicalize.
	let canonical: Awaited<ReturnType<typeof canonicalizeTikTokUrl>>;
	try {
		canonical = await canonicalizeTikTokUrl(input);
	} catch (err) {
		const msg =
			err instanceof UrlCanonicalizationError ? err.message : (err as Error).message;
		return {
			ok: false,
			error: { url: input, tier: 'url', error: msg },
		};
	}

	// Stage 1.5 — cache lookup. Eliminates the 3-4× amplification when the
	// model dispatches multiple modes for the same video in quick succession.
	const cached = getCachedResult(canonical.videoId, opts.mode);
	if (cached) {
		return {
			ok: true,
			result: { ...cached, note: cached.note ?? 'cache-hit', durationMs: Date.now() - startedAt },
		};
	}

	// Stage 2 — Tier A metadata. Required.
	//
	// Two-stage strategy:
	//   Tier 0  — tikwm.com JSON wrapper. Free, runs from their pool, so our
	//             server IP is never the one that hits TikTok's anti-bot.
	//             Returns null on any failure (silently falls back).
	//   Tier A  — yt-dlp --print with `--impersonate=chrome`. Authoritative
	//             fallback that uses our IP — that's where rate limits bite.
	//
	// Order matters: tikwm absorbs the IP exposure for the high-volume
	// metadata calls. yt-dlp stays in the loop for Tier B audio download
	// (we don't trust tikwm's CDN URLs as a download path yet) and for the
	// metadata fallback when tikwm is down.
	let metadata: TikTokMetadata;

	const tikwm = await fetchTikTokMetadataViaTikwm(
		canonical.watchUrl,
		canonical.videoId,
		opts.signal,
	);
	if (tikwm) {
		metadata = tikwm;
		console.log(`[tiktok] metadata via tikwm for ${canonical.videoId}`);
	} else {
		try {
			metadata = await fetchTikTokMetadata(canonical.fetchUrl);
		} catch (err) {
			const errMsg = (err as Error).message;
			// If anti-bot blocked metadata extraction, degrade to a partial result
			// (using the canonical URL fields we already have) and surface
			// note='tiktok-rate-limited' so the model can tell the user to retry
			// later. Returning a hard error here makes the model say "private,
			// region-locked, or the link is wrong" — which is misleading and
			// removes any chance of a graceful retry path.
			if (isTikTokRateLimited(errMsg)) {
				console.warn(
					`[tiktok] metadata blocked by anti-bot for ${canonical.videoId}: ${errMsg}`,
				);
				// Recovery path: if a prior call already cached metadata for this
				// videoId, return that with the rate-limit note appended so the
				// user gets the rich data we already have plus a hint that the
				// deeper tiers couldn't run this turn. Strictly better than the
				// empty-shell degraded result.
				const recovered = peekCacheForRecovery(canonical.videoId);
				if (recovered) {
					console.warn(
						`[tiktok] serving cached metadata for ${canonical.videoId} (rate-limited this turn)`,
					);
					return {
						ok: true,
						result: {
							...recovered,
							note: 'tiktok-rate-limited',
							durationMs: Date.now() - startedAt,
						},
					};
				}
				const degradedResult: TikTokFetchResult = {
					url: canonical.watchUrl,
					videoId: canonical.videoId,
					metadata: {
						author: canonical.authorHandle ?? 'unknown',
						authorHandle: canonical.authorHandle ?? '',
						caption: '',
						durationSec: 0,
					},
					isPhotoPost: canonical.isPhotoPost,
					transcriptSource: 'none',
					note: 'tiktok-rate-limited',
					durationMs: Date.now() - startedAt,
				};
				// Degraded shell deliberately NOT cached — we want the next attempt
				// (after backoff) to try Tier A fresh rather than serve the empty
				// shell for 10 minutes.
				return { ok: true, result: degradedResult };
			}
			return {
				ok: false,
				error: {
					url: canonical.watchUrl,
					videoId: canonical.videoId,
					tier: 'metadata',
					error: errMsg,
				},
			};
		}
	}

	// If the canonicalizer detected an author handle but yt-dlp gave us a
	// different/empty one, prefer the URL form (it's authoritative for the
	// share link the user pasted).
	if (canonical.authorHandle && !metadata.authorHandle) {
		metadata.authorHandle = canonical.authorHandle;
		metadata.author = canonical.authorHandle;
	}

	const result: TikTokFetchResult = {
		url: canonical.watchUrl,
		videoId: canonical.videoId,
		metadata,
		isPhotoPost: canonical.isPhotoPost,
		transcriptSource: 'none',
		durationMs: 0,
	};

	// Stage 3 — early returns.
	if (opts.mode === 'metadata') {
		result.durationMs = Date.now() - startedAt;
		mergeIntoCache(canonical.videoId, result);
		return { ok: true, result };
	}

	if (canonical.isPhotoPost) {
		result.note = 'photo-post-no-audio';
		result.durationMs = Date.now() - startedAt;
		mergeIntoCache(canonical.videoId, result);
		return { ok: true, result };
	}

	if (!opts.tiktokConfig) {
		result.note = 'transcript-disabled';
		result.durationMs = Date.now() - startedAt;
		return { ok: true, result };
	}
	if (!opts.tiktokConfig.enabled) {
		result.note = 'transcript-disabled';
		result.durationMs = Date.now() - startedAt;
		return { ok: true, result };
	}
	if (
		opts.tiktokConfig.maxDurationSec > 0 &&
		metadata.durationSec > opts.tiktokConfig.maxDurationSec
	) {
		result.note = 'duration-cap-exceeded';
		result.durationMs = Date.now() - startedAt;
		return { ok: true, result };
	}

	const wantsTranscript = opts.mode === 'transcript' || opts.mode === 'full';
	const wantsSummary = opts.mode === 'summary' || opts.mode === 'full';

	const caps = probeCapabilities();
	if (wantsTranscript && !caps.tierBReady) {
		result.note = 'whisper-not-installed';
		// Don't bail — if summary was also requested and Gemini is configured,
		// continue to Tier C (transcript skipped).
		if (!wantsSummary) {
			result.durationMs = Date.now() - startedAt;
			return { ok: true, result };
		}
	}

	// Stage 4 — download once, reuse for both Tier B and Tier C if needed.
	let download: Awaited<ReturnType<typeof downloadTikTokAudio>> | null = null;
	try {
		download = await downloadTikTokAudio(canonical.fetchUrl, { signal: opts.signal });
	} catch (err) {
		// Download failed — return metadata with a graceful note. Don't fail
		// the whole fetch since Tier A already succeeded.
		const errMsg = (err as Error).message;
		console.warn(`[tiktok] download failed for ${canonical.videoId}: ${errMsg}`);
		// Distinguish anti-bot rate-limit from "tier B/C is broken" so the LLM
		// can tell the user to retry later instead of escalating modes (which
		// just punches anti-bot harder).
		if (isTikTokRateLimited(errMsg)) {
			result.note = 'tiktok-rate-limited';
		} else {
			result.note = wantsSummary ? 'gemini-failed' : 'whisper-failed';
		}
		result.durationMs = Date.now() - startedAt;
		mergeIntoCache(canonical.videoId, result);
		return { ok: true, result };
	}

	try {
		// Stage 5 — Tier B (whisper) if requested and ready.
		if (wantsTranscript && caps.tierBReady) {
			try {
				const lang = guessLang(metadata.caption);
				const t = await transcribeWav(download.wavPath, {
					lang,
					signal: opts.signal,
				});
				if (t.text) {
					result.transcript = truncateTranscript(t.text);
					result.transcriptLang = t.lang;
					result.transcriptSource = 'whisper-cpp';
				}
			} catch (err) {
				console.warn(
					`[tiktok] whisper failed for ${canonical.videoId}: ${(err as Error).message}`,
				);
				if (!result.note) result.note = 'whisper-failed';
			}
		}

		// Stage 6 — Tier C (Gemini summary) if requested.
		if (wantsSummary) {
			if (opts.summaryQuotaExceeded) {
				if (!result.note) result.note = 'summary-quota-exceeded';
			} else {
				try {
					const gemini = await fetchTikTokViaGemini(download.mp4Path, opts.mode, {
						model: opts.tiktokConfig.model,
						signal: opts.signal,
					});
					if (gemini.summary) result.summary = gemini.summary;
					// If Tier B didn't produce a transcript and Gemini did, use it.
					if (!result.transcript && gemini.transcript) {
						result.transcript = truncateTranscript(gemini.transcript);
						result.transcriptSource = 'gemini';
					}
					result.costUsd = gemini.costUsd;
				} catch (err) {
					console.warn(
						`[tiktok] gemini failed for ${canonical.videoId}: ${(err as Error).message}`,
					);
					if (!result.note) result.note = 'gemini-failed';
				}
			}
		}

		result.durationMs = Date.now() - startedAt;
		mergeIntoCache(canonical.videoId, result);
		return { ok: true, result };
	} finally {
		await download.cleanup();
	}
}

/** Heuristic — the on-platform caption text drives whisper's language pick.
 *  Default English; flip to Arabic on any Arabic codepoint. */
function guessLang(caption: string): string {
	if (/[؀-ۿݐ-ݿ]/.test(caption)) return 'ar';
	return 'en';
}

function truncateTranscript(transcript: string): string {
	if (transcript.length <= TRANSCRIPT_MAX_CHARS) return transcript;
	return transcript.slice(0, TRANSCRIPT_MAX_CHARS) + '\n\n[transcript truncated]';
}
