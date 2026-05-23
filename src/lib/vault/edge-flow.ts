/** projects-graph ADR-006 — `produces_for[]` rich-form `destination`
 *  staleness probe.
 *
 *  Given a filesystem destination (vault-internal OR external — typically
 *  `~/Downloads/<pattern>.pdf` for off-vault artefacts), return the
 *  newest `mtime` of any file under that path as an ISO date. The
 *  vault-scout edge-stale watcher feeds this back into a
 *  `kind: 'edge-stale'` candidate when the gap exceeds the declared
 *  falsifier window (per [[adr-006-cross-project-edges|ADR-006]]).
 *
 *  Pure FS access, no engine state — testable with tsx + a temp dir.
 *
 *  Inputs:
 *  - Tilde-prefixed paths (`~/Downloads/peer-brief-*.pdf`) expand via
 *    `os.homedir()`.
 *  - Trailing-slash or directory paths walk every entry (one level only;
 *    deep walks are deferred to a future revision if needed).
 *  - Glob patterns (`peer-brief-*.pdf`) are matched literally against
 *    sibling filenames in the parent directory — no glob library, no
 *    regex escapes; treats `*` as `[^/]*` and `?` as one non-slash char.
 *
 *  Output:
 *  - `{ newestMtime: number | null, fileCount: number }` — newest mtime
 *    in ms since epoch, null when no match. The caller does the
 *    "is this stale?" arithmetic against the declared window. */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, resolve as resolvePath } from 'node:path';

export interface EdgeFlowResult {
	/** Most recent matching-file mtime in ms since epoch; null when zero
	 *  files matched (broken edge — destination went missing). */
	newestMtime: number | null;
	/** Count of matching files. Useful for "consumer ever read anything?"
	 *  signals separate from "is the latest entry recent?". */
	fileCount: number;
	/** Resolved absolute path the walker scanned. Useful for audit logs. */
	resolvedDestination: string;
}

function expandTilde(p: string): string {
	if (p === '~') return homedir();
	if (p.startsWith('~/')) return resolvePath(homedir(), p.slice(2));
	return p;
}

/** Convert a glob pattern with `*` and `?` to an equivalent JS regexp.
 *  Anchored to the full string. Other regex metas are escaped. */
function globToRe(glob: string): RegExp {
	let out = '';
	for (const ch of glob) {
		if (ch === '*') out += '[^/]*';
		else if (ch === '?') out += '[^/]';
		else if (/[.+^${}()|[\]\\]/.test(ch)) out += '\\' + ch;
		else out += ch;
	}
	return new RegExp(`^${out}$`);
}

/** Walk the destination and return aggregate flow stats. Errors (path
 *  doesn't exist, permission denied) collapse to `{ newestMtime: null,
 *  fileCount: 0 }` rather than throwing — a broken destination IS the
 *  staleness signal, not an error condition. */
export async function probeEdgeFlow(destination: string): Promise<EdgeFlowResult> {
	const expanded = expandTilde(destination.trim());
	const hasGlob = /[*?]/.test(expanded);
	const empty: EdgeFlowResult = {
		newestMtime: null,
		fileCount: 0,
		resolvedDestination: expanded,
	};

	if (!expanded) return empty;

	try {
		// Glob path: split on the LAST `/` — anything left is the parent
		// dir, anything right is the filename pattern.
		if (hasGlob) {
			const parent = dirname(expanded);
			const pattern = basename(expanded);
			const re = globToRe(pattern);
			const entries = await fs.readdir(parent, { withFileTypes: true });
			let newest: number | null = null;
			let count = 0;
			for (const ent of entries) {
				if (!ent.isFile()) continue;
				if (!re.test(ent.name)) continue;
				const stat = await fs.stat(resolvePath(parent, ent.name));
				count += 1;
				if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
			}
			return { newestMtime: newest, fileCount: count, resolvedDestination: expanded };
		}

		// Non-glob: stat the destination. File → that mtime. Directory →
		// walk one level, take newest file.
		const stat = await fs.stat(expanded);
		if (stat.isFile()) {
			return {
				newestMtime: stat.mtimeMs,
				fileCount: 1,
				resolvedDestination: expanded,
			};
		}
		if (stat.isDirectory()) {
			const entries = await fs.readdir(expanded, { withFileTypes: true });
			let newest: number | null = null;
			let count = 0;
			for (const ent of entries) {
				if (!ent.isFile()) continue;
				const s = await fs.stat(resolvePath(expanded, ent.name));
				count += 1;
				if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
			}
			return { newestMtime: newest, fileCount: count, resolvedDestination: expanded };
		}
		return empty;
	} catch {
		return empty;
	}
}

/** Format a ms epoch as an ISO date (YYYY-MM-DD). Useful for the
 *  graph-edge tooltip ("last_flow_date: 2026-05-19"). */
export function isoDate(ms: number | null): string | null {
	if (ms === null) return null;
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString().slice(0, 10);
}
