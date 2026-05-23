/** ADR-042 — Hygiene remediation actions (Step 1).
 *
 *  Pure functions that act on hygiene anomalies. Called from the
 *  Telegram callback handler (`callback.ts`) when the operator taps an
 *  inline button on a keeper escalation. No LLM in the path — the
 *  operator's intent is unambiguous, so we execute deterministically.
 *
 *  All three actions are reversible:
 *   - archiveProject  → `git revert` restores the folder + wikilinks
 *   - setPauseUntil   → re-edit the frontmatter to drop the field
 *   - suppressAnomaly → wipe the JSON file (or wait 30 days)
 */

import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const SUPPRESSIONS_PATH = join(homedir(), '.soul-hub', 'data', 'hygiene-suppressions.json');
const SUPPRESS_DAYS_DEFAULT = 30;
const PROJECT_SLUG_RX = /^[a-z][a-z0-9-]*$/;

export interface ActionResult {
	ok: boolean;
	error?: string;
	detail?: string;
}

interface Suppression {
	slug: string;
	bucket: string;
	until: string; // YYYY-MM-DD
}

/** Run a git command in the vault dir. Resolves with stdout on success,
 *  rejects with stderr-containing Error on non-zero exit. Mirrors the
 *  private helper in VaultCommitter — kept local rather than exported
 *  because the surface here is narrow. */
function runGit(vaultDir: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', ['-C', vaultDir, ...args], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => (stdout += c.toString()));
		child.stderr.on('data', (c) => (stderr += c.toString()));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
		});
	});
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/** Move `projects/<slug>` → `archive/<slug>`. Validates the slug,
 *  asserts the source has `status: archived` (defensive — caller
 *  should have verified), guards against archive-side collisions,
 *  and commits the move with a hygiene-attributed message. The
 *  vault watcher auto-rewrites stale wikilinks pointing at the old
 *  path. */
