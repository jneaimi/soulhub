/** Format/parse helpers for the "fix broken wikilinks" bulk flow.
 *
 *  ADR-008 retirement update (2026-05-26): the keeper-specific functions
 *  (`formatKeeperTask`, `parseKeeperResult`, `formatTelegramResult`) have been
 *  removed. The `vh-fix-all` Telegram button now calls `healBrokenLinks` from
 *  `system/healers/vault-healer.ts` directly (deterministic, no LLM).
 *  `formatHealResult` replaces `formatTelegramResult` for that output shape.
 *
 *  Retained: `FixBatchEntry`, `formatAggregateDigest`, `formatBatchList`
 *  (all still used by vault-escalator + daily-digest + vh-fix-list).
 */

import type { HealResult } from '$lib/system/types.js';

export interface FixBatchEntry {
	source: string;
	raw: string;
}

/** Format a `HealResult` from `healBrokenLinks` as a Telegram message body.
 *
 *  Replaces the old `formatTelegramResult(KeeperFixResult)` — same purpose,
 *  different input shape.  Unresolved "skipped" items are directed to the
 *  /hygiene dashboard where `hygiene-fixer` can propose a retarget. */
export function formatHealResult(result: HealResult, totalRequested: number): string {
	const fixedCount = result.fixed.length;
	const skippedCount = result.skipped.length;
	const errorCount = result.errors.length;

	const lines: string[] = [];
	lines.push(
		`🔧 Auto-fix complete — ${fixedCount}/${totalRequested} fixed` +
			(skippedCount > 0 ? `, ${skippedCount} need manual review` : ''),
	);

	if (fixedCount > 0) {
		lines.push('');
		lines.push(`✅ Fixed (${fixedCount}):`);
		for (const f of result.fixed.slice(0, 8)) {
			// Fixed entries have format "source: [[raw]] → [[replacement]]"
			const sep = f.indexOf(': [[');
			if (sep >= 0) {
				const src = basename(f.slice(0, sep));
				lines.push(`  • ${src}: ${f.slice(sep + 2)}`);
			} else {
				lines.push(`  • ${basename(f)}`);
			}
		}
		if (fixedCount > 8) lines.push(`  • …+${fixedCount - 8} more`);
	}

	if (skippedCount > 0) {
		lines.push('');
		lines.push(
			`❓ Need manual review (${skippedCount}) — open /hygiene to dispatch hygiene\\-fixer:`,
		);
		for (const s of result.skipped.slice(0, 5)) {
			// Skipped entries have format "source: [[raw]]"
			const src = basename(s.split(':')[0]);
			lines.push(`  • ${src}`);
		}
		if (skippedCount > 5) lines.push(`  • …+${skippedCount - 5} more`);
	}

	if (errorCount > 0) {
		lines.push('');
		lines.push(`🚫 Errors (${errorCount}):`);
		for (const e of result.errors.slice(0, 3)) {
			lines.push(`  • ${basename(e.path)}: ${e.error}`);
		}
		if (errorCount > 3) lines.push(`  • …+${errorCount - 3} more`);
	}

	return lines.join('\n');
}

/** Format the aggregate digest message (the one with the keyboard
 *  buttons). Sent ONCE per batch by the escalator. */
export function formatAggregateDigest(batch: FixBatchEntry[]): string {
	const projectCount = new Set(
		batch.map((b) => b.source.split('/').slice(0, 2).join('/')),
	).size;
	const date = new Date().toISOString().slice(0, 10);
	return [
		`📋 ${batch.length} broken wikilink${batch.length === 1 ? '' : 's'} across ${projectCount} file${projectCount === 1 ? '' : 's'}`,
		`Vault hygiene — ${date}. Choose action below.`,
	].join('\n');
}

/** Format the "Show list" expansion — pure text enumeration of the
 *  batch. Used by the vh-fix-list callback to replace the aggregate
 *  message body. */
export function formatBatchList(batch: FixBatchEntry[]): string {
	const lines: string[] = [
		`📋 ${batch.length} broken wikilink${batch.length === 1 ? '' : 's'}`,
		'',
	];
	for (let i = 0; i < batch.length; i++) {
		const b = batch[i];
		lines.push(`${i + 1}. ${basename(b.source)}`);
		lines.push(`   \`[[${b.raw}]]\``);
	}
	return lines.join('\n');
}

function basename(p: string): string {
	const last = p.split('/').pop() ?? p;
	return last.replace(/\.md$/, '');
}
