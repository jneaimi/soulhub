/**
 * Link a Soul Hub PTY session (cwd + time window) to candidate Claude Code JSONLs.
 *
 * Strategy:
 *   1. Compute candidate dirs: <root>/<encoded(ptyCwd)> plus dirs that start with
 *      <encoded(ptyCwd)>-  (for sub-paths Claude was invoked from beneath the PTY cwd).
 *   2. List *.jsonl in each candidate dir.
 *   3. Peek the first event of each — keep if its timestamp falls inside the PTY window.
 *   4. Skip pure shell sessions (PTY at $HOME with no project context) — too noisy.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { SessionMeta } from '$lib/pty/store.js';
import type { ClaudeSessionRef } from './types.js';
import { encodeCwd, claudeProjectsRoot } from './paths.js';
import { peekEvents, jsonlSize } from './parser.js';

const HOME = homedir();

/** Cache directory listings briefly — UI can hammer this on rapid clicks. */
const dirCache = new Map<string, { entries: string[]; ts: number }>();
const DIR_CACHE_MS = 5_000;

function listJsonlIn(dir: string): string[] {
	const cached = dirCache.get(dir);
	const now = Date.now();
	if (cached && now - cached.ts < DIR_CACHE_MS) return cached.entries;
	let entries: string[] = [];
	try {
		entries = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
	} catch { /* dir doesn't exist; treat as empty */ }
	dirCache.set(dir, { entries, ts: now });
	return entries;
}

function listProjectDirsStartingWith(prefix: string): string[] {
	const root = claudeProjectsRoot();
	if (!existsSync(root)) return [];
	const cached = dirCache.get(root);
	const now = Date.now();
	let names: string[];
	if (cached && now - cached.ts < DIR_CACHE_MS) {
		names = cached.entries;
	} else {
		try {
			names = readdirSync(root);
			dirCache.set(root, { entries: names, ts: now });
		} catch { return []; }
	}
	return names
		.filter(n => n === prefix || n.startsWith(prefix + '-'))
		.map(n => join(root, n));
}

/**
 * Find Claude Code JSONLs whose first event falls inside the PTY session's window.
 * Returns refs ordered by ascending firstTimestamp.
 */
export async function findClaudeSessionsForPty(
	ptyMeta: SessionMeta,
): Promise<ClaudeSessionRef[]> {
	const cwd = ptyMeta.cwd;
	if (!cwd) return [];
	// Skip overly-broad PTY cwds — would match every session ever.
	if (cwd === HOME || cwd === '/') return [];

	const startedAt = ptyMeta.startedAt;
	const endedAt = ptyMeta.endedAt;
	if (!startedAt) return [];

	const startMs = new Date(startedAt).getTime();
	const endMs = endedAt ? new Date(endedAt).getTime() : Date.now();
	// Allow a small buffer (5s) for clock drift between PTY meta write and Claude session start
	const windowStart = startMs - 5_000;
	const windowEnd = endMs + 5_000;

	const encoded = encodeCwd(cwd);
	const candidateDirs = listProjectDirsStartingWith(encoded);

	const refs: ClaudeSessionRef[] = [];
	for (const dir of candidateDirs) {
		for (const name of listJsonlIn(dir)) {
			const jsonlPath = join(dir, name);
			// Cheap mtime pre-filter: a JSONL whose last-write is well outside the
			// PTY window can't possibly contain in-window events. Saves ~759
			// peekEvents() opens for typical project corpora.
			try {
				const st = statSync(jsonlPath);
				if (st.mtimeMs < windowStart - 60_000 || st.birthtimeMs > windowEnd + 60_000) continue;
			} catch { continue; }

			let firstTimestamp: string | undefined;
			let firstCwd: string | undefined;
			try {
				// First few events may lack a timestamp (e.g., permission-mode).
				// Peek up to 10 to find one with a timestamp + cwd.
				const peeked = await peekEvents(jsonlPath, 10);
				for (const e of peeked) {
					if (!firstTimestamp && e.timestamp) firstTimestamp = e.timestamp;
					if (!firstCwd && e.cwd) firstCwd = e.cwd;
					if (firstTimestamp && firstCwd) break;
				}
			} catch { continue; }
			if (!firstTimestamp) continue;
			const tsMs = new Date(firstTimestamp).getTime();
			if (tsMs < windowStart || tsMs > windowEnd) continue;
			refs.push({
				jsonlPath,
				sessionId: basename(name, '.jsonl'),
				cwd: firstCwd ?? cwd,
				firstTimestamp,
				sizeBytes: jsonlSize(jsonlPath),
			});
		}
	}
	refs.sort((a, b) => (a.firstTimestamp ?? '').localeCompare(b.firstTimestamp ?? ''));
	return refs;
}
