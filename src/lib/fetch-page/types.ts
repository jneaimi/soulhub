/**
 * fetchPage tool types. See ADR 2026-05-11-fetch-page-tool for the
 * canonical contract.
 *
 * The result shape is deliberately small — title + readable text + minimal
 * metadata. Anything richer (transcript-specific fields, structured Q&A,
 * etc.) belongs in specialty tools (youtubeFetch / tiktokFetch / future
 * MIME-specific extractors), NOT here.
 */

/** Why a fetch didn't produce usable text. NULL on the result when the
 *  fetch succeeded and the content is real. The instrumented `fetch_log`
 *  rows carry these values so we can decide later whether to escalate to
 *  Stagehand (see ADR §D5 + §Resurface trigger). */
export type FailureClass =
	| 'empty-content'      // 200 OK but Readability extracted <200 chars
	| 'js-required'        // empty-content AND HTML has SPA markers (noscript, root divs)
	| 'auth-required'      // title or HTTP signals an auth wall
	| 'bot-blocked'        // Cloudflare/Akamai/PerimeterX/Datadome challenge
	| 'unsupported-mime'   // response Content-Type is not text/html
	| 'too-many-redirects' // exceeded the 5-hop redirect ceiling
	| 'unsafe-url'         // isSafeUrl rejected the URL (or a redirect target)
	| 'timeout'            // 8s ceiling exceeded
	| 'fetch-error'        // network error / DNS failure / response-too-large / etc.
	| 'sanitizer-stripped';// instruction-injection patterns detected and redacted

export interface FetchPageResult {
	/** The URL the caller asked for. */
	url: string;
	/** The final URL after any redirects. Equal to `url` when no redirects. */
	finalUrl: string;
	/** HTTP status of the final response. 0 when the request never completed. */
	httpStatus: number;
	/** Page title from Readability or the document `<title>`. NULL when unknown. */
	title: string | null;
	/** Author byline if Readability detected one. */
	byline: string | null;
	/** Readability `lang` attribute or `<html lang="…">`. */
	lang: string | null;
	/** Readability's article text content. Capped at 12k chars. EMPTY on failure. */
	text: string;
	/** Pre-cap text length — useful for failure classification + log queries. */
	length: number;
	/** Reason the fetch didn't produce usable text. NULL on clean success. */
	failureClass: FailureClass | null;
	/** Free-form short error message attached to the failure (for the log). */
	error: string | null;
}

export interface FetchPageOptions {
	/** Hard ceiling on extracted text length. Defaults to 12 000 chars. */
	maxChars?: number;
	/** Override the 8-second fetch timeout. */
	timeoutMs?: number;
}
