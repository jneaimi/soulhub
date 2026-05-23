/**
 * URL canonicalization for YouTube and YouTube share links.
 *
 * Inputs we accept (all produce { videoId, watchUrl }):
 *   - https://www.youtube.com/watch?v=ID
 *   - https://youtube.com/watch?v=ID
 *   - https://m.youtube.com/watch?v=ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://www.youtube.com/embed/ID
 *   - https://www.youtube.com/live/ID
 *   - https://youtu.be/ID
 *   - https://share.google/<token>  (HEAD-follow → final URL → recurse)
 *
 *  Validation 2026-05-07: share.google/GmAM7snwX2flefPNB resolves to
 *  https://www.youtube.com/watch?v=_HsZzkSYao0&shem=... — we strip the
 *  noise params back to a clean watch URL.
 */

const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export interface CanonicalUrl {
	videoId: string;
	watchUrl: string;
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

/** Canonicalize any YouTube-shaped URL to `{ videoId, watchUrl }`. Throws
 *  `UrlCanonicalizationError` when the input doesn't resolve to a YouTube
 *  video. Follows share.google redirects with one HEAD request — does not
 *  recurse beyond one redirect to keep the failure surface bounded. */
export async function canonicalizeYoutubeUrl(input: string): Promise<CanonicalUrl> {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new UrlCanonicalizationError('empty url', input);
	}

	// First pass — try direct extraction.
	const direct = extractIdFromUrl(trimmed);
	if (direct) {
		return makeCanonical(direct);
	}

	// share.google + youtu.be already-handled by extractIdFromUrl, so the
	// only remaining redirect case is share.google/<token> when the host
	// matches but the token didn't already encode the video.
	const url = safeParseUrl(trimmed);
	if (!url) {
		throw new UrlCanonicalizationError('not a parseable url', input);
	}

	if (url.hostname === 'share.google' || url.hostname === 'www.share.google') {
		const finalUrl = await followRedirect(trimmed);
		const fromFinal = extractIdFromUrl(finalUrl);
		if (fromFinal) {
			return makeCanonical(fromFinal);
		}
		throw new UrlCanonicalizationError(
			`share.google redirected to a non-YouTube URL: ${finalUrl.slice(0, 200)}`,
			input,
		);
	}

	throw new UrlCanonicalizationError(
		`url does not match any known YouTube shape: ${trimmed.slice(0, 200)}`,
		input,
	);
}

/** Pure-sync extractor — public for tests. Returns the 11-char video id or
 *  null when no shape matches. Does not follow redirects. */
export function extractIdFromUrl(input: string): string | null {
	const url = safeParseUrl(input);
	if (!url) return null;

	const host = url.hostname.replace(/^www\./, '').toLowerCase();

	// youtu.be/<id>
	if (host === 'youtu.be') {
		const id = url.pathname.slice(1).split('/')[0];
		return YOUTUBE_ID_REGEX.test(id) ? id : null;
	}

	if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') {
		return null;
	}

	// /watch?v=<id>
	const v = url.searchParams.get('v');
	if (v && YOUTUBE_ID_REGEX.test(v)) return v;

	// /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
	const segments = url.pathname.split('/').filter(Boolean);
	if (segments.length >= 2) {
		const [kind, id] = segments;
		if (
			(kind === 'shorts' || kind === 'embed' || kind === 'live' || kind === 'v') &&
			YOUTUBE_ID_REGEX.test(id)
		) {
			return id;
		}
	}

	return null;
}

function safeParseUrl(input: string): URL | null {
	try {
		return new URL(input);
	} catch {
		return null;
	}
}

function makeCanonical(videoId: string): CanonicalUrl {
	return {
		videoId,
		watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
	};
}

/** Follow share.google redirects with a 5s timeout. The chain is two hops:
 *
 *    share.google/<token>  →  google.com/share.google?q=<token>  →  youtube.com/watch?v=<id>
 *
 *  The second hop is a meta-refresh / JS redirect that only fires on GET
 *  responses, so HEAD bails at the intermediate. We GET the final document
 *  and read `res.url`; if `res.url` is still on google.com (the JS hop
 *  didn't surface in the response chain), we parse the HTML for a youtube
 *  URL. The 32KB byte cap keeps the parse cheap. */
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
		// If the fetch chain resolved to a YouTube URL, we're done.
		const finalUrl = res.url;
		if (extractIdFromUrl(finalUrl)) {
			return finalUrl;
		}
		// Otherwise the second hop is HTML-embedded — read up to 32KB and
		// pull the first YouTube URL we find. No need to parse HTML; a
		// regex over the raw bytes is enough for the share-page payload.
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
		const match = html.match(/https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}/);
		return match ? match[0] : finalUrl;
	} finally {
		clearTimeout(timer);
	}
}
