/** projects-graph ADR-007 — one-shot status migration for `content/` zone.
 *
 *  Walks ~/vault/content/**, parses frontmatter status, applies the
 *  13 → 8 auto-map table (round-4 + round-5 vocab), writes through the
 *  chokepoint via PUT /api/vault/notes with `source_agent: status-migration`
 *  (matches the RATE_LIMIT_OVERRIDES entry at src/lib/vault/index.ts so
 *  the run finishes inside one hour window).
 *
 *  Allowed content/ vocab (8): idea, draft, review, approved, posted,
 *  killed, archived, evergreen. Distinct from canonical-6 (proposed,
 *  accepted, shipped, rejected, parked, superseded) used in projects/
 *  + knowledge/. ADR-002 status-migration-projects-knowledge.ts is the
 *  sibling that owns those zones.
 *
 *  Safety:
 *    - Skips `archive/` (out of scope; canonical-set rule doesn't apply).
 *    - Skips notes already on the 8 allowed values.
 *    - Idempotent: a second run is a no-op.
 *    - DRY-RUN default — pass `--apply` to write.
 *    - Hard cap of 500 writes prevents a runaway.
 *
 *  Usage:
 *    npx tsx scripts/status-migration-content.ts          # dry-run
 *    npx tsx scripts/status-migration-content.ts --apply  # writes
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import matter from 'gray-matter';

const VAULT_ROOT = `${process.env.HOME}/vault`;
const SOUL_HUB_URL = process.env.SOUL_HUB_URL?.replace(/\/+$/, '') || 'http://localhost:2400';
const APPLY = process.argv.includes('--apply');
const HARD_CAP = 500;
const SOURCE_AGENT = 'status-migration';

/** Round-4 + round-5 corrected map. Keys are lowercased non-canonical
 *  values; values are the 8-vocab target. */
const STATUS_MAP: Record<string, string> = {
	open: 'idea',
	reviewed: 'review',
	published: 'posted',
	closed: 'killed',
	parked: 'archived',
	complete: 'posted',
	scheduled: 'approved',
	active: 'draft',
	ready: 'approved',
	done: 'posted',
};

const ALLOWED = new Set(['idea', 'draft', 'review', 'approved', 'posted', 'killed', 'archived', 'evergreen']);

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
		if (ALLOWED.has(lowered)) continue; // already in vocab

		const rel = relative(VAULT_ROOT, full);
		const target = STATUS_MAP[lowered];
		if (!target) {
			records.push({
				path: rel,
				rawStatus: stringValue,
				mappedTo: null,
				isOutlier: true,
				outlierReason: 'No entry in STATUS_MAP — add a mapping or treat as outlier',
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
			source_context: `ADR-007 content vocab migration ${new Date().toISOString().slice(0, 10)}`,
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
		'# ADR-007 status migration — outlier report',
		'',
		`Generated: ${new Date().toISOString()}`,
		`Mode: ${APPLY ? 'apply' : 'dry-run'}`,
		'',
		`${outliers.length} note(s) need operator review (not auto-mapped):`,
		'',
	];
	for (const o of outliers) {
		lines.push(`## ${o.path}`);
		lines.push('');
		lines.push(`- **Current status:** \`${o.rawStatus}\``);
		lines.push(`- **Proposed handling:** ${o.outlierReason}`);
		lines.push('');
	}
	const reportPath = `/tmp/adr-007-outliers-${new Date().toISOString().slice(0, 10)}.md`;
	await writeFile(reportPath, lines.join('\n'));
	console.log(`\nOutlier report: ${reportPath}`);
}

async function main(): Promise<void> {
	console.log(`ADR-007 content/ status migration (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
	console.log(`Vault root: ${VAULT_ROOT}`);
	console.log('Walking content/ …\n');

	await walk(join(VAULT_ROOT, 'content'));

	console.log(`Walked ${totalWalked} markdown files.`);
	const autoMapped = records.filter((r) => !r.isOutlier);
	const outliers = records.filter((r) => r.isOutlier);
	console.log(`Auto-map candidates: ${autoMapped.length}`);
	console.log(`Outliers (need operator review): ${outliers.length}`);

	// Per-target summary
	const byTarget: Record<string, number> = {};
	for (const r of autoMapped) {
		if (!r.mappedTo) continue;
		byTarget[r.mappedTo] = (byTarget[r.mappedTo] || 0) + 1;
	}
	console.log('\nPer-target counts:');
	for (const [k, v] of Object.entries(byTarget).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${k.padEnd(12)} ${v}`);
	}

	if (autoMapped.length > HARD_CAP) {
		console.error(`Aborting: ${autoMapped.length} exceeds HARD_CAP=${HARD_CAP}. Investigate before re-running.`);
		process.exit(2);
	}

	if (!APPLY) {
		console.log('\n--- DRY-RUN preview (first 30 auto-maps) ---');
		for (const r of autoMapped.slice(0, 30)) {
			console.log(`  ${r.path.padEnd(60)} ${r.rawStatus.padEnd(12)} → ${r.mappedTo}`);
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
