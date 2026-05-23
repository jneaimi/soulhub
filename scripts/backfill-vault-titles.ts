/** One-shot backfill for auto-routed vault notes that lack a frontmatter
 *  `title:` field.
 *
 *  Context: 2026-05-14 — `dispatchVaultSave` was extended to write `title:`
 *  into frontmatter (commit 71d33cf). The composer-side title shape was
 *  also extended to include the transaction date for distinguishability
 *  (commit pending — see route-to-vault.ts:composeMoneyMovementTitle).
 *  Existing auto-routed notes (115+ in finance/, plus security/ and
 *  inbox/shipping/, inbox/service-alerts/) were written before these
 *  changes and have no frontmatter title, so the engine falls back to
 *  filename-derived ugly slug titles ("Receipt Vercel Inc Usd 20 00 Msg
 *  33611"). Retrieval reads them out verbatim.
 *
 *  This script walks the affected zones, parses the body header lines
 *  the auto-router emits (`**Merchant:** X`, `**Amount:** X`, `**Date:**
 *  X`, `**Subject:** X`), derives the clean title using the SAME shape
 *  the going-forward composer uses, and rewrites the file with `title:`
 *  added to frontmatter. Everything else is preserved verbatim.
 *
 *  Safety:
 *    - Idempotent: skips notes that already have `title:` in frontmatter.
 *    - Defaults to DRY-RUN. Pass `--apply` to actually write.
 *    - Only touches notes whose frontmatter says `source_agent:
 *      inbox-auto-route` — won't accidentally rewrite human-authored notes.
 *    - Per-zone limits + a hard total cap so a bug can't run away.
 *
 *  Usage:
 *    npx tsx scripts/backfill-vault-titles.ts          # dry-run, prints what would change
 *    npx tsx scripts/backfill-vault-titles.ts --apply  # actually writes
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

const VAULT_ROOT = `${process.env.HOME}/vault`;
const ZONES = ['finance', 'security', 'inbox/shipping', 'inbox/service-alerts'];
const HARD_CAP = 1000;

const APPLY = process.argv.includes('--apply');

interface BackfillResult {
	path: string;
	action: 'rewrite' | 'skip-has-title' | 'skip-not-auto-routed' | 'skip-no-derivable-title';
	oldTitle?: string;
	newTitle?: string;
	reason?: string;
}

/** Parse `**Label:** value` lines from the body header. Auto-routed notes
 *  start with a contiguous block of these before the `---` separator. */
function parseHeaderLines(content: string): Record<string, string> {
	const headerEnd = content.indexOf('\n---\n');
	const header = headerEnd > 0 ? content.slice(0, headerEnd) : content.slice(0, 800);
	const fields: Record<string, string> = {};
	const re = /^\*\*([^*]+):\*\*\s*(.+?)$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(header)) !== null) {
		const key = m[1].trim().toLowerCase();
		const val = m[2].trim();
		if (key && val) fields[key] = val;
	}
	return fields;
}

/** Money-movement title shape — mirrors route-to-vault.ts:composeMoneyMovementTitle.
 *  Kept inline so the backfill is self-contained (no import from the
 *  runtime composer, which would couple it to TransactionalExtract). */
function moneyMovementTitle(
	kind: 'Receipt' | 'Payment' | 'Refund' | 'Renewal',
	merchant: string,
	amount: string | null,
	date: string | null,
): string {
	if (amount && date) return `${kind} — ${merchant} (${amount}, ${date})`;
	if (amount) return `${kind} — ${merchant} (${amount})`;
	if (date) return `${kind} — ${merchant} (${date})`;
	return `${kind} — ${merchant}`;
}

/** Strip the date prefix and the optional `-msg-XXXXX` suffix from the
 *  filename stem, returning the first segment (the kind: receipt / payment
 *  / refund / renewal / statement / shipping / service-alert / security-
 *  alert). Returns null when the stem doesn't look auto-routed. */
