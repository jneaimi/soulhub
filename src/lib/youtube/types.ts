/**
 * YouTube fetch — public types.
 *
 * Two-tier architecture per ADR-012:
 *   - Tier A (oEmbed) — metadata only, free, ~150ms.
 *   - Tier B (Gemini multimodal) — transcript / summary, ~10-25s, capped per-day.
 *
 * Validation backing: knowledge/research/2026-05-07-youtube-fetch-options.md
 * (free transcript paths from server IPs are rate-limited, so Gemini is the
 * only honest path for non-cookie-bound transcript fetches).
 */

export type YoutubeFetchMode = 'metadata' | 'summary' | 'transcript' | 'full';

export interface YoutubeMetadata {
	title: string;
	channel: string;
	thumbnailUrl: string;
	durationSec?: number;
	description?: string;
}

export interface YoutubeFetchResult {
	url: string;
	videoId: string;
	metadata: YoutubeMetadata;
	/** Present when mode includes summary. 2-3 paragraph plain-text summary. */
	summary?: string;
	/** Present when mode includes transcript. Truncated to TRANSCRIPT_MAX_CHARS
	 *  before being handed to the LLM; full transcript stays available here
	 *  for any downstream consumer that needs it. */
	transcript?: string;
	transcriptSource: 'gemini' | 'none';
	/** Gemini turn cost when Tier B fired. Undefined when only Tier A ran. */
	costUsd?: number;
	/** Set when Tier B was skipped or failed but Tier A still produced a
	 *  result. Surfaces a hint to the LLM so it can tell the user. */
	note?: 'transcript-quota-exceeded' | 'transcript-disabled' | 'gemini-failed' | 'gemini-not-configured';
}

export interface YoutubeFetchError {
	url: string;
	videoId?: string;
	tier: 'oembed' | 'gemini' | 'url';
	error: string;
}

/** Subset of `cfg.youtube` that the orchestrator needs. Decoupled from the
 *  full settings shape so tests can construct it without loading config.
 *  Mirrors `ImgConfigSlice`. */
export interface YoutubeConfigSlice {
	enabled: boolean;
	maxPerDay: number;
	model?: string;
}

export type YoutubeFetchOutcome =
	| { ok: true; result: YoutubeFetchResult }
	| { ok: false; error: YoutubeFetchError };

/** Hard cap on transcript length passed to the LLM. Full transcript stays
 *  in the structured result for any caller that needs the raw bytes. */
export const TRANSCRIPT_MAX_CHARS = 12_000;
