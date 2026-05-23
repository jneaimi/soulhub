/** Format keeper task + parse keeper result for the "fix broken
 *  wikilinks" bulk flow (see soul-hub/decisions/2026-05-18-adr-status-…
 *  follow-up — bulk-fix surface).
 *
 *  Pure functions, no I/O. The task message is the prompt the keeper
 *  PTY sees. The result parser drains the keeper's stdout for a strict
 *  JSON block delimited by ```json … ```.
 */

export interface FixBatchEntry {
	source: string;
	raw: string;
}

export interface FixedLink {
	source: string;
	oldRaw: string;
	newRaw: string;
}

export interface AmbiguousLink {
	source: string;
	raw: string;
	candidates: string[];
	note?: string;
}

export interface UnresolvableLink {
	source: string;
	raw: string;
	reason?: string;
}

export interface KeeperFixResult {
	fixed: FixedLink[];
	ambiguous: AmbiguousLink[];
	unresolvable: UnresolvableLink[];
}

/** The task message the keeper receives. Kept LEAN — the full
 *  algorithm + JSON contract live in `keeper.md` §4 (loaded as
 *  system_prompt via `--agent keeper`), so the user-message body only
 *  carries the sentinel + batch list. claude-pty fragments any user
 *  message >100 lines into `[Pasted text #N]` blocks that never auto-
 *  confirm, so we keep this to ~30 lines for 20-ish links. */
export function formatKeeperTask(batch: FixBatchEntry[]): string {
	const enumerated = batch
		.map(
			(b, i) =>
				`${i + 1}. source: \`${b.source}\` — raw: \`[[${b.raw}]]\``,
		)
		.join('\n');

	return `FIX-BROKEN-LINKS

Apply the bulk fix-broken-links algorithm from your system prompt §4 to the ${batch.length} link${batch.length === 1 ? '' : 's'} below. Vault API base: http://localhost:2400.

${enumerated}

Output ONLY the final JSON result block (shape per system prompt). No prose after it.`;
}

/** Parse the keeper's stdout for the strict JSON result block. Returns
 *  null if no parseable block is found — caller should treat that as a
 *  hard failure (the keeper drifted off-spec). */
export function parseKeeperResult(output: string): KeeperFixResult | null {
	// Match the LAST ```json ... ``` block in the output (in case the
	// keeper narrated intermediate steps with smaller JSON fragments).
	const matches = [...output.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
	if (matches.length === 0) return null;

	for (let i = matches.length - 1; i >= 0; i--) {
		try {
			const parsed = JSON.parse(matches[i][1]);
			if (
				typeof parsed !== 'object' ||
				parsed === null ||
				!Array.isArray(parsed.fixed) ||
				!Array.isArray(parsed.ambiguous) ||
				!Array.isArray(parsed.unresolvable)
			) {
				continue;
			}
			return parsed as KeeperFixResult;
		} catch {
			continue;
		}
	}
	return null;
}

/** Format the result into a Telegram message body. Truncates long lists
 *  with `+N more` so the message fits comfortably under Telegram's 4096-
 *  char limit. */
export function formatTelegramResult(
	result: KeeperFixResult,
	totalRequested: number,
): string {
	const lines: string[] = [];
	const fixedCount = result.fixed.length;
	const ambCount = result.ambiguous.length;
	const unrCount = result.unresolvable.length;

	lines.push(
		`✅ Keeper finished — ${fixedCount}/${totalRequested} fixed${
			ambCount + unrCount > 0
				? `, ${ambCount + unrCount} left for review`
				: ''
		}`,
	);

	if (fixedCount > 0) {
		lines.push('');
		lines.push(`🔧 Fixed (${fixedCount}):`);
		for (const f of result.fixed.slice(0, 8)) {
			const slug = basename(f.source);
			lines.push(`  • ${slug}: \`${f.oldRaw}\` → \`${f.newRaw}\``);
		}
		if (fixedCount > 8) lines.push(`  • …+${fixedCount - 8} more`);
	}

	if (ambCount > 0) {
		lines.push('');
		lines.push(`❓ Ambiguous (${ambCount}):`);
		for (const a of result.ambiguous.slice(0, 5)) {
			const slug = basename(a.source);
			const cands =
				a.candidates.length > 2
					? `${a.candidates.slice(0, 2).join(', ')} +${a.candidates.length - 2}`
					: a.candidates.join(', ');
			lines.push(`  • ${slug}: \`${a.raw}\` → ${cands}`);
		}
		if (ambCount > 5) lines.push(`  • …+${ambCount - 5} more`);
	}

	if (unrCount > 0) {
		lines.push('');
		lines.push(`🚫 Unresolvable (${unrCount}):`);
		for (const u of result.unresolvable.slice(0, 5)) {
			const slug = basename(u.source);
			const reason = u.reason ? ` — ${u.reason}` : '';
			lines.push(`  • ${slug}: \`${u.raw}\`${reason}`);
		}
		if (unrCount > 5) lines.push(`  • …+${unrCount - 5} more`);
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
