#!/usr/bin/env node
/**
 * ADR-044 Phase A backfill — add `inbox_message_id` to existing saved
 * email notes' frontmatter by parsing the messageId out of the body's
 * `## Source` block (line shape: `- **Inbox message id**: 34510`).
 *
 * Idempotent — skips notes that already have `inbox_message_id` set,
 * and skips notes where the body has no parseable id (no source block,
 * or pre-ADR-044 saves that used a different shape).
 *
 * Usage:
 *   node scripts/backfill-inbox-message-id.mjs            # dry run
 *   node scripts/backfill-inbox-message-id.mjs --write    # actually patch
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const VAULT_DIR = join(homedir(), 'vault');
const EMAIL_ROOT = join(VAULT_DIR, 'email');
const DRY = !process.argv.includes('--write');

const stats = { scanned: 0, patched: 0, alreadyHadId: 0, noIdFound: 0, drafts: 0 };

/** Walk every .md file under email/, excluding email/drafts/ (drafts already
 *  carry the id in body but aren't part of Phase A's save-side surface). */
async function* walkEmailNotes(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const ent of entries) {
		const full = join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'drafts' || ent.name === 'attachments') continue;
			yield* walkEmailNotes(full);
		} else if (ent.isFile() && ent.name.endsWith('.md')) {
			yield full;
		}
	}
}

/** Frontmatter parser — minimal, line-based. Returns
 *  { fmStart, fmEnd, lines, hasInboxMessageId } or null if no frontmatter. */
function parseFrontmatterBlock(content) {
	const lines = content.split('\n');
	if (lines[0] !== '---') return null;
	let fmEnd = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === '---') {
			fmEnd = i;
			break;
		}
	}
	if (fmEnd === -1) return null;
	const fmLines = lines.slice(1, fmEnd);
	const hasInboxMessageId = fmLines.some((l) => /^inbox_message_id\s*:/.test(l));
	return { fmStart: 0, fmEnd, lines, hasInboxMessageId };
}

function extractMessageIdFromBody(content) {
	// Match `- **Inbox message id**: 34510` (case-insensitive, allow extra space)
	const m = content.match(/[-*]\s+\*\*Inbox message id\*\*:\s*(\d+)/i);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function patchFrontmatter(parsed, messageId) {
	// Insert `inbox_message_id: <n>` after `source_agent` line if present,
	// else immediately before the closing `---`. Keeps frontmatter readable.
	const insertLine = `inbox_message_id: ${messageId}`;
	const fmLines = parsed.lines.slice(1, parsed.fmEnd);
	let insertAt = parsed.fmEnd; // before closing ---
	for (let i = 0; i < fmLines.length; i++) {
		if (/^source_agent\s*:/.test(fmLines[i])) {
			insertAt = i + 2; // after source_agent line, accounting for opening ---
			break;
		}
	}
	const patched = [...parsed.lines];
	patched.splice(insertAt, 0, insertLine);
	return patched.join('\n');
}

async function processNote(path) {
	stats.scanned++;
	const raw = await readFile(path, 'utf8');
	const parsed = parseFrontmatterBlock(raw);
	if (!parsed) {
		console.log(`[skip] ${path} — no frontmatter`);
		stats.noIdFound++;
		return;
	}
	if (parsed.hasInboxMessageId) {
		stats.alreadyHadId++;
		return;
	}
	const messageId = extractMessageIdFromBody(raw);
	if (!messageId) {
		console.log(`[skip] ${path} — no parseable messageId in body`);
		stats.noIdFound++;
		return;
	}
	const patched = patchFrontmatter(parsed, messageId);
	if (DRY) {
		console.log(`[dry] would patch ${path} → inbox_message_id: ${messageId}`);
	} else {
		await writeFile(path, patched, 'utf8');
		console.log(`[patched] ${path} → inbox_message_id: ${messageId}`);
	}
	stats.patched++;
}

async function main() {
	try {
		await stat(EMAIL_ROOT);
	} catch {
		console.error(`vault email root not found: ${EMAIL_ROOT}`);
		process.exit(2);
	}
	console.log(`Mode: ${DRY ? 'DRY RUN' : 'WRITE'}`);
	console.log(`Root: ${EMAIL_ROOT}`);
	for await (const path of walkEmailNotes(EMAIL_ROOT)) {
		await processNote(path);
	}
	console.log('\n--- summary ---');
	console.log(`Scanned:            ${stats.scanned}`);
	console.log(`Patched:            ${stats.patched}${DRY ? ' (dry — no writes)' : ''}`);
	console.log(`Already had id:     ${stats.alreadyHadId}`);
	console.log(`No id parseable:    ${stats.noIdFound}`);
	if (DRY) console.log('\nRe-run with --write to apply.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
