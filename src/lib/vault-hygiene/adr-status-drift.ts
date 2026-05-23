/** ADR status drift check — flags ADRs whose frontmatter `status` is
 *  out of sync with what the body's `## Status` section claims.
 *
 *  Per `~/vault/projects/soul-hub/decisions/2026-05-18-adr-status-body-frontmatter-consistency.md`.
 *
 *  Sibling to `status-contradictions.ts` (which catches a different
 *  contradiction shape — completed-status + open task lines). Both are
 *  detect-only; neither auto-fixes, because the drift direction tells
 *  you which side is stale but not which side is correct. */

import type { VaultEngine } from '../vault/index.js';
import {
	compareStatuses,
	isCanonicalStatus,
	parseBodyStatus,
	type CanonicalStatus,
} from './parse-body-status.js';

/** Terminal statuses — once an ADR is here, the body's earlier active-
 *  ladder declaration is historically accurate, not drift. An ADR is
 *  *proposed → accepted → shipped*, then later *parked / rejected /
 *  superseded*. The body's `**Proposed 2026-MM-DD**` line documents
 *  where the ADR started; FM's `parked` documents where it ended up.
 *  Both are correct — no drift. */
const TERMINAL_STATUSES = new Set<CanonicalStatus>(['parked', 'rejected', 'superseded']);
const ACTIVE_LADDER = new Set<CanonicalStatus>(['proposed', 'accepted', 'shipped']);

export interface AdrStatusDriftIssue {
	path: string;
	project: string | null;
	fmStatus: CanonicalStatus;
	bodyStatus: CanonicalStatus;
	direction: 'body-ahead' | 'fm-ahead' | 'sideways';
	/** Bold span from the body that surfaced the drift. */
	evidence: string;
}

export function getAdrStatusDrift(engine: VaultEngine): AdrStatusDriftIssue[] {
	const issues: AdrStatusDriftIssue[] = [];

	// Walk every indexed note. `getRecent(totalNotes)` returns the full
	// VaultNote (with content + meta) in one pass — same pattern
	// `status-contradictions.ts` uses, avoids per-note round trips.
	const stats = engine.getStats();
	if (stats.totalNotes === 0) return issues;
	const notes = engine.getRecent(stats.totalNotes);

	for (const note of notes) {
		// Only check ADRs. `type: decision` is the canonical marker
		// used by the project-phases tree + the /projects API.
		if (note.meta.type !== 'decision') continue;

		// Skip archived copies — they keep their original `project`
		// frontmatter after a /vault DELETE move, so without this filter
		// the digest would re-surface every migration's historical
		// originals alongside the live versions.
		if (note.path.startsWith('archive/')) continue;

		const rawFmStatus = typeof note.meta.status === 'string' ? note.meta.status : null;
		if (!rawFmStatus || !isCanonicalStatus(rawFmStatus)) {
			// Bad / missing status is the canonical-status enforcement's
			// job (`governance.ts`), not ours. Skip silently.
			continue;
		}

		const parsed = parseBodyStatus(note.content);
		if (!parsed) {
			// No structured body status — older ADRs without a
			// `## Status` section. Not drift, just unstructured.
			continue;
		}

		const direction = compareStatuses(rawFmStatus, parsed.status);
		if (direction === 'match') continue;

		// Skip terminal-state-FM + active-body combinations. The body's
		// active-ladder declaration is historically accurate (the ADR
		// was proposed/accepted/shipped before the operator parked /
		// rejected / superseded it). Not drift.
		if (TERMINAL_STATUSES.has(rawFmStatus) && ACTIVE_LADDER.has(parsed.status)) {
			continue;
		}

		issues.push({
			path: note.path,
			project: typeof note.meta.project === 'string' ? note.meta.project : null,
			fmStatus: rawFmStatus,
			bodyStatus: parsed.status,
			direction,
			evidence: parsed.evidence,
		});
	}

	return issues;
}

/** Group issues by project for digest formatting. Returns a Map so
 *  iteration order is insertion-stable (alphabetical). */
export function groupByProject(
	issues: AdrStatusDriftIssue[],
): Map<string, AdrStatusDriftIssue[]> {
	const groups = new Map<string, AdrStatusDriftIssue[]>();
	const sorted = [...issues].sort((a, b) => {
		const pa = a.project ?? '~~unprojected';
		const pb = b.project ?? '~~unprojected';
		if (pa !== pb) return pa.localeCompare(pb);
		return a.path.localeCompare(b.path);
	});
	for (const issue of sorted) {
		const key = issue.project ?? '(no-project)';
		const bucket = groups.get(key);
		if (bucket) bucket.push(issue);
		else groups.set(key, [issue]);
	}
	return groups;
}
