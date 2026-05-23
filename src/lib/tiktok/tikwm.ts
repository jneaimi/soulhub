/**
 * Tier 0 — TikTok metadata via tikwm.com (third-party JSON wrapper).
 *
 * Why this exists: yt-dlp + `--impersonate=chrome` is rate-limit-fragile —
 * after 2-3 successful calls from the same server IP TikTok's anti-bot starts
 * serving the JS-challenge page. tikwm runs the scrape from their own
 * residential pool, so calls from our IP never hit TikTok directly. At our
 * volume (~100 lookups/month) we sit well under their documented 5k/day,
 * 1 req/sec ceiling.
 *
 * This is OPPORTUNISTIC: any non-200, non-zero `code`, parse failure, or
 * timeout returns `null` and the caller falls back to yt-dlp. tikwm is a
 * third-party service — we never let it become a hard dependency.
 *
 * Disable at runtime via `SOUL_HUB_TIKTOK_TIKWM_DISABLED=1`.
 *
 * Sources:
 *   - knowledge/research/2026-05-10-tiktok-scraper-alternatives.md
 *   - https://www.tikwm.com/  (no auth, no signup)
 */

import type { TikTokMetadata } from './types.js';

const TIKWM_ENDPOINT = 'https://www.tikwm.com/api/';
const TIMEOUT_MS = 8_000;

/** Shape of `data` in the tikwm response. Only fields we read are listed —
 *  the API returns ~30 more (CDN urls, music metadata, region, etc.) that we
 *  ignore. Documented behavior: missing fields are simply absent (no `null`
 *  marker). */
interface TikwmData {
	id?: string;
	title?: string;
	duration?: number;
	play_count?: number;
	digg_count?: number;
	comment_count?: number;
	share_count?: number;
	/** Unix timestamp seconds. */
	create_time?: number;
	author?: {
		unique_id?: string;
		nickname?: string;
	};
}

interface TikwmResponse {
	/** 0 = success. Non-zero = error (rate limit, invalid url, region-locked). */
	code?: number;
	msg?: string;
	data?: TikwmData;
}

export function isTikwmDisabled(): boolean {
	return process.env.SOUL_HUB_TIKTOK_TIKWM_DISABLED === '1';
}

/**
 * Fetch metadata for a TikTok URL via tikwm. Returns `null` on ANY failure
 * (HTTP error, parse error, timeout, non-zero code, missing required fields).
 * Caller is responsible for the fallback path.
 *
 * The expected videoId is passed in so we can sanity-check tikwm's response —
 * if it returns metadata for a different video (cache poisoning, redirected
 * URL) we discard it rather than feed garbage to the LLM.
 */
export async function fetchTikTokMetadataViaTikwm(
	watchUrl: string,
	expectedVideoId: string,
	signal?: AbortSignal,
): Promise<TikTokMetadata | null> {
	if (isTikwmDisabled()) return null;

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	const onParentAbort = () => ac.abort();
	signal?.addEventListener('abort', onParentAbort, { once: true });

	try {
		const url = `${TIKWM_ENDPOINT}?url=${encodeURIComponent(watchUrl)}&hd=0`;
		const res = await fetch(url, {
			method: 'GET',
			signal: ac.signal,
			headers: {
				// tikwm doesn't require auth but rejects requests with no UA.
				'User-Agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
					'(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
				Accept: 'application/json',
			},
		});

		if (!res.ok) {
			console.warn(`[tiktok/tikwm] HTTP ${res.status} for ${expectedVideoId}`);
			return null;
		}

		const body = (await res.json()) as TikwmResponse;
		if (body.code !== 0 || !body.data) {
			console.warn(
				`[tiktok/tikwm] non-success code=${body.code} msg=${body.msg ?? ''} for ${expectedVideoId}`,
			);
			return null;
		}

		const d = body.data;

		// Sanity check — tikwm should return the same id we asked for. If not,
		// drop the response rather than mismatch fields to the wrong video.
		if (d.id && d.id !== expectedVideoId) {
			console.warn(
				`[tiktok/tikwm] id mismatch — expected ${expectedVideoId} got ${d.id}; discarding`,
			);
			return null;
		}

		const handle = (d.author?.unique_id ?? '').replace(/^@/, '');
		if (!handle) {
			// No author handle = response is too thin to be useful. Bail.
			console.warn(`[tiktok/tikwm] no author handle in response for ${expectedVideoId}`);
			return null;
		}

		const caption = (d.title ?? '').trim();

		return {
			author: handle,
			authorHandle: handle,
			title: undefined,
			caption,
			durationSec: positiveInt(d.duration) ?? 0,
			postedAt: unixToIsoDate(d.create_time),
			views: positiveInt(d.play_count),
			likes: positiveInt(d.digg_count),
			comments: positiveInt(d.comment_count),
			reposts: positiveInt(d.share_count),
		};
	} catch (err) {
		const msg = (err as Error).message ?? String(err);
		// Timeouts & abort surface here — log and return null.
		console.warn(`[tiktok/tikwm] fetch failed for ${expectedVideoId}: ${msg}`);
		return null;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onParentAbort);
	}
}

function positiveInt(n: number | undefined): number | undefined {
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
	return Math.trunc(n);
}

/** tikwm's `create_time` is unix seconds. yt-dlp's `upload_date` is `YYYYMMDD`,
 *  which we already reformat to ISO `YYYY-MM-DD` upstream — we match that
 *  shape here so callers don't need a branch. */
function unixToIsoDate(unixSec: number | undefined): string | undefined {
	if (typeof unixSec !== 'number' || !Number.isFinite(unixSec) || unixSec <= 0) return undefined;
	const date = new Date(unixSec * 1000);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString().slice(0, 10);
}
