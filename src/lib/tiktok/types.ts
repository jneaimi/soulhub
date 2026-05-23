/**
 * TikTok fetch — public types (ADR-024).
 *
 * Three-tier architecture:
 *   - Tier A — `yt-dlp --print` metadata. Always tried, ~1.5s, free.
 *   - Tier B — `yt-dlp -x` audio + `whisper-cli` STT. Conditional on mode,
 *              ~6-15s for short clips, free, local.
 *   - Tier C — Gemini multimodal on the downloaded mp4. Conditional on mode,
 *              ~12-25s, ~$0.001-0.03 per call, capped per-day.
 *
 * Validation backing: knowledge/research/2026-05-10-tiktok-fetch-options.md.
 */

export type TikTokFetchMode = 'metadata' | 'transcript' | 'summary' | 'full';

export interface TikTokMetadata {
	author: string;
	authorHandle: string;
	title?: string;
	caption: string;
	durationSec: number;
	postedAt?: string;
	views?: number;
	likes?: number;
	comments?: number;
	reposts?: number;
}

export interface TikTokFetchResult {
	url: string;
	videoId: string;
	metadata: TikTokMetadata;
	/** True for `tiktok.com/@u/photo/<id>` carousels — no audio, transcript skipped. */
	isPhotoPost: boolean;
	/** Present when mode includes transcript. Truncated to TRANSCRIPT_MAX_CHARS
	 *  before being handed to the LLM; full transcript stays available here
	 *  for any downstream consumer. */
	transcript?: string;
	transcriptLang?: string;
	transcriptSource: 'whisper-cpp' | 'gemini' | 'none';
	/** Present when mode includes summary. 2-3 paragraph plain-text summary. */
	summary?: string;
	costUsd?: number;
	durationMs: number;
	/** Set when a tier was skipped or failed but earlier tiers still produced
	 *  a result. Surfaces a hint to the LLM so it can tell the user. */
	note?:
		| 'transcript-disabled'
		| 'summary-quota-exceeded'
		| 'whisper-failed'
		| 'whisper-not-installed'
		| 'gemini-failed'
		| 'gemini-not-configured'
		| 'duration-cap-exceeded'
		| 'photo-post-no-audio'
		/** TikTok's anti-bot blocked the download (yt-dlp returned "Unexpected
		 *  response from webpage request"). Distinct from whisper/gemini-failed
		 *  so the LLM can tell the user to retry later instead of mode-shopping. */
		| 'tiktok-rate-limited'
		/** Result was served from the in-process cache (videoId hit within
		 *  CACHE_TTL_MS). Useful for telemetry / debugging duplicate calls. */
		| 'cache-hit';
}

export interface TikTokFetchError {
	url: string;
	videoId?: string;
	tier: 'url' | 'metadata' | 'download' | 'whisper' | 'gemini';
	error: string;
}

/** Subset of `cfg.tiktok` that the orchestrator needs. Decoupled from the
 *  full settings shape so tests can construct it without loading config.
 *  Mirrors `YoutubeConfigSlice`. */
export interface TikTokConfigSlice {
	enabled: boolean;
	maxPerDay: number;
	maxDurationSec: number;
	model?: string;
}

export type TikTokFetchOutcome =
	| { ok: true; result: TikTokFetchResult }
	| { ok: false; error: TikTokFetchError };

/** Hard cap on transcript length passed to the LLM. Full transcript stays
 *  in the structured result for any caller that needs the raw bytes. */
export const TRANSCRIPT_MAX_CHARS = 12_000;

/** Per-process capability probe result. Cached at module load and refreshed
 *  on demand. The orchestrator startup uses this to drop the `tiktokFetch`
 *  tool entirely when the host can't run it. */
export interface TikTokCapabilities {
	ytDlp: boolean;
	ffmpeg: boolean;
	whisperCli: boolean;
	whisperModelEn: string | null;
	whisperModelAr: string | null;
	curlCffi: boolean;
	/** True iff at least Tier A (metadata) is available — yt-dlp + ffmpeg.
	 *  When false, the tool is dropped from the orchestrator entirely. */
	tierAReady: boolean;
	/** True iff Tier B (whisper transcription) is available. */
	tierBReady: boolean;
}
