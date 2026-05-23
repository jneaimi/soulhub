/** Channel-agnostic settle helpers shared by the WhatsApp worker and the
 *  Telegram orchestrator-dispatch path.
 *
 *  Originally lived inside `worker.ts`. Split out 2026-05-10 after the
 *  Telegram path was caught dumping the raw cleaned PTY buffer (banners,
 *  status bar, "Try refactor…" hints) into chat replies for any agent
 *  that produced an artefact (the PDF/scribe regression). Both channels
 *  now flow through `settleBody` so the trailer-aware suppression and
 *  splash/clarification fallbacks behave identically.
 *
 *  Strings are written for chat surfaces in general — `*agentId*` markdown
 *  bold renders on both WhatsApp and Telegram (Markdown / MarkdownV2). */

import type { DispatchResult } from '$lib/agents/dispatch/types.js';
import { cleanAgentOutputForChat, hasChatTrailer } from '$lib/conversation/index.js';

/** Per-message text cap. WhatsApp ~4096, Telegram 4096; 3500 leaves
 *  headroom for both. */
export const REPLY_LIMIT_CHARS = 3_500;

// 2026-05-06: when an agent finishes "successfully" but actually stopped
// to ask for clarification (instead of producing real work), the cleaned
// output is short and contains tell-tale phrases. Detect this and surface
// a friendly retry prompt instead of leaking the half-formed dump.
const CLARIFICATION_PHRASES: RegExp[] = [
	/I\s+need\s+to\s+clarify/i,
	/Let\s+me\s+(?:ask|clarify|check)/i,
	/[Cc]ould\s+you\s+(?:clarify|specify|tell\s+me)/i,
	/[Ww]hat\s+(?:text|content|style|theme|colou?r)\s+would\s+you\s+like/i,
	/[Bb]efore\s+(?:I\s+)?generat(?:e|ing)/i,
	/(?:more|additional)\s+(?:detail|information|context)\s+(?:needed|required)/i,
];

// 2026-05-06: even after the cleaner runs, sometimes the captured output
// is mostly Claude Code splash / paste-buffer / release-note noise that
// got past every individual filter. Detect "agent never actually started
// real work" by looking for splash signatures — independent of length.
const SPLASH_SIGNATURES: RegExp[] = [
	/Welcome\s+back\s+\w+/i,
	/What['']s\s+new/i,
	/release[-\s]?notes\s+for\s+more/i,
	/\[Pasted\s+text\s+#\d+\s+\+\d+\s+lines?\]/i,
	/Try\s+["“]refactor\s+<[^>]+>/i,
];

export function looksLikeClarificationStop(cleaned: string): boolean {
	if (cleaned.length > 800) return false;
	return CLARIFICATION_PHRASES.some((re) => re.test(cleaned));
}

/** Detect "the captured output is overwhelmingly Claude Code splash /
 *  paste-buffer noise — the agent never actually did work." Independent
 *  of length: even a 3000-char dump of welcome-screen / release-notes /
 *  pasted-content elision markers should trigger the retry prompt. */
export function looksLikeSplashOnly(cleaned: string): boolean {
	if (!cleaned) return false;
	let hits = 0;
	for (const re of SPLASH_SIGNATURES) if (re.test(cleaned)) hits++;
	return hits >= 2;
}

/** Build the chat-friendly body for a settled run.
 *
 *  Critical: when artefacts are present AND the agent forgot the
 *  `---CHAT---` trailer, return an empty string. The artefact + status
 *  edit + vault link tell the whole story; `cleanAgentOutputForChat`
 *  falls back to whole-output cleaning in this case and would leak the
 *  full PTY transcript. See ADR-018 follow-up + the
 *  `feedback_defensive_dispatcher_fallback` memory note. */
export function settleBody(result: DispatchResult, artefactCount: number): string {
	if (result.status === 'success') {
		const cleaned = cleanAgentOutputForChat(result.output, REPLY_LIMIT_CHARS);
		if (artefactCount > 0) {
			if (!hasChatTrailer(result.output)) return '';
			return cleaned;
		}
		if (!cleaned || cleaned.length < 30) {
			return `*${result.agentId}* finished but didn't produce a deliverable. Try again with more specifics — e.g. "image of a Dubai skyline with the temperature 34°C overlaid bottom-center".`;
		}
		if (looksLikeSplashOnly(cleaned)) {
			return `*${result.agentId}* didn't actually start work — the agent session captured only Claude Code's splash screen. This is usually transient; please retry. If it persists, the PTY backend may need a reset.`;
		}
		if (looksLikeClarificationStop(cleaned)) {
			return `*${result.agentId}* stopped to ask for clarification mid-run. Headless agents can't ask follow-up questions — please retry with the missing detail baked into the request.`;
		}
		return cleaned;
	}
	if (result.status === 'cancelled') return '';
	if (result.status === 'timeout') {
		return `Timed out at ${(result.duration_ms / 1000).toFixed(0)}s. Partial output (if any) saved to the vault.`;
	}
	if (result.status === 'budget-exceeded') {
		return `Hit cost / turn budget. Partial output (if any) saved to the vault.`;
	}
	return result.error ? result.error.slice(0, 500) : 'Unknown error.';
}

/** Terminal status line — emoji + agent name + duration (+ optional cost
 *  and turns if the dispatcher tracked them). Goes in the edited ack. */
export function terminalLine(agentId: string, result: DispatchResult): string {
	const prefix =
		result.status === 'success'
			? `✅ *${agentId}* finished`
			: result.status === 'cancelled'
				? `🛑 *${agentId}* cancelled`
				: result.status === 'timeout'
					? `⏱ *${agentId}* timed out`
					: result.status === 'budget-exceeded'
						? `💸 *${agentId}* hit its budget`
						: `⚠️ *${agentId}* errored`;

	const cost = result.cost_usd > 0 ? ` · $${result.cost_usd.toFixed(4)}` : '';
	const turns = result.num_turns ? ` · ${result.num_turns} turns` : '';
	const dur = `${(result.duration_ms / 1000).toFixed(1)}s`;
	return `${prefix} (${dur}${turns}${cost})`;
}