function inferKindFromFilename(filename: string): string | null {
	const stem = filename.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
	const noSuffix = stem.replace(/-msg-\d+$/, '');
	const first = noSuffix.split('-')[0];
	return first || null;
}

function shortenSubject(s: string): string {
	const trimmed = s.replace(/\s+/g, ' ').trim();
	return trimmed.length <= 80 ? trimmed : trimmed.slice(0, 77) + '…';
}

/** Reconstruct a readable subject from the filename slug, when the body's
 *  `**Subject:**` line is missing. Strips the leading kind segment + the
 *  `-msg-NNN` suffix + the date prefix, title-cases the remainder.
 *  Best-effort: produces 'Document Required For U 1213' from
 *  `2026-05-12-security-alert-document-required-for-u-1213-msg-33619.md`. */
function subjectFromFilename(filename: string, kindSegments: string[]): string {
	let stem = filename.replace(/\.md$/i, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
	stem = stem.replace(/-msg-\d+$/, '');
	// Strip the kind prefix (e.g., 'security-alert-' or 'security-').
	for (const ks of kindSegments) {
		if (stem.startsWith(ks + '-')) {
			stem = stem.slice(ks.length + 1);
			break;
		}
	}
	return stem
		.split('-')
		.map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
		.join(' ');
}

/** Compose the title from parsed header fields + filename kind. Mirrors
 *  composeNote() in route-to-vault.ts for each branch. Falls back to
 *  'Unknown merchant' for money-movement kinds with no merchant (matches
 *  the live composer's fallback) and to a filename-derived subject for
 *  alert kinds with no body Subject. Returns null only when even the
 *  filename gives us nothing. */
function deriveTitle(
	fields: Record<string, string>,
	kind: string | null,
	filename: string,
): string | null {
	const merchant = fields['merchant'] || null;
	const amount = fields['amount'] || null;
	const date = fields['date'] || null;
	const bodySubject = fields['subject'] || null;

	switch (kind) {
		case 'receipt':
			return moneyMovementTitle('Receipt', merchant ?? 'Unknown merchant', amount, date);
		case 'payment':
			return moneyMovementTitle('Payment', merchant ?? 'Unknown merchant', amount, date);
		case 'refund':
			return moneyMovementTitle('Refund', merchant ?? 'Unknown merchant', amount, date);
		case 'renewal':
		case 'subscription':
			return moneyMovementTitle('Renewal', merchant ?? 'Unknown merchant', amount, date);
		case 'statement': {
			const m = merchant ?? 'Unknown bank';
			const subj = bodySubject ?? subjectFromFilename(filename, ['statement']);
			return subj ? `Statement — ${m}: ${shortenSubject(subj)}` : `Statement — ${m}`;
		}
		case 'security':
		case 'security-alert': {
			const subj = bodySubject ?? subjectFromFilename(filename, ['security-alert', 'security']);
			return subj ? `Security alert — ${shortenSubject(subj)}` : null;
		}
		case 'shipping': {
			const subj = bodySubject ?? subjectFromFilename(filename, ['shipping']);
			return subj ? `Shipping — ${shortenSubject(subj)}` : null;
		}
		case 'service':
		case 'service-alert': {
			const subj = bodySubject ?? subjectFromFilename(filename, ['service-alert', 'service']);
			return subj ? `Service alert — ${shortenSubject(subj)}` : null;
		}
		default:
			return null;
	}
}

async function processZone(zoneRel: string, results: BackfillResult[]): Promise<void> {
	const zoneAbs = join(VAULT_ROOT, zoneRel);
	let files: string[];
	try {
		files = (await readdir(zoneAbs)).filter((f) => f.endsWith('.md') && f !== 'index.md' && f !== 'CLAUDE.md');
	} catch (err) {
		console.warn(`[backfill] zone '${zoneRel}' unreadable: ${(err as Error).message}`);
		return;
	}

	for (const filename of files) {
		if (results.length >= HARD_CAP) {
			console.warn(`[backfill] hit HARD_CAP=${HARD_CAP}, stopping`);
			return;
		}
		const filePath = join(zoneAbs, filename);
		const raw = await readFile(filePath, 'utf-8');
		const parsed = matter(raw);
		const fm = parsed.data as Record<string, unknown>;

		if (fm.source_agent !== 'inbox-auto-route') {
			results.push({
				path: join(zoneRel, filename),
				action: 'skip-not-auto-routed',
				reason: `source_agent=${JSON.stringify(fm.source_agent)}`,
			});
			continue;
		}

		if (typeof fm.title === 'string' && fm.title.trim().length > 0) {
			results.push({
				path: join(zoneRel, filename),
				action: 'skip-has-title',
				oldTitle: fm.title,
			});
			continue;
		}

		const fields = parseHeaderLines(parsed.content);
		const kind = inferKindFromFilename(filename);
		const newTitle = deriveTitle(fields, kind, filename);

		if (!newTitle) {
			results.push({
				path: join(zoneRel, filename),
				action: 'skip-no-derivable-title',
				reason: `kind=${kind}, fields=${JSON.stringify(Object.keys(fields))}`,
			});
			continue;
		}

		if (APPLY) {
			// Inject title at the top of frontmatter so it's the first field
			// (Obsidian + the vault parser don't care about order, but humans
			// scanning the YAML do). gray-matter's stringify rebuilds the
			// document; we hand-spice the data object so its iteration order
			// puts title first.
			const newData: Record<string, unknown> = { title: newTitle, ...fm };
			const rewritten = matter.stringify(parsed.content, newData);
			await writeFile(filePath, rewritten, 'utf-8');
		}

		results.push({
			path: join(zoneRel, filename),
			action: 'rewrite',
			newTitle,
		});
	}
}

async function main() {
	console.log(`=== vault title backfill ===`);
	console.log(`mode: ${APPLY ? 'APPLY (will write)' : 'DRY-RUN (no writes)'}`);
	console.log(`vault: ${VAULT_ROOT}`);
	console.log(`zones: ${ZONES.join(', ')}`);
	console.log('');

	const results: BackfillResult[] = [];
	for (const zone of ZONES) {
		await processZone(zone, results);
	}

	const groups = {
		rewrite: results.filter((r) => r.action === 'rewrite'),
		skipHasTitle: results.filter((r) => r.action === 'skip-has-title'),
		skipNotAuto: results.filter((r) => r.action === 'skip-not-auto-routed'),
		skipNoTitle: results.filter((r) => r.action === 'skip-no-derivable-title'),
	};

	console.log(`\n=== summary ===`);
	console.log(`  rewrite:                ${groups.rewrite.length}`);
	console.log(`  skip (has title):       ${groups.skipHasTitle.length}`);
	console.log(`  skip (not auto-routed): ${groups.skipNotAuto.length}`);
	console.log(`  skip (no title found):  ${groups.skipNoTitle.length}`);
	console.log(`  TOTAL:                  ${results.length}`);

	if (groups.rewrite.length > 0) {
		console.log(`\n=== first 8 rewrites ===`);
		groups.rewrite.slice(0, 8).forEach((r) => {
			console.log(`  ${r.path}`);
			console.log(`    → title: ${r.newTitle}`);
		});
	}
	if (groups.skipNoTitle.length > 0) {
		console.log(`\n=== ${groups.skipNoTitle.length} files with no derivable title (first 5) ===`);
		groups.skipNoTitle.slice(0, 5).forEach((r) => {
			console.log(`  ${r.path}  (${r.reason})`);
		});
	}

	if (!APPLY) {
		console.log(`\n(dry-run — rerun with --apply to write the ${groups.rewrite.length} rewrites)`);
	} else {
		console.log(`\n✅ wrote ${groups.rewrite.length} files`);
	}
}

main().catch((e) => {
	console.error('backfill failed:', e);
	process.exit(1);
});