export async function archiveProject(slug: string, vaultDir: string): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug', detail: `slug must match ${PROJECT_SLUG_RX}` };
	}

	const src = join(vaultDir, 'projects', slug);
	const dst = join(vaultDir, 'archive', slug);
	const srcIndex = join(src, 'index.md');

	if (!(await pathExists(srcIndex))) {
		return { ok: false, error: 'not-found', detail: `projects/${slug}/index.md missing` };
	}
	if (await pathExists(dst)) {
		return { ok: false, error: 'collision', detail: `archive/${slug} already exists` };
	}

	const indexText = await readFile(srcIndex, 'utf-8');
	const statusMatch = indexText.match(/^status:\s*['"]?(\w+)['"]?\s*$/m);
	const status = statusMatch?.[1]?.toLowerCase() ?? '';
	if (status !== 'archived') {
		return {
			ok: false,
			error: 'wrong-status',
			detail: `project status is "${status}" — set to "archived" before moving`,
		};
	}

	try {
		await runGit(vaultDir, ['mv', `projects/${slug}`, `archive/${slug}`]);
		await runGit(vaultDir, [
			'commit',
			'-m',
			`vault(hygiene): archive ${slug} (ADR-042 inline action)`,
		]);
	} catch (err) {
		return {
			ok: false,
			error: 'git-failed',
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	return { ok: true, detail: `moved projects/${slug} → archive/${slug}` };
}

/** Flip the project's `status:` field to a new value. Used by the
 *  empty_stub button flow which needs to set `archived` before the
 *  archiveProject() status guard will pass. Returns ok with detail
 *  including the prior value so the caller can log it. */
export async function setProjectStatus(
	slug: string,
	newStatus: string,
	vaultDir: string,
): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug' };
	}
	if (!/^[a-z][a-z-]*$/.test(newStatus)) {
		return { ok: false, error: 'invalid-status' };
	}

	const idxPath = join(vaultDir, 'projects', slug, 'index.md');
	if (!(await pathExists(idxPath))) {
		return { ok: false, error: 'not-found' };
	}

	const original = await readFile(idxPath, 'utf-8');
	if (!original.startsWith('---')) {
		return { ok: false, error: 'no-frontmatter' };
	}
	const fmEnd = original.indexOf('\n---', 3);
	if (fmEnd === -1) {
		return { ok: false, error: 'malformed-frontmatter' };
	}
	const fmBlock = original.slice(0, fmEnd);
	const rest = original.slice(fmEnd);

	const priorMatch = fmBlock.match(/^status:\s*['"]?(\w+)['"]?\s*$/m);
	const prior = priorMatch?.[1] ?? null;

	let newFm: string;
	if (priorMatch) {
		newFm = fmBlock.replace(/^status:.*$/m, `status: ${newStatus}`);
	} else {
		newFm = fmBlock.replace(/\n$/, '') + `\nstatus: ${newStatus}`;
	}

	await writeFile(idxPath, newFm + rest, 'utf-8');
	return { ok: true, detail: `status ${prior ?? '(none)'} → ${newStatus}` };
}

/** Inject `pause_until: YYYY-MM-DD` into the project's index.md
 *  frontmatter. Replaces any existing pause_until. Caller passes an
 *  ISO date string. The vault watcher's commit picks the write up
 *  naturally — no explicit commit here. */
export async function setPauseUntil(
	slug: string,
	dateIso: string,
	vaultDir: string,
): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug' };
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
		return { ok: false, error: 'invalid-date', detail: 'expected YYYY-MM-DD' };
	}

	const idxPath = join(vaultDir, 'projects', slug, 'index.md');
	if (!(await pathExists(idxPath))) {
		return { ok: false, error: 'not-found', detail: `projects/${slug}/index.md missing` };
	}

	const original = await readFile(idxPath, 'utf-8');
	if (!original.startsWith('---')) {
		return { ok: false, error: 'no-frontmatter' };
	}
	const fmEnd = original.indexOf('\n---', 3);
	if (fmEnd === -1) {
		return { ok: false, error: 'malformed-frontmatter' };
	}

	const fmBlock = original.slice(0, fmEnd);
	const rest = original.slice(fmEnd);

	let newFm: string;
	if (/^pause_until:/m.test(fmBlock)) {
		newFm = fmBlock.replace(/^pause_until:.*$/m, `pause_until: '${dateIso}'`);
	} else {
		// Append at end of frontmatter block (before closing ---)
		newFm = fmBlock.replace(/\n$/, '') + `\npause_until: '${dateIso}'`;
	}

	await writeFile(idxPath, newFm + rest, 'utf-8');
	return { ok: true, detail: `\`pause_until\` set to ${dateIso}` };
}

/** Bump the project's `updated:` frontmatter field to today (YYYY-MM-DD).
 *  Used by the "🟢 Still active (touch)" button on stale_active_* — the
 *  operator is confirming the project really is active, just hasn't
 *  produced output recently. Writing `updated:` is more honest than
 *  artificially touching all .md files; the Python script's latest_mtime
 *  picks the index.md change up on its next walk. */
export async function touchProjectUpdated(
	slug: string,
	vaultDir: string,
): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug' };
	}
	const idxPath = join(vaultDir, 'projects', slug, 'index.md');
	if (!(await pathExists(idxPath))) {
		return { ok: false, error: 'not-found' };
	}
	const original = await readFile(idxPath, 'utf-8');
	if (!original.startsWith('---')) {
		return { ok: false, error: 'no-frontmatter' };
	}
	const fmEnd = original.indexOf('\n---', 3);
	if (fmEnd === -1) {
		return { ok: false, error: 'malformed-frontmatter' };
	}
	const fmBlock = original.slice(0, fmEnd);
	const rest = original.slice(fmEnd);
	const today = new Date().toISOString().slice(0, 10);
	let newFm: string;
	if (/^updated:/m.test(fmBlock)) {
		newFm = fmBlock.replace(/^updated:.*$/m, `updated: ${today}`);
	} else {
		newFm = fmBlock.replace(/\n$/, '') + `\nupdated: ${today}`;
	}
	await writeFile(idxPath, newFm + rest, 'utf-8');
	return { ok: true, detail: `updated → ${today}` };
}

