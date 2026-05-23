/**
 * URL canonicalization for TikTok URLs and share links (ADR-024).
 *
 * Inputs we accept (all produce `{ videoId, watchUrl, isPhotoPost, authorHandle? }`):
 *   - https://www.tiktok.com/@user/video/<id>             (canonical)
 *   - https://www.tiktok.com/@user/video/<id>?_d=...      (iOS share form — strip params)
 *   - https://m.tiktok.com/v/<id>.html                    (mobile)
 *   - https://www.tiktok.com/@user/photo/<id>             (photo carousel — no audio)
 *   - https://vm.tiktok.com/<short>/                      (HEAD-follow → canonical)
 *   - https://vt.tiktok.com/<short>/                      (HEAD-follow → canonical)
 *   - https://www.tiktok.com/t/<short>/                   (HEAD-follow → canonical)
 *   - https://vxtiktok.com/@user/video/<id>               (mirror — rewrite host)
 *   - https://tnktok.com/@user/video/<id>                 (mirror — rewrite host)
 *
 * Validation 2026-05-10: yt-dlp REJECTS the iOS share-form URL with all
 * params attached ("Unexpected response from webpage request"). Stripping
 * the query string before passing to yt-dlp is mandatory.
 */

/** TikTok video IDs are 15-25 digits (current range as of 2026; older clips
 *  are 18-19 digits, recent ones 19-20). Loose-bound so a future change in
 *  TikTok's snowflake doesn't bite us. */
const TIKTOK_ID_REGEX = /^\d{15,25}$/;

/** Hosts we consider "TikTok proper" — vxtiktok.com et al are rewritten. */
const TIKTOK_HOSTS = new Set([
	'tiktok.com',
	'm.tiktok.com',
	'www.tiktok.com',
]);

/** Privacy/embed mirrors — same path shape, host rewritten to tiktok.com. */
const TIKTOK_MIRROR_HOSTS = new Set([
	'vxtiktok.com',
	'tnktok.com',
	'tiktxk.com',
	'tfxktok.com',
]);

/** Short-link hosts — body is an opaque token, must HEAD-follow. */
const TIKTOK_SHORTLINK_HOSTS = new Set([
	'vm.tiktok.com',
	'vt.tiktok.com',
]);

export interface CanonicalTikTokUrl {
	videoId: string;
	/** Clean canonical URL — used for display, cache key, vault save. */
	watchUrl: string;
	/** URL to pass to yt-dlp. Preserves `_t` and `_r` query params from the
	 *  source URL when present — these are TikTok's session/share tokens,
	 *  NOT tracking. yt-dlp without them gets served the JS-challenge page
	 *  ("Unexpected response from webpage request" / "Unable to extract
	 *  universal data for rehydration"). With them present TikTok treats the
	 *  request as a legitimate share open and returns the video page.
	 *  Validated A/B 2026-05-10. */
	fetchUrl: string;
	authorHandle?: string;
	isPhotoPost: boolean;
}

export class UrlCanonicalizationError extends Error {
	constructor(
		message: string,
		readonly url: string,
	) {
		super(message);
		this.name = 'UrlCanonicalizationError';
	}
}

/** Canonicalize any TikTok-shaped URL. Throws `UrlCanonicalizationError`
 *  when the input doesn't resolve. Follows short-link redirects with one
 *  HEAD request — does not recurse beyond one redirect to keep the failure
 *  surface bounded. */
export async function canonicalizeTikTokUrl(input: string): Promise<CanonicalTikTokUrl> {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new UrlCanonicalizationError('empty url', input);
	}

	const direct = extractFromUrl(trimmed);
	if (direct) return direct;

	const url = safeParseUrl(trimmed);
	if (!url) {
		throw new UrlCanonicalizationError('not a parseable url', input);
	}

	const host = url.hostname.replace(/^www\./, '').toLowerCase();
	if (TIKTOK_SHORTLINK_HOSTS.has(host) || (host === 'tiktok.com' && url.pathname.startsWith('/t/'))) {
		const finalUrl = await followRedirect(trimmed);
		const fromFinal = extractFromUrl(finalUrl);
		if (fromFinal) return fromFinal;
		throw new UrlCanonicalizationError(
			`shortlink redirected to a non-TikTok URL: ${finalUrl.slice(0, 200)}`,
			input,
		);
	}

	throw new UrlCanonicalizationError(
		`url does not match any known TikTok shape: ${trimmed.slice(0, 200)}`,
		input,
	);
}

