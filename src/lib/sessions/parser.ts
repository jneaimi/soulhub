/**
 * Streaming JSONL parser for Claude Code session files.
 * Tolerant of unknown event types and malformed lines (skipped, not thrown).
 */

import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import type { ClaudeEvent, ClaudeSession } from './types.js';

/**
 * Stream parse a JSONL file line-by-line.
 * Caller can iterate without loading the full file into memory.
 */
export async function* streamEvents(jsonlPath: string): AsyncGenerator<ClaudeEvent> {
	const stream = createReadStream(jsonlPath, { encoding: 'utf8' });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line) continue;
		try {
			yield JSON.parse(line) as ClaudeEvent;
		} catch {
			// skip malformed lines silently — JSONL writers occasionally truncate at EOF
		}
	}
}

/** Peek the first N events of a JSONL — used by the linker for cheap dir scans. */
export async function peekEvents(jsonlPath: string, n: number = 1): Promise<ClaudeEvent[]> {
	const out: ClaudeEvent[] = [];
	for await (const e of streamEvents(jsonlPath)) {
		out.push(e);
		if (out.length >= n) break;
	}
	return out;
}

/**
 * Parse a complete JSONL session into a typed structure.
 * Note: holds all events in memory — fine for typical sessions (validation
 * showed even 97MB / 32k events parses in 0.28s).
 */
export async function parseSession(jsonlPath: string): Promise<ClaudeSession> {
	const events: ClaudeEvent[] = [];
	let sessionId: string | undefined;
	let cwd: string | undefined;
	let gitBranch: string | undefined;
	let firstTimestamp: string | undefined;
	let lastTimestamp: string | undefined;
	const modelCounts = new Map<string, number>();

	for await (const e of streamEvents(jsonlPath)) {
		events.push(e);
		if (!sessionId && e.sessionId) sessionId = e.sessionId;
		if (!cwd && e.cwd) cwd = e.cwd;
		if (!gitBranch && e.gitBranch) gitBranch = e.gitBranch;
		if (e.timestamp) {
			if (!firstTimestamp) firstTimestamp = e.timestamp;
			lastTimestamp = e.timestamp;
		}
		const m = e.message?.model;
		if (m) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
	}

	let model: string | undefined;
	if (modelCounts.size) {
		model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
	}

	return {
		jsonlPath,
		sessionId: sessionId ?? basename(jsonlPath, '.jsonl'),
		cwd: cwd ?? '',
		gitBranch,
		model,
		firstTimestamp,
		lastTimestamp,
		events,
	};
}

/** Lightweight stat — used in API list endpoints to avoid full parse. */
export function jsonlSize(jsonlPath: string): number {
	try { return statSync(jsonlPath).size; } catch { return 0; }
}