/** Write a minimal stub `index.md` into `projects/<slug>/`. Used by the
 *  "📝 Scaffold stub" button on missing_index — fills the gap so the
 *  hygiene script's existing buckets can take it from there. Refuses
 *  to overwrite an existing file. */
export async function scaffoldProjectIndex(
	slug: string,
	vaultDir: string,
): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug' };
	}
	const dir = join(vaultDir, 'projects', slug);
	const idxPath = join(dir, 'index.md');
	if (await pathExists(idxPath)) {
		return { ok: false, error: 'already-exists' };
	}
	const today = new Date().toISOString().slice(0, 10);
	const stub =
		`---\n` +
		`type: index\n` +
		`status: active\n` +
		`project: ${slug}\n` +
		`created: ${today}\n` +
		`updated: ${today}\n` +
		`---\n\n` +
		`# ${slug}\n\n` +
		`> Scaffolded by ADR-042 hygiene button on ${today}. Fill in the sections below or archive the project.\n\n` +
		`## Decisions\n\n` +
		`## Learnings\n\n` +
		`## Debugging\n\n` +
		`## Outputs\n`;
	await mkdir(dir, { recursive: true });
	await writeFile(idxPath, stub, 'utf-8');
	return { ok: true, detail: `wrote ${idxPath}` };
}

/** Reconcile a dual-file status mismatch by copying the winner's
 *  `status:` value into the loser's file. Both `projects/<slug>/index.md`
 *  and `projects/<slug>/project.md` must exist (the bucket implies it).
 *  `winner` selects which file is the source of truth; the OTHER file
 *  gets rewritten. Returns the prior → new value in `detail` so the
 *  callback handler can render it. */
