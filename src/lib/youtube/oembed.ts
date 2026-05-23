/**
 * Tier A — YouTube oEmbed metadata fetch.
 *
 * `https://www.youtube.com/oembed?url=...&format=json` is a public, versioned
 * endpoint. Validation 2026-05-07: ~150ms, returns title, author_name,
 * thumbnail_url, html-embed. No API key, no quota. Does NOT return duration
 * or description — those are deferred to Gemini in Tier B if needed.
 */

import type { YoutubeMetadata } from './types.js';

interface OembedResponse {
	title?: string;
	author_name?: string;
	thumbnail_url?: string;
}

const TIMEOUT_MS = 8_000;

export async function fetchOembedMetadata(watchUrl: string): Promise<YoutubeMetadata> {
	const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

	let json: OembedResponse;
	try {
		const res = await fetch(endpoint, {
			headers: { Accept: 'application/json' },
			signal: ac.signal,
		});
		if (!res.ok) {
			throw new Error(`oEmbed responded ${res.status}: ${(await res.text()).slice(0, 120)}`);
		}
		json = (await res.json()) as OembedResponse;
	} finally {
		clearTimeout(timer);
	}

	if (!json.title || !json.author_name) {
		throw new Error(`oEmbed response missing required fields: ${JSON.stringify(json).slice(0, 120)}`);
	}

	return {
		title: json.title,
		channel: json.author_name,
		thumbnailUrl: json.thumbnail_url ?? '',
	};
}
