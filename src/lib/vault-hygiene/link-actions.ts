/** ADR-043 — Vault-hygiene note-level remediation actions.
 *
 *  Pure functions called from the Telegram callback handler when the
 *  operator taps a vault-hygiene button. Three buckets are wired:
 *
 *  - `unresolved` (broken wikilink) → `unlinkBrokenWikilink` rewrites
 *    `[[target]]` to its display text in the source file. Reversible
 *    via the vault watcher's commit.
 *  - `orphan_note`                  → `archiveOrphanNote` git-mv's the
 *    note to `archive/<original-path>` + commits. Reversible via
 *    `git revert`.
 *  - `stale_inbox_item`             → `dropStaleInboxItem` git-rm's
 *    the inbox note + commits. Reversible via `git checkout`.
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

export interface LinkActionResult {
	ok: boolean;
	error?: string;
	detail?: string;
}

/** Default display text for a wikilink target with no alias.
 *  `path/to/slug` → "slug", `slug#heading` → "slug". */
export function defaultDisplayFor(target: string): string {
	const lastSeg = target.split('/').pop() ?? target;
	const noAnchor = lastSeg.split('#')[0];
	return noAnchor || target;
}

/** Escape a string for use in a `RegExp` body. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrite all occurrences of the broken wikilink in `source` to its
 *  display text (alias if the link has one, else the last segment of the
 *  target). `target` is the INNER wikilink text matching `UnresolvedIssue.raw`
 *  — e.g. `projects/foo/index` for a link written as `[[projects/foo/index]]`
 *  or `[[projects/foo/index|Foo]]`. */
export async function unlinkBrokenWikilink(
	source: string,
	target: string,
	vaultDir: string,
): Promise<LinkActionResult> {
	// Path safety — `source` comes from getHygieneReport() but we still
	// guard against absolute paths or traversal escaping the vault.
	if (!source || source.startsWith('/') || source.includes('..')) {
		return { ok: false, error: 'invalid-source' };
	}
	if (!target || target.includes('[[') || target.includes(']]')) {
		// We expect inner text, not the bracketed form. Reject either to
		// avoid the caller passing the wrong shape and producing a no-op.
		return { ok: false, error: 'invalid-target', detail: `target=${target}` };
	}

	const fullPath = join(vaultDir, source);
	try {
		await access(fullPath);
	} catch {
		return { ok: false, error: 'not-found', detail: `${source} missing` };
	}

	const original = await readFile(fullPath, 'utf-8');
	const wikiRegex = new RegExp(
		`\\[\\[${escapeRegex(target)}(?:\\|([^\\]]+))?\\]\\]`,
		'g',
	);
	let count = 0;
	const rewritten = original.replace(wikiRegex, (_match, alias) => {
		count++;
		if (alias) return alias.trim();
		return defaultDisplayFor(target);
	});

	if (count === 0) {
		return { ok: false, error: 'wikilink-not-found' };
	}

	await writeFile(fullPath, rewritten, 'utf-8');
	return {
		ok: true,
		detail: `replaced ${count} × \`[[${target}...]]\` in ${source}`,
	};
}

/** Run a git command in the vault dir. Same shape as the helper in
 *  `actions.ts` — we copy it here to keep this module's dependencies
 *  narrow. Resolves with stdout on success, rejects with stderr-bearing
 *  Error on non-zero exit. */
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

/** Validate that a vault-relative note path is safe to operate on:
 *  no absolute prefix, no `..` traversal, must end in `.md`. */
function isSafeNotePath(p: string): boolean {
	if (!p) return false;
	if (p.startsWith('/')) return false;
	if (p.split('/').some((seg) => seg === '..' || seg === '.')) return false;
	if (!p.endsWith('.md')) return false;
	return true;
}

/** Move an orphan note to `archive/<original-path>` and commit. Preserves
 *  the original zone structure under archive/ so a future revert can put
 *  the note back exactly where it came from. Refuses to archive a zone
 *  `index.md` — those are structural and should never be classified as
 *  orphans (the detector exempts inbox/archive but doesn't catch all
 *  edge cases). */
export async function archiveOrphanNote(
	notePath: string,
	vaultDir: string,
): Promise<LinkActionResult> {
	if (!isSafeNotePath(notePath)) {
		return { ok: false, error: 'invalid-path' };
	}
	if (notePath.endsWith('/index.md') || notePath === 'index.md') {
		return { ok: false, error: 'refuse-index', detail: `won't archive ${notePath}` };
	}
	if (notePath.startsWith('archive/')) {
		return { ok: false, error: 'already-archived' };
	}

	const src = join(vaultDir, notePath);
	const dstRel = `archive/${notePath}`;
	const dst = join(vaultDir, dstRel);

	try {
		await access(src);
	} catch {
		return { ok: false, error: 'not-found', detail: `${notePath} missing` };
	}
	try {
		await access(dst);
		return { ok: false, error: 'collision', detail: `${dstRel} already exists` };
	} catch {
		/* expected — destination should not exist */
	}

	try {
		// Ensure destination parent dir exists; git mv will create it but
		// only if it's one level deep. For nested paths, mkdir -p first.
		await runGit(vaultDir, ['ls-files']); // sanity check vault is a git repo
		const { mkdir } = await import('node:fs/promises');
		await mkdir(dirname(dst), { recursive: true });
		await runGit(vaultDir, ['mv', notePath, dstRel]);
		await runGit(vaultDir, [
			'commit',
			'-m',
			`vault(hygiene): archive orphan ${notePath} (ADR-043 inline action)`,
		]);
	} catch (err) {
		return {
			ok: false,
			error: 'git-failed',
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	return { ok: true, detail: `moved ${notePath} → ${dstRel}` };
}

/** `git rm` a stale inbox note + commit. Reversible via
 *  `git checkout HEAD~1 -- <path>`. Refuses anything outside `inbox/`
 *  and any `index.md` (the inbox zone-index is structural). */
export async function dropStaleInboxItem(
	notePath: string,
	vaultDir: string,
): Promise<LinkActionResult> {
	if (!isSafeNotePath(notePath)) {
		return { ok: false, error: 'invalid-path' };
	}
	if (!notePath.startsWith('inbox/')) {
		return { ok: false, error: 'not-in-inbox', detail: `${notePath} is outside inbox/` };
	}
	if (notePath.endsWith('/index.md') || notePath === 'inbox/index.md') {
		return { ok: false, error: 'refuse-index' };
	}

	const src = join(vaultDir, notePath);
	try {
		await access(src);
	} catch {
		return { ok: false, error: 'not-found', detail: `${notePath} missing` };
	}

	try {
		await runGit(vaultDir, ['rm', notePath]);
		await runGit(vaultDir, [
			'commit',
			'-m',
			`vault(hygiene): drop stale inbox ${notePath} (ADR-043 inline action)`,
		]);
	} catch (err) {
		return {
			ok: false,
			error: 'git-failed',
			detail: err instanceof Error ? err.message : String(err),
		};
	}

	return { ok: true, detail: `removed ${notePath}` };
}
