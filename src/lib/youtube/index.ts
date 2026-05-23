/**
 * YouTube fetch — orchestrates the two tiers per ADR-012.
 *
 *   Tier A (oEmbed)  — always tried; produces metadata.
 *   Tier B (Gemini)  — fired conditionally on `mode`; produces transcript/summary.
 *
 * Public surface: `fetchYoutube(input, opts)` → outcome (Result-shaped union).
 *
 * Why a Result union over throwing: the orchestrator-v2 tool layer wants
 * structured failure metadata (which tier failed, raw error) so the LLM can
 * compose a useful reply ("I couldn't get the transcript but here's the
 * title…"). Throwing forces every caller to a try/catch.
 */

import { canonicalizeYoutubeUrl, UrlCanonicalizationError } from './url.js';
import { fetchOembedMetadata } from './oembed.js';
import { fetchYoutubeViaGemini } from './gemini.js';
import {
	TRANSCRIPT_MAX_CHARS,
	type YoutubeConfigSlice,
	type YoutubeFetchMode,
	type YoutubeFetchOutcome,
	type YoutubeFetchResult,
} from './types.js';

export type {
	YoutubeFetchMode,
	YoutubeFetchOutcome,
	YoutubeFetchResult,
	YoutubeConfigSlice,
} from './types.js';

export interface FetchYoutubeOpts {
	mode: YoutubeFetchMode;
	/** Settings slice — required for transcript/summary modes (controls the
	 *  daily Gemini quota). When omitted or `enabled: false`, Tier B is
	 *  skipped and the result returns metadata-only with a `note` hint. */
	youtubeConfig?: YoutubeConfigSlice;
	/** True when the daily Gemini cap has already been hit for this account.
	 *  Caller is responsible for checking + incrementing — `fetchYoutube`
	 *  doesn't touch the counter store directly so it stays pure. */
	transcriptQuotaExceeded?: boolean;
	signal?: AbortSignal;
}

/** Top-level fetch. Tier A is always attempted; if it fails, the whole
 *  fetch fails (we have nothing to show the user). Tier B is conditional
 *  on `mode` and the quota gate. */
export async function fetchYoutube(
	input: string,
	opts: FetchYoutubeOpts,
): Promise<YoutubeFetchOutcome> {
	// Stage 1 — canonicalize. share.google redirects + URL parsing.
	let canonical: Awaited<ReturnType<typeof canonicalizeYoutubeUrl>>;
	try {
		canonical = await canonicalizeYoutubeUrl(input);
	} catch (err) {
		const msg =
			err instanceof UrlCanonicalizationError
				? err.message
				: (err as Error).message;
		return {
			ok: false,
			error: { url: input, tier: 'url', error: msg },
		};
	}

	// Stage 2 — Tier A oEmbed. Required.
	let oembed;
	try {
		oembed = await fetchOembedMetadata(canonical.watchUrl);
	} catch (err) {
		return {
			ok: false,
			error: {
				url: canonical.watchUrl,
				videoId: canonical.videoId,
				tier: 'oembed',
				error: (err as Error).message,
			},
		};
	}

	const result: YoutubeFetchResult = {
		url: canonical.watchUrl,
		videoId: canonical.videoId,
		metadata: oembed,
		transcriptSource: 'none',
	};

	// Stage 3 — decide whether to fire Tier B.
	if (opts.mode === 'metadata') {
		return { ok: true, result };
	}

	if (!opts.youtubeConfig) {
		result.note = 'gemini-not-configured';
		return { ok: true, result };
	}
	if (!opts.youtubeConfig.enabled) {
		result.note = 'transcript-disabled';
		return { ok: true, result };
	}
	if (opts.transcriptQuotaExceeded) {
		result.note = 'transcript-quota-exceeded';
		return { ok: true, result };
	}

	// Stage 4 — Tier B Gemini. Failures degrade to metadata-only with a hint.
	try {
		const gemini = await fetchYoutubeViaGemini(canonical.watchUrl, opts.mode, {
			model: opts.youtubeConfig.model,
			signal: opts.signal,
		});

		// Merge: Gemini's description / duration enrich the metadata (oEmbed
		// doesn't return either). Summary + transcript become top-level fields.
		if (gemini.durationSec !== undefined) result.metadata.durationSec = gemini.durationSec;
		if (gemini.description) result.metadata.description = gemini.description;
		if (gemini.summary) result.summary = gemini.summary;
		if (gemini.transcript) {
			result.transcript = truncateTranscript(gemini.transcript);
			result.transcriptSource = 'gemini';
		}
		result.costUsd = gemini.costUsd;
		return { ok: true, result };
	} catch (err) {
		// Graceful degrade — Tier A still gave us metadata, we just couldn't
		// transcribe. Surface the failure via `note` so the LLM can tell the
		// user what we have and what's missing.
		console.warn(
			`[youtube] Gemini tier failed for ${canonical.videoId}: ${(err as Error).message}`,
		);
		result.note = 'gemini-failed';
		return { ok: true, result };
	}
}

function truncateTranscript(transcript: string): string {
	if (transcript.length <= TRANSCRIPT_MAX_CHARS) return transcript;
	return transcript.slice(0, TRANSCRIPT_MAX_CHARS) + '\n\n[transcript truncated]';
}
