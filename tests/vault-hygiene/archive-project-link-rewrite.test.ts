/** ADR-042 retro-fix — archiveProject inbound link-rewrite tests.
 *
 *  Verifies that `archiveProject(slug, vaultDir)` rewrites every inbound
 *  wikilink pointing at a note inside `projects/<slug>/` so it instead
 *  points at `archive/<slug>/…` after the git mv.
 *
 *  Happy path:
 *    • A note outside the project that links to `projects/foo/index` gets
 *      its link rewritten to `archive/foo/index` and the change is
 *      committed (second commit after the mv commit).
 *
 *  Sad path:
 *    • When there are NO inbound links to any note in the moved tree, only
 *      the mv commit is made (no second rewrite commit).
 *    • Invalid slug, wrong status, and collision guards still fire as before.
 *
 *  Integration note:
 *    `archiveProject` calls `getVaultEngine()` for the link-capture phase.
 *    We initialise a real vault engine in `before()` so the singleton is set.
 *    Each `describe` block that mutates the vault uses its OWN temp dir — the
 *    vault-engine singleton only needs to be alive during the `archiveProject`
 *    call (it reads the index; it does not keep watching the temp dir after
 *    the test tears it down).
 *
 *  Run:
 *    node --import ./tests/vault-hygiene/register.mjs \
 *         --test --experimental-strip-types \
 *         tests/vault-hygiene/archive-project-link-rewrite.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Git helper ────────────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd });
	return stdout.trim();
}

/** Initialise a bare git repo with an initial empty commit in `dir`.
 *  Configures local user.email / user.name and disables GPG signing so the
 *  test works on CI machines without a keychain. */
async function initGitRepo(dir: string): Promise<void> {
	await git(['init', '-b', 'main'], dir);
	await git(['config', 'user.email', 'test@soul-hub.test'], dir);
	await git(['config', 'user.name', 'Soul Hub Test'], dir);
	await git(['config', 'commit.gpgsign', 'false'], dir);
}

/** Stage all pending changes and make a commit. */
async function commitAll(dir: string, message: string): Promise<void> {
	await git(['add', '-A'], dir);
	await git(['commit', '-m', message], dir);
}

