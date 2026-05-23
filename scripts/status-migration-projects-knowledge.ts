/** projects-graph ADR-002 — one-shot status canonical-6 migration for
 *  `projects/` + `knowledge/` zones.
 *
 *  Walks ~/vault/projects/** and ~/vault/knowledge/**, parses frontmatter
 *  status, applies the auto-map table (23 distinct non-canonical → 6
 *  canonical), writes through the chokepoint via PUT /api/vault/notes
 *  with `source_agent: status-migration` (matches the RATE_LIMIT_OVERRIDES
 *  entry at src/lib/vault/index.ts so the run finishes inside one hour
 *  window instead of stretching across four).
 *
 *  Outliers (5 distinct values, ~5 notes) are NOT auto-mapped. They go
 *  into a markdown report at the end of the run for operator review;
 *  each requires a structural fix (`partially_superseded_by`,
 *  `lock_version`, prose-to-notes-field, etc.) rather than a one-character
 *  status swap.
 *
 *  Safety:
 *    - Skips `archive/` (canonical-set rule doesn't apply there).
 *    - Skips notes already on canonical-6.
 *    - Idempotent: a second run is a no-op (every touched note now matches
 *      the canonical set; outliers were never auto-touched).
 *    - DRY-RUN default — pass `--apply` to write.
 *    - Hard cap of 1000 writes prevents a runaway from rewriting the world.
 *
 *  Usage:
 *    npx tsx scripts/status-migration-projects-knowledge.ts          # dry-run
 *    npx tsx scripts/status-migration-projects-knowledge.ts --apply  # writes
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import matter from 'gray-matter';

const VAULT_ROOT = `${process.env.HOME}/vault`;
const SOUL_HUB_URL = process.env.SOUL_HUB_URL?.replace(/\/+$/, '') || 'http://localhost:2400';
const APPLY = process.argv.includes('--apply');
const HARD_CAP = 1000;
const SOURCE_AGENT = 'status-migration';

/** projects-graph ADR-002 — auto-map table (Round-4 corrected). Keys are
 *  lowercased non-canonical values; values are the canonical-6 target. */
const STATUS_MAP: Record<string, string> = {
	active: 'accepted',
	complete: 'shipped',
	completed: 'shipped',
	done: 'shipped',
	maintained: 'shipped',
	open: 'accepted',
	closed: 'shipped',
	archived: 'parked',
	draft: 'proposed',
	'draft-v1': 'proposed',
	planning: 'proposed',
	planned: 'proposed',
	pending: 'proposed',
	'pending-approval': 'proposed',
	posted: 'shipped',
	published: 'shipped',
	'in-flight': 'accepted',
	ready: 'accepted',
	'ready-to-build': 'accepted',
	scheduled: 'accepted',
	approved: 'accepted',
	reviewed: 'accepted',
	review: 'proposed',
	'in-review': 'proposed',
	'draft-for-review': 'proposed',
	'draft-v1-for-review': 'proposed',
};

/** Outlier values that REQUIRE operator-confirmed structural changes.
 *  Detected here so the report distinguishes them from auto-mapped writes;
 *  the migration script never auto-writes outliers — operator fixes them
 *  via /vault-write in a follow-up pass. */
const OUTLIER_PATTERNS: Array<{ test: (s: string) => boolean; reason: string }> = [
	{ test: (s) => s === 'superseded-in-part', reason: 'Add `partially_superseded_by:` field; status → superseded' },
	{ test: (s) => /^locked-v\d+$/.test(s), reason: 'Add `lock_version:` field; status → accepted' },
	{ test: (s) => s.includes(' — ') || s.includes('shipped;') || s.length > 25, reason: 'Free-form prose in status field — move text to `notes:` field or ship-log section; status → accepted or shipped' },
];

const CANONICAL = new Set(['proposed', 'accepted', 'shipped', 'rejected', 'parked', 'superseded']);

interface NoteRecord {
	path: string;
	rawStatus: string;
	mappedTo: string | null;
	isOutlier: boolean;
	outlierReason?: string;
}

const records: NoteRecord[] = [];
let totalWalked = 0;
let writes = 0;
let writeFailures = 0;

