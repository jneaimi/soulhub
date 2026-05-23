/**
 * Chat-ready formatter for `tiktokFetch` results (ADR-030 v2).
 *
 * Mirror of `src/lib/youtube/format-for-chat.ts`. Used by
 * `runSkillInBackground` to render the structured tool result as plain
 * WhatsApp text when the slow-dispatch worker completes. The inline path
 * lets the LLM compose the reply; the slow path bypasses the LLM and
 * ships this output verbatim into the chat bubble.
 */

/** Structural shape — mirrors the tiktok/tiktok-error variants of
 *  `ToolResult` (orchestrator-v2/tools/index.ts). Kept local to avoid a
 *  circular import from the tiktok module back into orchestrator-v2. */
interface TiktokSuccess {
	kind: 'tiktok';
	url: string;
	author: string;
	authorHandle: string;
	caption: string;
	title?: string;
	durationSec: number;
	views?: number;
	likes?: number;
	comments?: number;
	reposts?: number;
	isPhotoPost: boolean;
	transcript?: string;
	transcriptLang?: string;
	summary?: string;
	note?: string;
}
interface TiktokError {
	kind: 'tiktok-error';
	url: string;
	error: string;
	tier: 'url' | 'metadata' | 'download' | 'whisper' | 'gemini';
}
type TiktokShape = TiktokSuccess | TiktokError;

const TRANSCRIPT_PREVIEW_CHARS = 1200;
const SUMMARY_PREVIEW_CHARS = 800;
const CAPTION_HEADER_CHARS = 140;

export function formatTiktokForChat(result: unknown): string {
	if (!result || typeof result !== 'object' || !('kind' in result)) {
		return '⚠️ TikTok fetch returned an unexpected shape.';
	}
	const r = result as TiktokShape;
	if (r.kind === 'tiktok-error') {
		return formatError(r);
	}
	if (r.kind !== 'tiktok') {
		return '⚠️ TikTok fetch returned an unexpected shape.';
	}

	const lines: string[] = [];

	// Header: prefer caption (truncated) over title — TikTok captions
	// double as the post's headline. Fall back to title, then to a
	// generic "TikTok by @handle" when the post has neither.
	const headline = pickHeadline(r);
	const handle = r.authorHandle ? `@${r.authorHandle}` : r.author;
	lines.push(`🎵 *${escapeMd(handle)}*`);
	if (headline) lines.push(escapeMd(headline));

	const subtitle: string[] = [];
	if (r.durationSec > 0) subtitle.push(formatDuration(r.durationSec));
	const engagement = formatEngagement(r);
	if (engagement) subtitle.push(engagement);
	if (subtitle.length > 0) lines.push(`_${subtitle.join(' · ')}_`);

	if (r.summary) {
		lines.push('');
		const s = r.summary.trim();
		lines.push(
			s.length > SUMMARY_PREVIEW_CHARS
				? s.slice(0, SUMMARY_PREVIEW_CHARS) + '\n…(summary truncated)'
				: s,
		);
	}

	if (r.transcript) {
		lines.push('');
		const t = r.transcript.trim();
		const preview =
			t.length > TRANSCRIPT_PREVIEW_CHARS
				? t.slice(0, TRANSCRIPT_PREVIEW_CHARS) + '\n…(transcript truncated)'
				: t;
		const langSuffix = r.transcriptLang ? ` (${r.transcriptLang})` : '';
		lines.push(`📝 *Transcript${langSuffix}*`);
		lines.push(preview);
	}

	// Caveats — note field surfaces honest failures of Tier B (whisper) /
	// Tier C (Gemini) and structural facts about the post.
	const caveat = formatCaveat(r);
	if (caveat) {
		lines.push('');
		lines.push(caveat);
	}

	lines.push('');
	lines.push(`🔗 ${r.url}`);

	return lines.join('\n');
}

function pickHeadline(r: TiktokSuccess): string {
	const caption = (r.caption ?? '').trim();
	if (caption) {
		return caption.length > CAPTION_HEADER_CHARS
			? caption.slice(0, CAPTION_HEADER_CHARS) + '…'
			: caption;
	}
	if (r.title) return r.title.trim();
	return '';
}

function formatEngagement(r: TiktokSuccess): string {
	const parts: string[] = [];
	if (typeof r.views === 'number' && r.views > 0)
		parts.push(`${compactNumber(r.views)} views`);
	if (typeof r.likes === 'number' && r.likes > 0)
		parts.push(`${compactNumber(r.likes)} likes`);
	return parts.join(' · ');
}

function formatCaveat(r: TiktokSuccess): string {
	switch (r.note) {
		case 'tiktok-rate-limited':
			return "_(TikTok's anti-bot is blocking us right now — partial info only. Try again in a minute or two.)_";
		case 'summary-quota-exceeded':
			return '_(Daily TikTok summary cap hit — transcript/metadata only this turn. Cap resets at midnight Dubai time.)_';
		case 'whisper-failed':
			return "_(Couldn't transcribe the audio this turn — metadata only.)_";
		case 'whisper-not-installed':
			return '_(Local transcription not available — install whisper.cpp via `npm run setup -- --with-tiktok`.)_';
		case 'gemini-failed':
			return "_(Gemini couldn't summarize this turn — transcript and metadata only.)_";
		case 'gemini-not-configured':
			return '_(Summarization disabled — set `GEMINI_API_KEY` to enable.)_';
		case 'transcript-disabled':
			return '_(Transcript/summary disabled in settings — metadata only.)_';
		case 'duration-cap-exceeded':
			return "_(Clip too long to transcribe — caption only.)_";
		case 'photo-post-no-audio':
			return "_(This is a photo carousel — no spoken audio to transcribe.)_";
		default:
			return '';
	}
}

function formatError(r: TiktokError): string {
	const tierLabel =
		r.tier === 'url'
			? "couldn't parse that as a TikTok URL"
			: r.tier === 'metadata'
				? "couldn't fetch the video info"
				: r.tier === 'download'
					? "couldn't download the audio"
					: r.tier === 'whisper'
						? 'audio transcription failed'
						: 'summarization failed';
	return `⚠️ ${tierLabel}.\n${escapeMd(r.error)}\n\n🔗 ${r.url}`;
}

function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '';
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
	return `${s}s`;
}

function compactNumber(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
	if (n < 1_000_000_000)
		return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '') + 'M';
	return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
}

function escapeMd(text: string): string {
	// WhatsApp uses a light Markdown dialect: * for bold, _ for italics,
	// ~ for strike, ` for code. Captions occasionally carry stray *_~
	// characters but escaping them tends to look worse than leaving them
	// alone. Just trim and collapse whitespace.
	return text.replace(/\s+/g, ' ').trim();
}

// Re-export for the runSkillInBackground closure that doesn't know the
// concrete shape but needs the formatter typed against `unknown`.
export const formatTiktokForChatAsUnknown: (r: unknown) => string = formatTiktokForChat;