export async function reconcileDualStatus(
	slug: string,
	winner: 'index' | 'project',
	vaultDir: string,
): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug' };
	}
	const indexPath = join(vaultDir, 'projects', slug, 'index.md');
	const projectPath = join(vaultDir, 'projects', slug, 'project.md');
	if (!(await pathExists(indexPath))) {
		return { ok: false, error: 'not-found', detail: `projects/${slug}/index.md missing` };
	}
	if (!(await pathExists(projectPath))) {
		return { ok: false, error: 'not-found', detail: `projects/${slug}/project.md missing` };
	}
	const winnerPath = winner === 'index' ? indexPath : projectPath;
	const loserPath = winner === 'index' ? projectPath : indexPath;
	const winnerText = await readFile(winnerPath, 'utf-8');
	const winnerStatus = winnerText.match(/^status:\s*['"]?(\w+)['"]?\s*$/m)?.[1];
	if (!winnerStatus) {
		return { ok: false, error: 'no-source-status', detail: `${winner}.md has no status` };
	}
	const loserText = await readFile(loserPath, 'utf-8');
	if (!loserText.startsWith('---')) {
		return { ok: false, error: 'no-frontmatter' };
	}
	const fmEnd = loserText.indexOf('\n---', 3);
	if (fmEnd === -1) {
		return { ok: false, error: 'malformed-frontmatter' };
	}
	const fmBlock = loserText.slice(0, fmEnd);
	const rest = loserText.slice(fmEnd);
	const priorStatus = fmBlock.match(/^status:\s*['"]?(\w+)['"]?\s*$/m)?.[1] ?? '(none)';
	let newFm: string;
	if (/^status:/m.test(fmBlock)) {
		newFm = fmBlock.replace(/^status:.*$/m, `status: ${winnerStatus}`);
	} else {
		newFm = fmBlock.replace(/\n$/, '') + `\nstatus: ${winnerStatus}`;
	}
	await writeFile(loserPath, newFm + rest, 'utf-8');
	const loserName = winner === 'index' ? 'project.md' : 'index.md';
	return {
		ok: true,
		detail: `${loserName} status ${priorStatus} → ${winnerStatus} (matched ${winner}.md)`,
	};
}

/** Write or replace `review_date: YYYY-MM-DD` in the project index.md
 *  frontmatter. Used by `hyg-snooze` and `hyg-reviewed` on the
 *  falsifier_due_soon bucket. */
export async function setReviewDate(
	slug: string,
	dateIso: string,
	vaultDir: string,
): Promise<ActionResult> {
	if (!PROJECT_SLUG_RX.test(slug)) {
		return { ok: false, error: 'invalid-slug' };
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
		return { ok: false, error: 'invalid-date', detail: 'expected YYYY-MM-DD' };
	}
	const idxPath = join(vaultDir, 'projects', slug, 'index.md');
	if (!(await pathExists(idxPath))) {
		return { ok: false, error: 'not-found' };
	}
	const original = await readFile(idxPath, 'utf-8');
	if (!original.startsWith('---')) {
		return { ok: false, error: 'no-frontmatter' };
	}
	const fmEnd = original.indexOf('\n---', 3);
	if (fmEnd === -1) {
		return { ok: false, error: 'malformed-frontmatter' };
	}
	const fmBlock = original.slice(0, fmEnd);
	const rest = original.slice(fmEnd);
	const prior = fmBlock.match(/^review_date:\s*['"]?([\d-]+)['"]?\s*$/m)?.[1] ?? '(none)';
	let newFm: string;
	if (/^review_date:/m.test(fmBlock)) {
		newFm = fmBlock.replace(/^review_date:.*$/m, `review_date: '${dateIso}'`);
	} else {
		newFm = fmBlock.replace(/\n$/, '') + `\nreview_date: '${dateIso}'`;
	}
	await writeFile(idxPath, newFm + rest, 'utf-8');
	// Wrap the field name in backticks so callers rendering the detail
	// through Telegram Markdown don't interpret the underscore as italic.
	return { ok: true, detail: `\`review_date\` ${prior} → ${dateIso}` };
}

/** Suppress an anomaly bucket for this slug for `days` days. Writes to
 *  ~/.soul-hub/data/hygiene-suppressions.json — cross-language readable
 *  so the Python project_hygiene.py script can skip suppressed entries
 *  on its next run. Existing suppression for the same (slug,bucket)
 *  is replaced. */
export async function suppressAnomaly(
	slug: string,
	bucket: string,
	days = SUPPRESS_DAYS_DEFAULT,
): Promise<ActionResult> {
	// ADR-043 relaxed the slug check from project-slug regex to a length-
	// bounded, control-char-free string. Vault-hygiene composite keys
	// (`source::[[target]]`) need to fit here too. We still want a sane cap
	// to keep the JSON file from accumulating arbitrarily large entries.
	if (!slug || slug.length === 0 || slug.length > 400 || /[\x00-\x1f]/.test(slug)) {
		return { ok: false, error: 'invalid-key' };
	}
	if (!/^[a-z_]+$/.test(bucket)) {
		return { ok: false, error: 'invalid-bucket' };
	}

	const untilMs = Date.now() + days * 86400 * 1000;
	const until = new Date(untilMs).toISOString().slice(0, 10); // YYYY-MM-DD

	let suppressions: Suppression[] = [];
	if (await pathExists(SUPPRESSIONS_PATH)) {
		try {
			const text = await readFile(SUPPRESSIONS_PATH, 'utf-8');
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed)) suppressions = parsed;
		} catch {
			// Corrupt file — overwrite with fresh state. The cost of losing
			// prior suppressions is bounded (they'll re-fire on next run).
			suppressions = [];
		}
	}

	suppressions = suppressions.filter((s) => !(s.slug === slug && s.bucket === bucket));
	suppressions.push({ slug, bucket, until });

	await mkdir(dirname(SUPPRESSIONS_PATH), { recursive: true });
	await writeFile(SUPPRESSIONS_PATH, JSON.stringify(suppressions, null, 2) + '\n', 'utf-8');

	return { ok: true, detail: `suppressed ${slug}:${bucket} until ${until}` };
}
