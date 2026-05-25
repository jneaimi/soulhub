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
	/** ADR-008 — sub-agent types this run spawned that match its OWN agent id
	 *  (self-delegation). Empty unless `parentAgentId` was passed to the loader
	 *  AND a matching `Agent`/`Task` tool_use was found in the parent transcript.
	 *  Detection-only (recursion is already depth-capped + cost-bounded); the
	 *  dispatcher surfaces a warning when non-empty. */
	selfDelegatedTypes: string[];
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

/** ADR-008 self-delegation detection. Scans the parent transcript's main-thread
 *  `Agent`/`Task` tool_use blocks for a `subagent_type` equal to the parent's
 *  own agent id — i.e. an orchestrator spawning a sub-agent of its own type.
 *  Returns the distinct offending types (usually 0 or 1). Pure; no I/O. */
export function extractSelfDelegation(events: ClaudeEvent[], parentAgentId: string): string[] {
	const hits = new Set<string>();
	for (const e of events) {
		if (e.type !== 'assistant' || e.isSidechain) continue;
		const content = e.message?.content;
		if (!Array.isArray(content)) continue;
		for (const b of content) {
			if (b.type !== 'tool_use') continue;
			// CC renamed `Task` → `Agent` in 2.1.63; match both.
			if (b.name !== 'Agent' && b.name !== 'Task') continue;
			const st = b.input?.subagent_type;
			if (typeof st === 'string' && st === parentAgentId) hits.add(st);
		}
	}
	return [...hits];
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
	opts: { cwd?: string; timeoutMs?: number; pollMs?: number; parentAgentId?: string } = {},
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
		// ADR-008 — flag self-delegation (orchestrator spawning its own type). Only
		// runs when the caller knows the parent agent id; otherwise stays empty.
		const selfDelegatedTypes = opts.parentAgentId
			? extractSelfDelegation(session.events, opts.parentAgentId)
			: [];
		return {
			sessionId: session.sessionId,
			jsonlPath: path,
			finalAssistantText: finalText,
			assistantTurns: turns,
			toolCallCount: summary.toolCallCount,
			summary,
			selfDelegatedTypes,
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
