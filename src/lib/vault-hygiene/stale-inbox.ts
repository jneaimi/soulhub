/** Stale-inbox detection.
 *
 *  Per `~/vault/CLAUDE.md`, the `inbox/` zone is exempt from orphan
 *  checks — quick captures aren't expected to link anywhere. But notes
 *  that sit in `inbox/` past `thresholdDays` are stale: the user dropped
 *  them without filing. Keeper's job: file by frontmatter type when the
 *  zone is unambiguous (per ADR-010 auto-fix scope), escalate otherwise.
 *
 *  We use file mtime (not frontmatter `created`) because Obsidian users
 *  routinely tweak frontmatter without intending to refile. mtime is the
 *  honest "when did this last move?" signal. */

import type { VaultEngine } from '../vault/index.js';
import type { StaleInboxIssue } from './types.js';

const DEFAULT_THRESHOLD_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getStaleInbox(
	engine: VaultEngine,
	thresholdDays: number = DEFAULT_THRESHOLD_DAYS,
): StaleInboxIssue[] {
	const cutoff = Date.now() - thresholdDays * MS_PER_DAY;
	const stats = engine.getStats();
	const issues: StaleInboxIssue[] = [];

	// One pass over all VaultNotes (full objects with mtime); cheaper than
	// going through the search index + a per-result `getNote` lookup.
	const all = engine.getRecent(stats.totalNotes);
	for (const note of all) {
		if (note.path.split('/')[0] !== 'inbox') continue;
		// inbox/index.md and zone-CLAUDE.md never go stale themselves.
		if (note.path.endsWith('/index.md') || note.path === 'inbox/index.md') continue;
		if (note.mtime > cutoff) continue;

		const ageDays = Math.floor((Date.now() - note.mtime) / MS_PER_DAY);
		const type = typeof note.meta.type === 'string' ? note.meta.type : null;
		issues.push({
			path: note.path,
			title: note.title,
			ageDays,
			suggestedFix: suggestFix(type, ageDays),
		});
	}

	// Oldest first — keeper triages high-age items first.
	issues.sort((a, b) => b.ageDays - a.ageDays);
	return issues;
}

function suggestFix(type: string | null, ageDays: number): string {
	if (!type) {
		return `${ageDays}d in inbox with no \`type\` frontmatter — needs human review (read + classify).`;
	}
	const dest = zoneForType(type);
	if (dest) {
		return `${ageDays}d in inbox; type=\`${type}\` → file to \`${dest}/\`.`;
	}
	return `${ageDays}d in inbox; type=\`${type}\` doesn't map to a known zone — needs human review.`;
}

/** Map note type → destination zone. Mirrors the keeper agent's existing
 *  rules for the most common types. Unknowns return null (human review). */
function zoneForType(type: string): string | null {
	switch (type) {
		case 'learning':
			return 'knowledge/learnings';
		case 'pattern':
			return 'knowledge/patterns';
		case 'snippet':
			return 'knowledge/snippets';
		case 'debugging':
			return 'knowledge/debugging';
		case 'recipe':
			return 'knowledge/cooking/recipes';
		case 'project':
			return 'projects';
		case 'decision':
			return 'projects';
		case 'research':
			return 'knowledge/research';
		default:
			return null;
	}
}
