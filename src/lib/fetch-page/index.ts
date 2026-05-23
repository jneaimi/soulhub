/**
 * fetchPage — generic URL fetcher with Readability extraction.
 *
 * See ADR 2026-05-11-fetch-page-tool. Tier-A only: curl + @mozilla/readability
 * + linkedom. No browser, no JS execution, no auth handling.
 *
 * The function always RESOLVES — never throws on remote failures, network
 * errors, or unsafe URLs. Failures are surfaced via `failureClass` + `error`
 * on the result so callers (and the LLM) can compose a sensible reply.
 *
 * Per-call lifecycle:
 *   1. isSafeUrl(input)                       — SSRF guard, throws → caught → result
 *   2. fetch with redirect: 'manual'          — re-validate each hop, max 5
 *   3. stripDangerousTags(html)               — pre-parse safety
 *   4. parseHTML(html) → Readability.parse()  — extract article
 *   5. sanitizeText(article.textContent)      — post-parse safety + injection scan
 *   6. classifyFailure(...)                   — set failureClass when content is unusable
 *   7. recordFetch(...)                       — append to fetch_log
 *   8. return FetchPageResult
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { isSafeUrl, UnsafeUrlError } from './safety.js';
import { stripDangerousTags, sanitizeText } from './sanitize.js';
import { classifyFailure, recordFetch } from './db.js';
import type { FetchPageOptions, FetchPageResult, FailureClass } from './types.js';
import { userAgent } from '../branding.js';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_REDIRECT_HOPS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB hard cap
// User-Agent is built per-call via userAgent() (ADR-055 branding helper) so it
// reflects the operator's configured domain, not a hardcoded one.

export async function fetchPage(
	rawUrl: string,
	opts: FetchPageOptions = {},
): Promise<FetchPageResult> {
	const startedAt = Date.now();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

	const emptyResult = (failureClass: FailureClass, error: string, finalUrl = rawUrl, httpStatus = 0): FetchPageResult => ({
		url: rawUrl,
		finalUrl,
		httpStatus,
		title: null,
		byline: null,
		lang: null,
		text: '',
		length: 0,
		failureClass,
		error,
	});

	// Hostname for log rows — parsed once; falls back to '?' if unparseable.
	let initialHost = '?';
	try {
		initialHost = new URL(rawUrl).hostname.toLowerCase();
	} catch {
		// Will fail in isSafeUrl below.
	}

	// Stage 1: SSRF guard on the initial URL.
	try {
		await isSafeUrl(rawUrl);
	} catch (err) {
		const result = emptyResult('unsafe-url', (err as UnsafeUrlError).message);
		recordFetch({
			url: rawUrl, host: initialHost, httpStatus: null, contentLength: null,
			latencyMs: Date.now() - startedAt, failureClass: 'unsafe-url', error: result.error,
		});
		return result;
	}

	// Stage 2: manual redirect chain — re-validate each hop.
	let currentUrl = rawUrl;
	let response: Response | null = null;
	let hops = 0;
	const ac = new AbortController();
	const timeoutHandle = setTimeout(() => ac.abort(), timeoutMs);

	try {
		while (true) {
			let res: Response;
			try {
				res = await fetch(currentUrl, {
					signal: ac.signal,
					redirect: 'manual',
					headers: {
						'User-Agent': userAgent(),
						'Accept': 'text/html,application/xhtml+xml',
						'Accept-Language': 'en-US,en;q=0.9',
					},
				});
			} catch (err) {
				const isTimeout = (err as Error).name === 'AbortError';
				const failureClass: FailureClass = isTimeout ? 'timeout' : 'fetch-error';
				const errMessage = isTimeout ? `timeout after ${timeoutMs}ms` : (err as Error).message;
				const result = emptyResult(failureClass, errMessage, currentUrl);
				recordFetch({
					url: rawUrl, host: initialHost, httpStatus: null, contentLength: null,
					latencyMs: Date.now() - startedAt, failureClass, error: errMessage,
				});
				return result;
			}

			// Redirect? Follow manually, but re-validate.
			if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
				hops += 1;
				if (hops > MAX_REDIRECT_HOPS) {
					const result = emptyResult('too-many-redirects', `>${MAX_REDIRECT_HOPS} redirect hops`, currentUrl, res.status);
					recordFetch({
						url: rawUrl, host: initialHost, httpStatus: res.status, contentLength: null,
						latencyMs: Date.now() - startedAt, failureClass: 'too-many-redirects', error: result.error,
					});
					return result;
				}
				const nextUrl = new URL(res.headers.get('location')!, currentUrl).toString();
				try {
					await isSafeUrl(nextUrl);
				} catch (err) {
					const result = emptyResult('unsafe-url', (err as UnsafeUrlError).message, currentUrl, res.status);
					recordFetch({
						url: rawUrl, host: initialHost, httpStatus: res.status, contentLength: null,
						latencyMs: Date.now() - startedAt, failureClass: 'unsafe-url', error: result.error,
					});
					return result;
				}
				currentUrl = nextUrl;
				continue;
			}

			response = res;
			break;
		}
	} finally {
		clearTimeout(timeoutHandle);
	}

	const finalUrl = currentUrl;
	const finalHost = (() => { try { return new URL(finalUrl).hostname.toLowerCase(); } catch { return initialHost; } })();
	const httpStatus = response.status;
	const contentType = response.headers.get('content-type');

	// Non-2xx with a body — still read for failure classification.
	let html = '';
	let oversized = false;
	try {
		// Read with a size cap. Node's fetch streams the body; we cap manually.
		const reader = response.body?.getReader();
		if (!reader) {
			html = await response.text();
		} else {
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > MAX_RESPONSE_BYTES) {
					oversized = true;
					break;
				}
				chunks.push(value);
			}
			const merged = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.byteLength;
			}
			html = new TextDecoder('utf-8', { fatal: false }).decode(merged);
		}
	} catch (err) {
		const result = emptyResult('fetch-error', `body read failed: ${(err as Error).message}`, finalUrl, httpStatus);
		recordFetch({
			url: rawUrl, host: finalHost, httpStatus, contentLength: null,
			latencyMs: Date.now() - startedAt, failureClass: 'fetch-error', error: result.error,
		});
		return result;
	}

	if (oversized) {
		const result = emptyResult('fetch-error', `response exceeded ${MAX_RESPONSE_BYTES} byte cap`, finalUrl, httpStatus);
		recordFetch({
			url: rawUrl, host: finalHost, httpStatus, contentLength: null,
			latencyMs: Date.now() - startedAt, failureClass: 'fetch-error', error: result.error,
		});
		return result;
	}

	// Stage 3: pre-parse strip.
	const safeHtml = stripDangerousTags(html);

	// Stage 4: linkedom + Readability.
	let parsedTitle: string | null = null;
	let parsedByline: string | null = null;
	let parsedLang: string | null = null;
	let extractedText = '';
	try {
		const { document } = parseHTML(safeHtml);
		// Pull <html lang="…"> as a fallback before Readability claims it.
		parsedLang = document.documentElement?.getAttribute('lang') ?? null;
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();
		if (article) {
			parsedTitle = article.title?.trim() || null;
			parsedByline = article.byline?.trim() || null;
			parsedLang = article.lang?.trim() || parsedLang;
			extractedText = (article.textContent || '').trim();
		}
	} catch (err) {
		const result = emptyResult('fetch-error', `parse failed: ${(err as Error).message}`, finalUrl, httpStatus);
		recordFetch({
			url: rawUrl, host: finalHost, httpStatus, contentLength: html.length,
			latencyMs: Date.now() - startedAt, failureClass: 'fetch-error', error: result.error,
		});
		return result;
	}

	// Stage 5: sanitize text (post-Readability).
	const { text: sanitizedText, hadInjectionPattern } = sanitizeText(extractedText);
	const cappedText = sanitizedText.slice(0, maxChars);

	// Stage 6: classify the outcome. `sanitizer-stripped` is the only class
	// that doesn't come from `classifyFailure`.
	let failureClass = classifyFailure({
		httpStatus,
		contentType,
		rawHtml: html,
		extractedLength: cappedText.length,
		title: parsedTitle,
	});
	if (failureClass === null && hadInjectionPattern) {
		// Content is otherwise OK but we redacted instruction-like text — log
		// it so the trend is visible without breaking the user reply.
		failureClass = 'sanitizer-stripped';
	}

	recordFetch({
		url: rawUrl,
		host: finalHost,
		httpStatus,
		contentLength: cappedText.length,
		latencyMs: Date.now() - startedAt,
		failureClass,
		error: null,
	});

	return {
		url: rawUrl,
		finalUrl,
		httpStatus,
		title: parsedTitle,
		byline: parsedByline,
		lang: parsedLang,
		text: cappedText,
		length: cappedText.length,
		failureClass,
		error: null,
	};
}

export { isSafeUrl, UnsafeUrlError } from './safety.js';
export { stripDangerousTags, sanitizeText } from './sanitize.js';
export { getFetchPageDb, closeFetchPageDb, recordFetch, classifyFailure } from './db.js';
export type { FetchPageResult, FetchPageOptions, FailureClass } from './types.js';
