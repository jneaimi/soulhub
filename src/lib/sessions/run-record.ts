/**
 * ADR-002 Layer 1 — derive a clean run record from Claude Code's own session
 * transcript instead of scraping PTY scrollback.
 *
 * The PTY dispatcher (`src/lib/agents/dispatch/claude-pty.ts`) sets a
 * deterministic `--session-id <uuid>`, so the transcript is locatable the
 * moment the run ends. This module locates it, waits for it to settle, and
 * extracts the structured signal downstream consumers actually want — the
 * final assistant reply and an honest turn count — reusing the existing
 * `parser.ts` + `summarize.ts` infrastructure (no second JSONL parser).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { encodeCwd, claudeProjectsRoot } from './paths.js';
import { parseSession } from './parser.js';
import { summarizeSession } from './summarize.js';
import { applySubagentRollup } from './subagent-cost.js';
import type { ClaudeEvent, SessionSummary } from './types.js';

export interface AgentRunRecord {
	sessionId: string;
	jsonlPath: string;
	/** Last main-thread assistant text — the clean equivalent of the scraped
	 *  `result_excerpt`. Empty string if the run produced no assistant text. */
	finalAssistantText: string;
	/** Assistant API turns, counted by distinct requestId on the main thread. */
	assistantTurns: number;
	toolCallCount: number;
	summary: SessionSummary;
}

/**
 * Locate a transcript for a known session UUID. Tries the canonical
 * encoded-cwd path first; falls back to scanning every project dir — robust
 * against the encode rule drifting between Claude Code releases (the ADR-002
 * recommendation: prefer `--session-id` + glob over reproducing the slug).
 */
export function locateTranscript(sessionId: string, cwd?: string): string | null {
	if (cwd) {
		const direct = join(claudeProjectsRoot(), encodeCwd(cwd), `${sessionId}.jsonl`);
		if (existsSync(direct)) return direct;
	}
	let dirs: string[];
	try {
		dirs = readdirSync(claudeProjectsRoot());
	} catch {
		return null;
	}
	for (const d of dirs) {
		const candidate = join(claudeProjectsRoot(), d, `${sessionId}.jsonl`);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Last non-empty main-thread assistant text + assistant turn count. Skips
 *  sidechain (sub-agent) events so a parent dispatch reports its own reply,
 *  not a nested agent's. */
function extractAssistant(events: ClaudeEvent[]): { finalText: string; turns: number } {
	const requestIds = new Set<string>();
	let finalText = '';
	for (const e of events) {
		if (e.type !== 'assistant' || e.isSidechain) continue;
		if (e.requestId) requestIds.add(e.requestId);
		const content = e.message?.content;
		if (Array.isArray(content)) {
			const text = content
				.filter((b) => b.type === 'text' && typeof b.text === 'string')
				.map((b) => b.text!.trim())
				.filter(Boolean)
				.join('\n\n');
			if (text) finalText = text;
		} else if (typeof content === 'string' && content.trim()) {
			finalText = content.trim();
		}
	}
	return { finalText, turns: requestIds.size };
}

/**
 * Poll for the transcript to appear and settle, then parse it into a run
 * record. Returns null if the transcript never materialises within
 * `timeoutMs` — callers fall back to the legacy scrape.
 *
 * "Settled" = file size stable across one poll interval. The transcript is
 * written incrementally, so completed turns persist before we ever kill the
 * PTY; this just avoids reading a half-flushed final line.
 */
export async function loadAgentRunRecord(
	sessionId: string,
	opts: { cwd?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<AgentRunRecord | null> {
	const timeoutMs = opts.timeoutMs ?? 3000;
	const pollMs = opts.pollMs ?? 250;
	const deadline = Date.now() + timeoutMs;

	let path = locateTranscript(sessionId, opts.cwd);
	while (!path && Date.now() < deadline) {
		await sleep(pollMs);
		path = locateTranscript(sessionId, opts.cwd);
	}
	if (!path) return null;

	let prevSize = -1;
	while (Date.now() < deadline) {
		const size = safeSize(path);
		if (size > 0 && size === prevSize) break;
		prevSize = size;
		await sleep(pollMs);
	}

	try {
		const session = await parseSession(path);
		const { finalText, turns } = extractAssistant(session.events);
		const summary = summarizeSession(session);
		// ADR-005 gap #1 — fold sub-agent (fan-out) spend into the recorded total
		// so `cost_usd` in agent_runs reflects the whole run, not just the parent.
		await applySubagentRollup(summary.cost, path);
		return {
			sessionId: session.sessionId,
			jsonlPath: path,
			finalAssistantText: finalText,
			assistantTurns: turns,
			toolCallCount: summary.toolCallCount,
			summary,
		};
	} catch {
		return null;
	}
}

function safeSize(p: string): number {
	try {
		return statSync(p).size;
	} catch {
		return -1;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