async function walk(dir: string): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full);
			continue;
		}
		if (!entry.name.endsWith('.md')) continue;
		totalWalked++;
		const raw = await readFile(full, 'utf-8');
		const parsed = matter(raw);
		const rawStatus = parsed.data?.status;
		if (rawStatus === undefined || rawStatus === null || rawStatus === '') continue;
		const stringValue = String(rawStatus).trim();
		const lowered = stringValue.toLowerCase();
		if (CANONICAL.has(lowered)) continue; // already canonical

		const rel = relative(VAULT_ROOT, full);
		// Outlier detection wins over auto-map.
		const outlier = OUTLIER_PATTERNS.find((p) => p.test(stringValue) || p.test(lowered));
		if (outlier) {
			records.push({ path: rel, rawStatus: stringValue, mappedTo: null, isOutlier: true, outlierReason: outlier.reason });
			continue;
		}
		const target = STATUS_MAP[lowered];
		if (!target) {
			// Unmapped non-canonical value the table didn't anticipate.
			records.push({
				path: rel,
				rawStatus: stringValue,
				mappedTo: null,
				isOutlier: true,
				outlierReason: 'No entry in auto-map table — add to STATUS_MAP[] or treat as outlier',
			});
			continue;
		}
		records.push({ path: rel, rawStatus: stringValue, mappedTo: target, isOutlier: false });
	}
}

async function updateNote(notePath: string, newStatus: string): Promise<void> {
	const body = {
		meta: {
			status: newStatus,
			source_agent: SOURCE_AGENT,
			source_context: `ADR-002 canonical-6 migration ${new Date().toISOString().slice(0, 10)}`,
		},
	};
	const res = await fetch(`${SOUL_HUB_URL}/api/vault/notes/${notePath}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) {
		writeFailures++;
		console.error(`  ✗ ${notePath}: HTTP ${res.status} — ${text.slice(0, 200)}`);
		return;
	}
	let parsed: { success?: boolean; error?: string };
	try {
		parsed = JSON.parse(text);
	} catch {
		writeFailures++;
		console.error(`  ✗ ${notePath}: non-JSON response`);
		return;
	}
	if (parsed.success === false) {
		writeFailures++;
		console.error(`  ✗ ${notePath}: ${parsed.error}`);
		return;
	}
	writes++;
}

async function writeOutlierReport(): Promise<void> {
	const outliers = records.filter((r) => r.isOutlier);
	if (outliers.length === 0) {
		console.log('No outliers detected.');
		return;
	}
	const lines = [
		'# ADR-002 status migration — outlier report',
		'',
		`Generated: ${new Date().toISOString()}`,
		`Mode: ${APPLY ? 'apply' : 'dry-run'}`,
		'',
		`${outliers.length} note(s) need operator-confirmed structural fixes (not auto-mapped):`,
		'',
	];
	for (const o of outliers) {
		lines.push(`## ${o.path}`);
		lines.push('');
		lines.push(`- **Current status:** \`${o.rawStatus}\``);
		lines.push(`- **Proposed handling:** ${o.outlierReason}`);
		lines.push('');
	}
	const reportPath = `/tmp/adr-002-outliers-${new Date().toISOString().slice(0, 10)}.md`;
	await writeFile(reportPath, lines.join('\n'));
	console.log(`\nOutlier report: ${reportPath}`);
}

async function main(): Promise<void> {
	console.log(`ADR-002 status migration (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
	console.log(`Vault root: ${VAULT_ROOT}`);
	console.log('Walking projects/ + knowledge/ …\n');

	await walk(join(VAULT_ROOT, 'projects'));
	await walk(join(VAULT_ROOT, 'knowledge'));

	console.log(`Walked ${totalWalked} markdown files.`);
	const autoMapped = records.filter((r) => !r.isOutlier);
	const outliers = records.filter((r) => r.isOutlier);
	console.log(`Auto-map candidates: ${autoMapped.length}`);
	console.log(`Outliers (need operator review): ${outliers.length}`);

	if (autoMapped.length > HARD_CAP) {
		console.error(`Aborting: ${autoMapped.length} exceeds HARD_CAP=${HARD_CAP}. Investigate before re-running.`);
		process.exit(2);
	}

	if (!APPLY) {
		console.log('\n--- DRY-RUN preview (first 30 auto-maps) ---');
		for (const r of autoMapped.slice(0, 30)) {
			console.log(`  ${r.path}  ${r.rawStatus.padEnd(20)} → ${r.mappedTo}`);
		}
		if (autoMapped.length > 30) console.log(`  … +${autoMapped.length - 30} more`);
		await writeOutlierReport();
		console.log('\nRe-run with --apply to write.');
		return;
	}

	console.log('\nApplying writes …');
	for (const r of autoMapped) {
		if (!r.mappedTo) continue;
		await updateNote(r.path, r.mappedTo);
	}

	console.log(`\nWrites succeeded: ${writes}`);
	console.log(`Writes failed:    ${writeFailures}`);
	await writeOutlierReport();
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
