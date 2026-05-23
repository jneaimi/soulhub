/** Status contradictions — notes whose frontmatter says they're done
 *  but whose body still has open task lines.
 *
 *  Examples we look for:
 *    status: completed   + body line `- [ ] thing`
 *    status: done        + body line `- [ ] thing`
 *    status: archived    + body line `- [ ] thing`
 *
 *  These are NEVER auto-fixed (per ADR-010 — the contradiction could
 *  resolve either way: maybe the status is wrong, maybe the body is
 *  stale). Keeper escalates them to the user for a judgment call. */

import type { VaultEngine } from '../vault/index.js';
import type { StatusContradictionIssue } from './types.js';

const COMPLETED_STATUSES = new Set(['completed', 'done', 'archived', 'closed', 'shipped']);
const OPEN_TASK_RE = /^[ \t]*[-*+] \[ \]/gm;

export function getStatusContradictions(engine: VaultEngine): StatusContradictionIssue[] {
	const issues: StatusContradictionIssue[] = [];

	// Walk every indexed note that has a status. Cheap — ~1500 notes and
	// the regex is bounded per body. `getRecent(limit)` returns the full
	// VaultNote (with content), avoiding a per-note `getNote` round trip.
	const stats = engine.getStats();
	const indexed = stats.totalNotes;
	if (indexed === 0) return issues;

	const notes = engine.getRecent(indexed);
	for (const note of notes) {
		const status = typeof note.meta.status === 'string' ? note.meta.status.toLowerCase() : null;
		if (!status || !COMPLETED_STATUSES.has(status)) continue;

		const matches = note.content.match(OPEN_TASK_RE);
		const openTaskCount = matches ? matches.length : 0;
		if (openTaskCount === 0) continue;

		issues.push({
			path: note.path,
			status,
			openTaskCount,
			suggestedFix:
				`status=\`${status}\` but ${openTaskCount} open \`[ ]\` task(s) remain. ` +
				'Human review: either flip status back to in-progress, or close out the tasks.',
		});
	}

	return issues;
}
