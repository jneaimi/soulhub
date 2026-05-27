/** ADR-006 P1.0 — Shared helpers for hygiene-suppressions.json.
 *
 *  Four consumers of this file (cross-language contract):
 *   1. actions.ts          (TS write — writes `slug` field)
 *   2. vault-escalator.ts  (TS read — re-exports vaultHygieneKeyFor from here)
 *   3. project_hygiene.py  (Python read — reads `slug`)
 *   4. report.ts           (TS read — this module, reads `key ?? slug`)
 *
 *  Key schema per bucket:
 *   - `unresolved`        → composite `${source}::${raw}` (vaultHygieneKeyFor)
 *   - all other buckets   → bare note path
 *
 *  Expiry: an entry with `until <= today` is EXPIRED and must NOT suppress
 *  any item. This matches the escalator's `if (entry.until <= today) continue`
 *  semantics (vault-escalator.ts loadActiveSuppressions). */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Build the composite key for a broken-link suppression. Canonical source —
 *  re-exported by vault-escalator.ts so both paths share one impl.
 *  Key shape: `${source}::${raw}` (source path + literal raw link text so
 *  multiple broken links in the same file can be suppressed independently). */
export function vaultHygieneKeyFor(source: string, raw: string): string {
	return `${source}::${raw}`;
}

export const SUPPRESSIONS_PATH = join(homedir(), '.soul-hub', 'data', 'hygiene-suppressions.json');

interface SuppressionEntry {
	key?: string;
	slug?: string;
	bucket?: string;
	until?: string; // YYYY-MM-DD
}

/** Load the set of active suppression keys for `bucket` from the filesystem.
 *  Returns an empty Set on any read/parse error so a missing or corrupt file
 *  never breaks the hygiene report. */
export async function loadSuppressedKeys(bucket: string): Promise<Set<string>> {
	try {
		const text = await readFile(SUPPRESSIONS_PATH, 'utf-8');
		return parseSuppressedKeys(text, bucket);
	} catch {
		return new Set();
	}
}

/** Pure parser exposed for unit testing (no filesystem I/O).
 *
 *  @param jsonText  Raw JSON text of the suppressions file.
 *  @param bucket    Bucket name to filter on.
 *  @param today     ISO date string YYYY-MM-DD to use as "today" (defaults to
 *                   the real today). Override in tests to produce deterministic
 *                   results regardless of the calendar date.
 */
export function parseSuppressedKeys(
	jsonText: string,
	bucket: string,
	today?: string,
): Set<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return new Set();
	}
	if (!Array.isArray(parsed)) return new Set();

	const todayStr = today ?? new Date().toISOString().slice(0, 10);
	const active = new Set<string>();

	for (const entry of parsed as SuppressionEntry[]) {
		if (entry?.bucket !== bucket) continue;
		if (typeof entry.until !== 'string') continue;
		// Expiry check: ISO date strings sort lexicographically, so string
		// comparison is correct. `until <= today` means expired (must NOT hide).
		if (entry.until <= todayStr) continue;
		// Cross-language contract: `key` field (preferred, escalator-authored)
		// falls back to `slug` (legacy write path via suppressAnomaly).
		const key = entry.key ?? entry.slug;
		if (typeof key === 'string') active.add(key);
	}

	return active;
}
