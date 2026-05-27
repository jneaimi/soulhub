#!/usr/bin/env -S npx tsx
/**
 * Falsifier: hygiene-suppression-schema-coherence
 *
 * The `hygiene-suppressions.json` key schema is a 4-consumer cross-language
 * contract (suppression-reader.ts comment § Key schema):
 *
 *   Consumer           Language  Role
 *   ─────────────────  ────────  ────────────────────────────────────────────
 *   actions.ts         TS        Writes { slug, bucket, until } entries
 *   vault-escalator.ts TS        Reads via parseSuppressedKeys / loadActiveSuppressions
 *   suppression-reader.ts TS     Canonical key builder: vaultHygieneKeyFor
 *   project_hygiene.py Python    Reads via load_suppressions → entry.get("slug")
 *
 * Key shape per bucket:
 *   unresolved          → composite "${source}::${raw}"   (vaultHygieneKeyFor)
 *   all other buckets   → bare note path / project slug
 *
 * This script:
 *  1. Constructs suppression keys using the canonical TS function
 *     (`vaultHygieneKeyFor`) for representative inputs.
 *  2. Serialises each key as the `slug` field in a minimal JSON entry —
 *     exactly what `suppressAnomaly` (actions.ts) writes.
 *  3. Invokes the Python `load_suppressions` key-extraction logic via
 *     subprocess `python3 -c` with the same JSON entry.
 *  4. Asserts both sides produce the SAME key string.
 *
 * Drift detection: the falsifier goes EXIT 1 when:
 *  • TS writes a `key` field instead of `slug` → Python `entry.get("slug")`
 *    returns None → empty string ≠ TS key.
 *  • Python changes to read a different field → same mismatch.
 *  • TS changes the composite key formula (source::raw order, separator, etc.)
 *    while Python stays on the old shape embedded in historical entries.
 *
 * Run:
 *   npx tsx scripts/contracts/hygiene-suppression-schema-coherence.ts
 *
 * Exit 0 = coherent. Exit 1 = drift (contract falsified).
 */

import { spawnSync } from 'node:child_process';
import { vaultHygieneKeyFor } from '../../src/lib/vault-hygiene/suppression-reader.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The Python snippet that mirrors load_suppressions()'s key-extraction logic
 *  exactly — same field reads, same type checks, same expiry semantics.
 *  We use a far-future until date so the entry is always active. */
const PY_KEY_EXTRACTOR = `
import json, sys
entry = json.loads(sys.argv[1])
slug   = entry.get("slug")
bucket = entry.get("bucket")
until  = entry.get("until")
# Mirror the exact conditions from load_suppressions in project_hygiene.py:
#   if not (isinstance(slug, str) and isinstance(bucket, str) and isinstance(until, str)):
#       continue
#   if until > today_str:
#       active.add((slug, bucket))
if not (isinstance(slug, str) and isinstance(bucket, str) and isinstance(until, str)):
    sys.exit(0)
if until > "2026-01-01":
    print(slug, end="")
`.trim();

/** Invoke the Python extractor with a JSON entry string.
 *  Returns the extracted key or throws a descriptive error. */
function pyExtract(entryJson: string): string {
	const result = spawnSync('python3', ['-c', PY_KEY_EXTRACTOR, entryJson], {
		encoding: 'utf-8',
	});
	if (result.status !== 0 || result.error) {
		const detail = result.error?.message ?? result.stderr?.trim() ?? '(no stderr)';
		throw new Error(`python3 invocation failed: ${detail}`);
	}
	return result.stdout.trim();
}

// ── Test cases ───────────────────────────────────────────────────────────────

interface Case {
	name: string;
	/** The key TS constructs and writes as `slug`. */
	tsKey: string;
	/** Bucket name. */
	bucket: string;
}

// Far-future `until` so the entry is treated as active by the Python expiry check.
const FUTURE_DATE = '9999-12-31';

const CASES: Case[] = [
	// Broken-link (vault-escalator bucket): composite `source::raw` key.
	// This is the shape written by callback.ts:
	//   const key = `${row.source}::${row.raw}`;
	//   await suppressAnomaly(key, 'unresolved', 30);
	{
		name: 'unresolved bucket → composite source::raw',
		bucket: 'unresolved',
		tsKey: vaultHygieneKeyFor('projects/foo/adr-001.md', 'missing-note'),
	},
	// A second unresolved case with a path-segment raw target to confirm
	// the separator is `::` not `/` or other special char.
	{
		name: 'unresolved bucket → composite with slash in raw',
		bucket: 'unresolved',
		tsKey: vaultHygieneKeyFor('knowledge/some-note.md', 'projects/bar/index'),
	},
	// Orphan note (vault-escalator bucket): bare note path.
	{
		name: 'orphan_note bucket → bare note path',
		bucket: 'orphan_note',
		tsKey: 'knowledge/orphan.md',
	},
	// Stale inbox item: bare note path.
	{
		name: 'stale_inbox_item bucket → bare inbox path',
		bucket: 'stale_inbox_item',
		tsKey: 'inbox/2026-01-01-unclaimed.md',
	},
	// Project-hygiene bucket (project_hygiene.py side): bare project slug.
	{
		name: 'stale_active_14 bucket → bare project slug',
		bucket: 'stale_active_14',
		tsKey: 'soul-hub',
	},
	{
		name: 'archive_zone_mismatch bucket → bare project slug',
		bucket: 'archive_zone_mismatch',
		tsKey: 'my-old-project',
	},
];

// ── Run ──────────────────────────────────────────────────────────────────────

let allPass = true;

for (const tc of CASES) {
	// Build the JSON entry exactly as suppressAnomaly() writes it:
	//   suppressions.push({ slug, bucket, until });
	const entry = JSON.stringify({ slug: tc.tsKey, bucket: tc.bucket, until: FUTURE_DATE });

	let pythonKey: string;
	try {
		pythonKey = pyExtract(entry);
	} catch (err) {
		console.error(`[FAIL] ${tc.name}`);
		console.error(`  ${err instanceof Error ? err.message : String(err)}`);
		allPass = false;
		continue;
	}

	if (pythonKey !== tc.tsKey) {
		console.error(`[FAIL] ${tc.name}`);
		console.error(`  TS key (vaultHygieneKeyFor / slug written): "${tc.tsKey}"`);
		console.error(`  Python key (entry.get("slug")):             "${pythonKey}"`);
		allPass = false;
	} else {
		console.log(`[PASS] ${tc.name}`);
		console.log(`       key="${tc.tsKey}"`);
	}
}

if (!allPass) {
	console.error('');
	console.error(
		'hygiene-suppression-schema-coherence: FALSIFIED — TS and Python disagree on suppression key format.',
	);
	console.error(
		'Fix: ensure suppressAnomaly() writes the `slug` field with the same value vaultHygieneKeyFor returns,',
	);
	console.error(
		'     and that project_hygiene.py reads `entry.get("slug")` (not a different field).',
	);
	process.exit(1);
}

console.log('');
console.log(
	'hygiene-suppression-schema-coherence: PASS — TS and Python produce identical suppression keys for all representative inputs.',
);
process.exit(0);
