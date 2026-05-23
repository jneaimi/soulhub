/**
 * Session Store — persists PTY session metadata and logs to disk.
 *
 * Storage layout:
 *   ~/.soul-hub/sessions/{sessionId}.meta.json  — metadata
 *   ~/.soul-hub/sessions/{sessionId}.log        — terminal output
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, existsSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { tmpdir, homedir } from 'node:os';
const HOME = homedir();
const SESSIONS_DIR = join(HOME, '.soul-hub', 'sessions');

// Ensure directory exists at import time
mkdirSync(SESSIONS_DIR, { recursive: true });

export interface SessionMeta {
	id: string;
	prompt: string;
	cwd: string;
	pid: number;
	status: 'running' | 'exited' | 'killed';
	exitCode?: number;
	startedAt: string;   // ISO 8601
	endedAt?: string;    // ISO 8601
	logSize: number;     // bytes written to log
	/** ADR-002 Layer 1 — Claude Code session UUID when the spawn set a
	 *  deterministic `--session-id` (agent dispatch). Lets the vault session
	 *  capture read the clean JSONL transcript instead of the raw PTY log.
	 *  Absent for plain interactive terminals. */
	claudeSessionId?: string;
}

/** Validate session ID — only alphanumeric, hyphens, underscores allowed */
function validateSessionId(id: string): void {
	if (!/^[\w-]+$/.test(id)) {
		throw new Error(`Invalid session ID: ${id}`);
	}
}

function metaPath(id: string): string {
	validateSessionId(id);
	return join(SESSIONS_DIR, `${id}.meta.json`);
}

function logPath(id: string): string {
	validateSessionId(id);
	return join(SESSIONS_DIR, `${id}.log`);
}

/** Save session metadata */
export function saveMeta(meta: SessionMeta): void {
	writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2), 'utf-8');
}

/** Load session metadata (returns null if not found) */
export function loadMeta(id: string): SessionMeta | null {
	try {
		return JSON.parse(readFileSync(metaPath(id), 'utf-8'));
	} catch {
		return null;
	}
}

/** Append terminal output to session log */
export function appendLog(id: string, data: string): void {
	appendFileSync(logPath(id), data, 'utf-8');
}

/** Read the last N bytes of a session log */
export function readLogTail(id: string, bytes = 32_768): string {
	try {
		const p = logPath(id);
		if (!existsSync(p)) return '';
		const stats = statSync(p);
		const fd = openSync(p, 'r');
		const start = Math.max(0, stats.size - bytes);
		const buf = Buffer.alloc(Math.min(bytes, stats.size));
		readSync(fd, buf, 0, buf.length, start);
		closeSync(fd);
		return buf.toString('utf-8');
	} catch {
		return '';
	}
}

/** Get log file size in bytes */
export function getLogSize(id: string): number {
	try {
		return statSync(logPath(id)).size;
	} catch {
		return 0;
	}
}

/** List all sessions, sorted by startedAt descending (newest first) */
export function listSessions(limit = 50): SessionMeta[] {
	try {
		const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.meta.json'));
		const metas: SessionMeta[] = [];
		for (const file of files) {
			try {
				const meta: SessionMeta = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
				metas.push(meta);
			} catch { /* skip corrupt */ }
		}
		metas.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
		return metas.slice(0, limit);
	} catch {
		return [];
	}
}

/** Delete a session's metadata and log files */
export function deleteSession(id: string): boolean {
	let deleted = false;
	try { unlinkSync(metaPath(id)); deleted = true; } catch { /* ok */ }
	try { unlinkSync(logPath(id)); deleted = true; } catch { /* ok */ }
	return deleted;
}

/** Clean up old sessions (keep last N, delete the rest) */
export function pruneOldSessions(keep = 100): number {
	const all = listSessions(9999);
	let pruned = 0;
	for (const meta of all.slice(keep)) {
		deleteSession(meta.id);
		pruned++;
	}
	return pruned;
}

