/** Pure helper — extract the last N main-thread turns from a parsed Claude
 *  session for human-readable display (Telegram excerpts, workbench review
 *  panels).
 *
 *  "Turn" here is a single user or assistant event on the main thread (skips
 *  sidechain / sub-agent events). Tool-use blocks are summarised as
 *  `[tool: <name>]` so the excerpt stays readable instead of dumping JSON
 *  arguments at the operator.
 *
 *  Pure: no I/O, no side effects. Loader is the caller's concern (see
 *  `src/lib/sessions/parser.ts:streamEvents`). */

import type { ClaudeEvent } from './types.js';

export interface RecentTurn {
	role: 'user' | 'assistant';
	text: string;
	/** ISO timestamp from the event, when present. Useful for "5 min ago" UI. */
	timestamp?: string;
}

export interface ExtractOptions {
	/** Max number of recent turns to return. Default 3. */
	limit?: number;
	/** Per-turn character cap. Default 600. */
	perTurnMaxChars?: number;
}

/** Project a single event's text blocks into a flat string suitable for
 *  display. tool_use blocks become `[tool: <name>]`; tool_result blocks are
 *  skipped (their content lives in the next assistant turn). */
function projectContent(content: unknown): string {
	if (typeof content === 'string') return content.trim();
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const b of content) {
		if (!b || typeof b !== 'object') continue;
		const block = b as { type?: string; text?: string; name?: string };
		if (block.type === 'text' && typeof block.text === 'string') {
			const t = block.text.trim();
			if (t) parts.push(t);
		} else if (block.type === 'tool_use' && typeof block.name === 'string') {
			parts.push(`[tool: ${block.name}]`);
		}
		// tool_result intentionally skipped — too noisy for an excerpt
	}
	return parts.join('\n');
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1).trimEnd() + '…';
}

/** Return the last N main-thread turns of the session, oldest-first within the
 *  window. Empty array if no qualifying events. */
export function extractRecentTurns(
	events: ClaudeEvent[],
	opts: ExtractOptions = {},
): RecentTurn[] {
	const limit = opts.limit ?? 3;
	const perTurnMaxChars = opts.perTurnMaxChars ?? 600;
	if (limit <= 0) return [];

	const turns: RecentTurn[] = [];
	for (const e of events) {
		if (e.isSidechain) continue;
		if (e.type !== 'user' && e.type !== 'assistant') continue;
		const role = e.type as 'user' | 'assistant';
		const text = projectContent(e.message?.content);
		if (!text) continue;
		turns.push({
			role,
			text: truncate(text, perTurnMaxChars),
			...(e.timestamp ? { timestamp: e.timestamp } : {}),
		});
	}

	return turns.slice(-limit);
}
