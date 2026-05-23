/**
 * project-phases ADR-008 S2 — transcript scanner.
 *
 * Walks `~/.claude/projects/*​/*.jsonl` and returns the subset that
 * need (re-)auditing: files whose mtime is newer than the latest stored
 * `audited_at` for that path. Subagent transcripts under `subagents/`
 * are skipped — they're noise from `Agent`-tool dispatches that share
 * context with the parent session.
 */

import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface ScanCandidate {
	path: string;
	mtime_ms: number;
	size_bytes: number;
}

export interface ScanResult {
	candidates: ScanCandidate[];
	scanned_dirs: number;
	skipped_unchanged: number;
	skipped_empty: number;
}

const CLAUDE_PROJECTS_ROOT = resolve(homedir(), '.claude', 'projects');
const MIN_SIZE_BYTES = 1024; // <1KB is effectively empty boilerplate

export interface ScanOptions {
	/** Override the projects root (used by tests). */
	root?: string;
	/** Map of `transcript_path -> latest audited_at`. Files at-or-older are skipped. */
	latestAuditedAtByPath?: Map<string, number>;
	/** Hard cap on candidates returned per scan tick. Default 50. */
	maxCandidates?: number;
}

export function scanTranscripts(opts: ScanOptions = {}): ScanResult {
	const root = opts.root ?? CLAUDE_PROJECTS_ROOT;
	const watermark = opts.latestAuditedAtByPath ?? new Map<string, number>();
	const maxCandidates = opts.maxCandidates ?? 50;

	const candidates: ScanCandidate[] = [];
	let scanned_dirs = 0;
	let skipped_unchanged = 0;
	let skipped_empty = 0;

	let topLevel: string[];
	try {
		topLevel = readdirSync(root);
	} catch {
		return { candidates: [], scanned_dirs: 0, skipped_unchanged: 0, skipped_empty: 0 };
	}

	for (const projectDir of topLevel) {
		const fullDir = resolve(root, projectDir);
		let stat;
		try {
			stat = statSync(fullDir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		scanned_dirs++;

		let entries: string[];
		try {
			entries = readdirSync(fullDir);
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.endsWith('.jsonl')) continue;
			const fullPath = resolve(fullDir, entry);
			let fstat;
			try {
				fstat = statSync(fullPath);
			} catch {
				continue;
			}
			if (!fstat.isFile()) continue;
			if (fstat.size < MIN_SIZE_BYTES) {
				skipped_empty++;
				continue;
			}
			const last = watermark.get(fullPath) ?? 0;
			if (fstat.mtimeMs <= last) {
				skipped_unchanged++;
				continue;
			}
			candidates.push({
				path: fullPath,
				mtime_ms: fstat.mtimeMs,
				size_bytes: fstat.size
			});
		}
	}

	// Sort oldest-modified first so we make progress on the backlog
	// instead of re-auditing whichever session was last touched.
	candidates.sort((a, b) => a.mtime_ms - b.mtime_ms);
	return {
		candidates: candidates.slice(0, maxCandidates),
		scanned_dirs,
		skipped_unchanged,
		skipped_empty
	};
}
