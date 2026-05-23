#!/usr/bin/env node
/**
 * One-shot repair for vault files with corrupt YAML frontmatter.
 *
 * Two known issues:
 *   1. Duplicate `created:` keys (added by self-corrupting healMissingFrontmatter)
 *      → keep first, drop rest
 *   2. Unquoted Obsidian wikilinks in scalar values (e.g.
 *      `related: [[a|alias]] [[b|alias]]`) — `|` triggers YAML block-scalar
 *      indicator → parse fails. → wrap value in single quotes.
 *
 * Validates the result with the same gray-matter that the indexer uses.
 * Only writes if the transformed file parses cleanly.
 */

import matter from 'gray-matter';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const VAULT = '/Users/jneaimi/vault';
const DRY_RUN = process.argv.includes('--dry-run');

async function* walkMd(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		if (e.name.startsWith('.')) continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			yield* walkMd(p);
		} else if (e.name.endsWith('.md')) {
			yield p;
		}
	}
}

function repair(raw) {
	if (!raw.startsWith('---')) return { changed: false, content: raw, reason: 'no-frontmatter' };
	const endIdx = raw.indexOf('\n---', 3);
	if (endIdx < 0) return { changed: false, content: raw, reason: 'no-closing' };

	const fmBlock = raw.slice(4, endIdx); // between opening "---\n" and "\n---"
	const rest = raw.slice(endIdx); // includes "\n---" and onward

	const lines = fmBlock.split('\n');
	const out = [];
	const seenKeys = new Set();
	let changed = false;

	for (const line of lines) {
		// Match top-level YAML keys (no leading whitespace; word/dash/underscore + colon)
		const m = line.match(/^([a-z_][a-z0-9_-]*):\s?(.*)$/i);
		if (!m) {
			out.push(line);
			continue;
		}
		const key = m[1];
		const value = m[2];

		// Drop duplicate top-level keys (keep first occurrence)
		if (seenKeys.has(key)) {
			changed = true;
			continue;
		}
		seenKeys.add(key);

		const trimmed = value.trim();
		const alreadyQuoted = (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
			|| (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2);

		// Reasons to single-quote a scalar value:
		//   1. Contains `[[…|…]]` (Obsidian wikilink with alias — `|` is YAML
		//      block-scalar indicator)
		//   2. Starts with `@` or backtick (YAML 1.1+ reserves these as future
		//      indicator chars at the start of an implicit scalar)
		//   3. Contains `: ` (colon + space) outside an inline-flow construct,
		//      which YAML otherwise parses as a nested mapping → "incomplete
		//      mapping pair" error
		const needsWikilinkQuote = /\[\[[^\]]*\|[^\]]*\]\]/.test(trimmed);
		const reservedStart = /^[@`]/.test(trimmed);
		// Skip flow scalars `[…]` and `{…}` — those are intentional YAML lists/maps.
		const isFlow = /^[\[{]/.test(trimmed);
		const hasUnquotedColon = !isFlow && /:\s/.test(trimmed);

		if (!alreadyQuoted && trimmed !== '' && (needsWikilinkQuote || reservedStart || hasUnquotedColon)) {
			// Single-quote: preserves `[`, `|`, `]`, `:`, `@` literally; `'` itself doubled.
			const safe = trimmed.replace(/'/g, "''");
			out.push(`${key}: '${safe}'`);
			changed = true;
		} else {
			out.push(line);
		}
	}

	if (!changed) return { changed: false, content: raw, reason: 'no-issue' };

	const newContent = '---\n' + out.join('\n') + rest;
	return { changed: true, content: newContent, reason: 'repaired' };
}

const stats = { scanned: 0, parseFail: 0, repaired: 0, stillFail: 0, written: 0 };
const samples = [];
const stillBroken = [];

for await (const abs of walkMd(VAULT)) {
	stats.scanned++;
	let raw;
	try {
		raw = await readFile(abs, 'utf-8');
	} catch { continue; }

	// Quick filter: only touch files that currently fail to parse
	let originalParses = true;
	try { matter(raw); } catch { originalParses = false; }
	if (originalParses) continue;

	stats.parseFail++;

	const { changed, content, reason } = repair(raw);
	if (!changed) {
		stillBroken.push({ path: relative(VAULT, abs), reason });
		continue;
	}

	// Validate the transform parses
	try {
		matter(content);
	} catch (e) {
		stillBroken.push({ path: relative(VAULT, abs), reason: `still-fails: ${e.message.split('\n')[0]}` });
		stats.stillFail++;
		continue;
	}

	stats.repaired++;
	if (samples.length < 3) {
		// Show a tiny diff hint
		const beforeLines = raw.split('\n').slice(0, 25);
		const afterLines = content.split('\n').slice(0, 25);
		samples.push({ path: relative(VAULT, abs), before: beforeLines, after: afterLines });
	}

	if (!DRY_RUN) {
		await writeFile(abs, content, 'utf-8');
		stats.written++;
	}
}

console.log('\n=== summary ===');
console.log(JSON.stringify(stats, null, 2));
if (stillBroken.length) {
	console.log('\n=== still broken (no repair applied or repair didn\'t help) ===');
	for (const s of stillBroken) console.log(`  ${s.path} :: ${s.reason}`);
}
if (samples.length) {
	console.log('\n=== sample (first 25 lines, before → after) ===');
	for (const s of samples) {
		console.log(`\n--- ${s.path} ---`);
		console.log('[BEFORE]');
		s.before.forEach((l, i) => console.log(`  ${i+1}: ${l}`));
		console.log('[AFTER]');
		s.after.forEach((l, i) => console.log(`  ${i+1}: ${l}`));
	}
}
