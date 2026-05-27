/** ADR implementation drift detector — flags ADRs whose status is still
 *  `proposed` or `accepted` but whose slug appears in a merge commit on `main`.
 *
 *  Soul-hub-hygiene ADR-009.  Third sibling to:
 *    - `adr-status-drift.ts`    — FM status vs body Status section
 *    - `status-contradictions.ts` — done status + open task lines
 *
 *  This detector closes the blind spot those two miss: an ADR can have no
 *  internal contradiction (frontmatter + body both say `proposed`) while the
 *  code it describes has already shipped and been merged to `main`.
 *
 *  Detection strategy (D1):
 *    For each `type: decision` note with `proposed` or `accepted` status,
 *    run a single bounded `git log main --oneline` against the soul-hub repo
 *    (bounded to the ADR's `created` date) and check whether any commit
 *    subject references the ADR's file-slug.  Our agentic loop produces merge
 *    commits whose subject contains the branch name, which contains the ADR
 *    slug — e.g.
 *       `Merge branch 'orchestration/run-…/adr-009-adr-status-reflects-merge'`
 *
 *  Detect-only (per ADR-024 D3): raises issues for the dashboard, never
 *  auto-ships.  Multi-phase ADRs (a merge means *some* code landed, not
 *  *every* phase) must be judged by the operator; the "Not yet" dismiss
 *  handles the multi-phase case. */

import { spawn } from 'node:child_process';
import type { VaultEngine } from '../vault/index.js';
import { isCanonicalStatus } from './parse-body-status.js';

export interface AdrImplementationDriftIssue {
	path: string;
	project: string | null;
	/** Vault-relative slug (file stem, no `.md`). */
	slug: string;
	currentStatus: 'proposed' | 'accepted';
	/** First matching commit line from git log (capped at 120 chars). */
	mergeEvidence: string;
}

/** Only these two statuses can transition to `shipped`. Terminal statuses
 *  (`parked`, `rejected`, `superseded`) and the final state (`shipped`)
 *  are excluded by design. */
const OPEN_STATUSES = new Set<string>(['proposed', 'accepted']);

/** ADR filenames always start with `adr-` (canonical naming convention).
 *  Non-ADR decision notes (e.g. meeting minutes) are skipped — their file
 *  stems are generic words that would produce false positives. */
const ADR_FILENAME_RE = /^adr-\d+/;

/** Run `git -C dir log main --oneline [extraArgs]` and return stdout.
 *  Returns an empty string on any failure (branch missing, not a git repo,
 *  git not installed) so the caller treats no-evidence = no issue. */
function runGitLogOneline(dir: string, extraArgs: string[]): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn('git', ['-C', dir, 'log', 'main', '--oneline', ...extraArgs], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (c: Buffer) => (out += c.toString()));
		child.on('error', () => resolve(''));
		child.on('close', () => resolve(out)); // tolerate non-zero (missing branch, etc.)
	});
}

/** Resolve the soul-hub repo root.  Mirrors `contracts/registry.ts` so
 *  both use the same override path in atypical layouts / tests. */
function repoRoot(): string {
	return process.env.SOUL_HUB_REPO ?? process.cwd();
}

/** Detect ADRs whose slug appears in a `git log main` commit but whose
 *  status is still `proposed` or `accepted`.
 *
 *  One git call per invocation — we find the earliest candidate's `created`
 *  date to bound the log, then check every candidate against the combined
 *  output.  O(n_adrs + n_commits × n_adrs) in the worst case, but in
 *  practice the bounded log is short and the ADR list is small (tens). */
export async function getAdrImplementationDrift(
	engine: VaultEngine,
): Promise<AdrImplementationDriftIssue[]> {
	const stats = engine.getStats();
	if (stats.totalNotes === 0) return [];

	const notes = engine.getRecent(stats.totalNotes);

	// Collect candidates: open-status decision notes that look like ADR files.
	const candidates = notes.filter((note) => {
		if (note.meta.type !== 'decision') return false;
		if (note.path.startsWith('archive/')) return false;
		const rawStatus = typeof note.meta.status === 'string' ? note.meta.status : null;
		if (!rawStatus || !OPEN_STATUSES.has(rawStatus)) return false;
		if (!isCanonicalStatus(rawStatus)) return false;
		// Only check files that follow the `adr-NNN-…` naming convention.
		const filename = note.path.split('/').pop() ?? '';
		return ADR_FILENAME_RE.test(filename);
	});

	if (candidates.length === 0) return [];

	// Find the earliest `created` date to bound the git log query.
	// Reduces false positives from ancient commits that happen to share words.
	let since: string | null = null;
	for (const note of candidates) {
		const created = typeof note.meta.created === 'string' ? note.meta.created : null;
		if (created && (!since || created < since)) since = created;
	}

	const repo = repoRoot();
	const extraArgs: string[] = since ? [`--since=${since}`] : [];
	const logOutput = await runGitLogOneline(repo, extraArgs);
	if (!logOutput.trim()) return [];

	const logLines = logOutput.split('\n').filter(Boolean);
	const issues: AdrImplementationDriftIssue[] = [];

	for (const note of candidates) {
		const filename = note.path.split('/').pop() ?? '';
		const slug = filename.replace(/\.md$/, '');
		if (!slug) continue;

		// Check whether any commit line mentions the slug.
		const match = logLines.find((line) => line.includes(slug));
		if (!match) continue;

		issues.push({
			path: note.path,
			project: typeof note.meta.project === 'string' ? note.meta.project : null,
			slug,
			currentStatus: (note.meta.status as string).trim() as 'proposed' | 'accepted',
			mergeEvidence: match.slice(0, 120),
		});
	}

	return issues;
}

/** Group issues by project for digest formatting.  Insertion order is
 *  alphabetical — same helper shape as `adr-status-drift.ts`. */
export function groupByProject(
	issues: AdrImplementationDriftIssue[],
): Map<string, AdrImplementationDriftIssue[]> {
	const groups = new Map<string, AdrImplementationDriftIssue[]>();
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
