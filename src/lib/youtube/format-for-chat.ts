/**
 * Chat-ready formatter for `youtubeFetch` results (ADR-030).
 *
 * Used by `runSkillInBackground` to render the structured tool result
 * as plain WhatsApp text when the slow-dispatch worker completes. The
 * inline path lets the LLM compose the reply; the slow path bypasses
 * the LLM and ships this output verbatim into the chat bubble.
 */

/** Structural shape — mirrors the youtube/youtube-error variants of
 *  `ToolResult` (orchestrator-v2/tools/index.ts). Kept local to avoid a
 *  circular import from the youtube module back into orchestrator-v2. */
interface YoutubeSuccess {
	kind: 'youtube';
	url: string;
	title: string;
	channel: string;
	durationSec?: number;
	summary?: string;
	transcript?: string;
	note?: string;
}
interface YoutubeError {
	kind: 'youtube-error';
	url: string;
	error: string;
	tier: 'oembed' | 'gemini' | 'url';
}
type YoutubeShape = YoutubeSuccess | YoutubeError;

const TRANSCRIPT_PREVIEW_CHARS = 1200;

export function formatYoutubeForChat(result: unknown): string {
	if (!result || typeof result !== 'object' || !('kind' in result)) {
		return '⚠️ YouTube fetch returned an unexpected shape.';
	}
	const r = result as YoutubeShape;
	if (r.kind === 'youtube-error') {
		return formatError(r);
	}
	if (r.kind !== 'youtube') {
		return '⚠️ YouTube fetch returned an unexpected shape.';
	}

	const lines: string[] = [];
	lines.push(`🎬 *${escapeMd(r.title)}*`);
	const subtitle: string[] = [];
	if (r.channel) subtitle.push(r.channel);
	if (r.durationSec) subtitle.push(formatDuration(r.durationSec));
	if (subtitle.length > 0) lines.push(`_${subtitle.join(' · ')}_`);

	if (r.summary) {
		lines.push('');
		lines.push(r.summary.trim());
	}

	if (r.transcript) {
		lines.push('');
		const t = r.transcript.trim();
		const preview = t.length > TRANSCRIPT_PREVIEW_CHARS
			? t.slice(0, TRANSCRIPT_PREVIEW_CHARS) + '\n…(transcript truncated)'
			: t;
		lines.push('📝 *Transcript*');
		lines.push(preview);
	}

	// Caveats — note field surfaces honest failures of Tier B (Gemini).
	if (r.note === 'transcript-quota-exceeded') {
		lines.push('');
		lines.push(
			'_(Daily YouTube transcript cap hit — title and link only this turn. Cap resets at midnight Dubai time.)_',
		);
	} else if (r.note === 'gemini-failed') {
		lines.push('');
		lines.push(
			'_(Gemini couldn\'t analyze the video this turn — title and link only.)_',
		);
	} else if (r.note === 'gemini-not-configured' || r.note === 'transcript-disabled') {
		lines.push('');
		lines.push(
			'_(Transcript/summary disabled in settings — title and link only.)_',
		);
	}

	lines.push('');
	lines.push(`🔗 ${r.url}`);

	return lines.join('\n');
}

function formatError(r: YoutubeError): string {
	const tierLabel =
		r.tier === 'url'
			? "couldn't parse that as a YouTube URL"
			: r.tier === 'oembed'
				? "couldn't fetch the video metadata"
				: 'video transcript fetch failed';
	return `⚠️ ${tierLabel}.\n${escapeMd(r.error)}\n\n🔗 ${r.url}`;
}

function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return '';
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
	return `${s}s`;
}

function escapeMd(text: string): string {
	// WhatsApp uses a light Markdown dialect: * for bold, _ for italics,
	// ~ for strike, ` for code. We don't escape — most YouTube titles are
	// fine — but trim and collapse whitespace for cleanliness.
	return text.replace(/\s+/g, ' ').trim();
}

// Re-export for the runSkillInBackground closure that doesn't know the
// concrete shape but needs the formatter typed against `unknown`.
export const formatYoutubeForChatAsUnknown: (r: unknown) => string = formatYoutubeForChat;