/** Return the number of commits in the repo (HEAD~count reachable). */
async function commitCount(dir: string): Promise<number> {
	const out = await git(['rev-list', '--count', 'HEAD'], dir);
	return parseInt(out, 10);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimum frontmatter for a note to pass vault governance. */
function noteMd(title: string, status?: string, body = ''): string {
	const fm = [
		'---',
		'type: index',
		'created: "2026-01-01"',
		'tags: [test]',
		status ? `status: ${status}` : null,
		'---',
	]
		.filter(Boolean)
		.join('\n');
	return `${fm}\n\n# ${title}\n${body}\n`;
}

// ── Shared vault engine ───────────────────────────────────────────────────────
//
// `initVault` is a singleton inside vault/index.ts (`if (engine) return engine`).
// We initialise ONE engine per process on a throw-away vault dir.  The engine
// does not need to track the ACTUAL test vault — we only call `initVault` so that
// `getVaultEngine()` (called inside `archiveProject`) returns a non-null engine.
// The test vault's notes are indexed into the engine's in-memory state by
// calling `eng.getAllNotes()` internally; the key is that the engine is alive
// when `archiveProject` runs.
//
// For the happy-path test we ALSO need the engine's INDEX to reflect the test
// vault's notes so that the link-capture phase finds inbound links.  We do this
// by using the engine's own vault dir as the test vault — i.e., the test vault
// IS the engine vault.  For sad-path and guard tests that don't need link
// rewrites, this doesn't matter.

let engineVaultDir = '';
let engineShutdown: (() => void) | undefined;

before(async () => {
	// Set up the vault dir used by the shared engine.
	engineVaultDir = await mkdtemp(join(tmpdir(), 'soul-hub-archive-eng-'));
	await mkdir(join(engineVaultDir, '.vault', 'templates'), { recursive: true });
	await mkdir(join(engineVaultDir, 'projects'), { recursive: true });
	await mkdir(join(engineVaultDir, 'archive'), { recursive: true });
	await mkdir(join(engineVaultDir, 'knowledge'), { recursive: true });

	const { initVault } = await import('../../src/lib/vault/index.ts');
	const eng = await initVault(engineVaultDir);
	engineShutdown = () => eng.shutdown();
});

after(async () => {
	engineShutdown?.();
	if (engineVaultDir) await rm(engineVaultDir, { recursive: true, force: true });
});

// ── Happy path: inbound links are rewritten ───────────────────────────────────

describe('archiveProject — happy path: inbound wikilink rewritten', () => {
	let vault = '';

	before(async () => {
		// We use the ENGINE's own vault dir as the test vault so the engine's
		// index and resolver already know about the notes.
		vault = engineVaultDir;

		// Create the project being archived.
		await mkdir(join(vault, 'projects', 'foo'), { recursive: true });
		await writeFile(
			join(vault, 'projects', 'foo', 'index.md'),
			noteMd('Foo Project', 'archived'),
			'utf-8',
		);

		// A note outside the project that links to it.
		await writeFile(
			join(vault, 'knowledge', 'linker.md'),
			noteMd('Linker', undefined, 'See [[projects/foo/index]] for details.\n'),
			'utf-8',
		);

		// Initialise git and make the first commit (all files tracked).
		await initGitRepo(vault);
		await commitAll(vault, 'initial: add project + linker');

		// Trigger a re-index so the engine knows about the new files.
		const { initVault } = await import('../../src/lib/vault/index.ts');
		const eng = await initVault(vault); // returns existing singleton
		await eng.reindex();
	});

	after(async () => {
		// Clean up files added by this block (leaving the vault dir itself
		// for other tests; `before` at the top level tears it down).
		await rm(join(vault, 'projects', 'foo'), { recursive: true, force: true }).catch(() => {});
		await rm(join(vault, 'archive', 'foo'), { recursive: true, force: true }).catch(() => {});
		await rm(join(vault, 'knowledge', 'linker.md'), { force: true }).catch(() => {});
		// Reset git to initial state is not needed; each test uses its own
		// vault root dir in the guard/sad-path suites below.
	});

	test('archiveProject returns ok:true', async () => {
		const { archiveProject } = await import('../../src/lib/vault-hygiene/actions.ts');
		const result = await archiveProject('foo', vault);
		assert.ok(result.ok, `expected ok:true, got error: ${result.error} — ${result.detail}`);
	});

	test('project directory moved to archive/foo', async () => {
		const { access } = await import('node:fs/promises');
		await assert.doesNotReject(
			access(join(vault, 'archive', 'foo', 'index.md')),
			'archive/foo/index.md should exist after archiving',
		);
	});

	test('projects/foo no longer exists', async () => {
		const { access } = await import('node:fs/promises');
		await assert.rejects(
			access(join(vault, 'projects', 'foo', 'index.md')),
			'projects/foo/index.md should be gone after archiving',
		);
	});

	test('linker note body rewritten: [[projects/foo/index]] → [[archive/foo/index]]', async () => {
		const body = await readFile(join(vault, 'knowledge', 'linker.md'), 'utf-8');
		assert.ok(
			body.includes('[[archive/foo/index]]') || body.includes('[[archive/foo/index|'),
			`linker.md should contain [[archive/foo/index]], got:\n${body}`,
		);
		assert.ok(
			!body.includes('[[projects/foo/index]]'),
			`linker.md should NOT contain the old [[projects/foo/index]] link`,
		);
	});

	test('a second commit (the rewrite commit) exists after the mv commit', async () => {
		// Expect: initial commit + mv commit + rewrite commit = 3
		const count = await commitCount(vault);
		assert.ok(
			count >= 3,
			`expected at least 3 commits (initial + mv + rewrite), found ${count}`,
		);
	});
});

// ── Sad path: no inbound links → no rewrite commit ───────────────────────────

describe('archiveProject — sad path: no inbound links → only mv commit', () => {
	let vault = '';

	before(async () => {
		vault = await mkdtemp(join(tmpdir(), 'soul-hub-archive-norewrite-'));
		await mkdir(join(vault, 'projects', 'solo'), { recursive: true });
		await mkdir(join(vault, 'archive'), { recursive: true });
		await mkdir(join(vault, '.vault', 'templates'), { recursive: true });

		// Project with no external inbound links.
		await writeFile(
			join(vault, 'projects', 'solo', 'index.md'),
			noteMd('Solo Project', 'archived'),
			'utf-8',
		);

		await initGitRepo(vault);
		await commitAll(vault, 'initial: add solo project');

		// Re-index the engine to pick up the solo project.
		const { initVault } = await import('../../src/lib/vault/index.ts');
		const eng = await initVault(vault);
		await eng.reindex();
	});

	after(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	test('archiveProject returns ok:true', async () => {
		const { archiveProject } = await import('../../src/lib/vault-hygiene/actions.ts');
		const result = await archiveProject('solo', vault);
		assert.ok(result.ok, `expected ok:true, got: ${result.error}`);
	});

	test('only 2 commits (initial + mv, no rewrite commit)', async () => {
		const count = await commitCount(vault);
		// initial commit + mv commit = 2; a rewrite commit would make it 3.
		assert.equal(count, 2, `expected exactly 2 commits, found ${count}`);
	});
});

// ── Guard tests (no git needed) ───────────────────────────────────────────────

describe('archiveProject — guard: invalid slug', () => {
	test('slug with uppercase rejected', async () => {
		const { archiveProject } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await archiveProject('FooBar', '/tmp/irrelevant');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'invalid-slug');
	});

	test('slug with spaces rejected', async () => {
		const { archiveProject } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await archiveProject('foo bar', '/tmp/irrelevant');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'invalid-slug');
	});
});

describe('archiveProject — guard: non-existent project', () => {
	let vault = '';

	before(async () => {
		vault = await mkdtemp(join(tmpdir(), 'soul-hub-archive-guards-'));
		await mkdir(join(vault, 'projects'), { recursive: true });
		await mkdir(join(vault, 'archive'), { recursive: true });
	});

	after(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	test('missing index.md returns not-found', async () => {
		const { archiveProject } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await archiveProject('nonexistent', vault);
		assert.equal(r.ok, false);
		assert.equal(r.error, 'not-found');
	});

	test('wrong status (active) returns wrong-status', async () => {
		await mkdir(join(vault, 'projects', 'active-proj'), { recursive: true });
		await writeFile(
			join(vault, 'projects', 'active-proj', 'index.md'),
			noteMd('Active Proj', 'active'),
			'utf-8',
		);
		const { archiveProject } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await archiveProject('active-proj', vault);
		assert.equal(r.ok, false);
		assert.equal(r.error, 'wrong-status');
	});

	test('collision with existing archive/ folder returns collision', async () => {
		await mkdir(join(vault, 'projects', 'collide'), { recursive: true });
		await writeFile(
			join(vault, 'projects', 'collide', 'index.md'),
			noteMd('Collide', 'archived'),
			'utf-8',
		);
		// Pre-create the archive destination.
		await mkdir(join(vault, 'archive', 'collide'), { recursive: true });
		const { archiveProject } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await archiveProject('collide', vault);
		assert.equal(r.ok, false);
		assert.equal(r.error, 'collision');
	});
});