/** Pure-sync extractor — public for tests. Returns the canonical descriptor
 *  or null when no shape matches. Does not follow redirects. */
export function extractFromUrl(input: string): CanonicalTikTokUrl | null {
	const url = safeParseUrl(input);
	if (!url) return null;

	let host = url.hostname.replace(/^www\./, '').toLowerCase();

	// Rewrite mirrors before further checks.
	if (TIKTOK_MIRROR_HOSTS.has(host)) {
		host = 'tiktok.com';
	}

	if (!TIKTOK_HOSTS.has(host) && host !== 'tiktok.com') {
		return null;
	}

	const segments = url.pathname.split('/').filter(Boolean);

	// Pattern 1: /@<handle>/video/<id> or /@<handle>/photo/<id>
	if (segments.length >= 3 && segments[0].startsWith('@')) {
		const [handleSeg, kind, id] = segments;
		if ((kind === 'video' || kind === 'photo') && TIKTOK_ID_REGEX.test(id)) {
			const handle = handleSeg.slice(1);
			const isPhotoPost = kind === 'photo';
			const watchUrl = `https://www.tiktok.com/@${handle}/${kind}/${id}`;
			return {
				videoId: id,
				watchUrl,
				fetchUrl: appendShareTokens(watchUrl, url),
				authorHandle: handle,
				isPhotoPost,
			};
		}
	}

	// Pattern 2: /v/<id>.html  (m.tiktok.com legacy)
	if (segments.length === 2 && segments[0] === 'v') {
		const id = segments[1].replace(/\.html$/, '');
		if (TIKTOK_ID_REGEX.test(id)) {
			const watchUrl = `https://www.tiktok.com/video/${id}`;
			return {
				videoId: id,
				watchUrl,
				fetchUrl: appendShareTokens(watchUrl, url),
				isPhotoPost: false,
			};
		}
	}

	// Pattern 3: /video/<id> (handle-less direct embed)
	if (segments.length === 2 && segments[0] === 'video') {
		const id = segments[1];
		if (TIKTOK_ID_REGEX.test(id)) {
			const watchUrl = `https://www.tiktok.com/video/${id}`;
			return {
				videoId: id,
				watchUrl,
				fetchUrl: appendShareTokens(watchUrl, url),
				isPhotoPost: false,
			};
		}
	}

	return null;
}

/** Build the URL to send to yt-dlp. Preserves `_t` (TikTok share session
 *  token) and `_r` (TikTok routing flag) from the source URL when present.
 *  Validated A/B 2026-05-10: `?_t=<token>` is the difference between yt-dlp
 *  succeeding and yt-dlp getting the JS-challenge page. */
function appendShareTokens(cleanUrl: string, sourceUrl: URL): string {
	const params = new URLSearchParams();
	const t = sourceUrl.searchParams.get('_t');
	const r = sourceUrl.searchParams.get('_r');
	if (r) params.set('_r', r);
	if (t) params.set('_t', t);
	const qs = params.toString();
	return qs ? `${cleanUrl}?${qs}` : cleanUrl;
}

function safeParseUrl(input: string): URL | null {
	try {
		return new URL(input);
	} catch {
		return null;
	}
}

/** Follow a TikTok short-link redirect with a 5s timeout. Reads the final
 *  URL from `res.url` (fetch follows by default) and parses it. We GET (not
 *  HEAD) because some TikTok short-links serve HTML+JS redirects rather
 *  than 30x responses. */
async function followRedirect(url: string): Promise<string> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 5_000);
	try {
		const res = await fetch(url, {
			method: 'GET',
			redirect: 'follow',
			signal: ac.signal,
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			},
		});
		const finalUrl = res.url;
		// res.url already canonical? Done.
		if (extractFromUrl(finalUrl)) return finalUrl;
		// Otherwise the redirect was meta-refresh / JS — read up to 32KB and
		// pull the first TikTok URL we find.
		const reader = res.body?.getReader();
		if (!reader) return finalUrl;
		const chunks: Uint8Array[] = [];
		let total = 0;
		const MAX_BYTES = 32_768;
		while (total < MAX_BYTES) {
			const { value, done } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.length;
		}
		void reader.cancel();
		const html = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
		const match = html.match(/https?:\/\/(?:www\.|m\.)?tiktok\.com\/(?:@[^"'\/\s]+\/(?:video|photo)\/\d{15,25}|video\/\d{15,25}|v\/\d{15,25}\.html)/);
		return match ? match[0] : finalUrl;
	} finally {
		clearTimeout(timer);
	}
}
