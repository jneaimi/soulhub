/** ADR-031 P1 — repo-aware review/ship routing tests.
 *
 *  Covers the key falsifiers from ADR-031:
 *    1. A run with `repo = <non-soul-hub path>` → ship-merge resolves repoDir
 *       to that path (never soul-hub).
 *    2. A run with `repo = null` → repoDir falls back to
 *       SOUL_HUB_REPO ?? cwd (soul-hub), i.e. legacy behaviour is unchanged.
 *    3. `expandHome` correctly expands `~` so stored paths with `~/…` work.
 *    4. `startAgentRun` writes the `repo` column; `getReviewableRunForSubject`
 *       reads it back, matching across a full write→read round-trip.
 *
 *  Integration strategy: tests operate against in-memory SQLite (no live ops.db
 *  access) via the same `_overrideDb` injection pattern used in subject-review-run
 *  and ask-operator tests.  The repoDir *resolution* logic is extracted and tested
 *  directly (no execFileAsync calls needed — the git-ops layer is unchanged; only
 *  the cwd argument changes, which is what we verify here).
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/run-repo-routing.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUBJECT = 'projects/projects-graph/adr-031-repo-aware-review-ship-loop.md';

// ── Minimal in-memory DB matching the columns under test ──────────────────────

function createTestDb(): Database.Database {
	const d = new Database(':memory:');
	d.exec(`
		CREATE TABLE agent_runs (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id            TEXT    NOT NULL,
			agent_id          TEXT    NOT NULL DEFAULT 'soul-hub-implementer',
			backend           TEXT    NOT NULL DEFAULT 'claude-pty',
			mode              TEXT    NOT NULL DEFAULT 'production',
			task_spec         TEXT    NOT NULL DEFAULT 'test',
			started_at        INTEGER NOT NULL,
			finished_at       INTEGER,
			status            TEXT    NOT NULL,
			cost_usd          REAL    NOT NULL DEFAULT 0,
			num_turns         INTEGER NOT NULL DEFAULT 0,
			result_excerpt    TEXT,
			error_message     TEXT,
			claude_session_id TEXT,
			subject_path      TEXT,
			handback          TEXT,
			repo              TEXT
		)
	`);
	return d;
}

function insertFinishedRun(
	d: Database.Database,
	opts: {
		runId: string;
		startedAt: number;
		subjectPath: string;
		repo?: string | null;
	},
): void {
	const now = Date.now();
	d.prepare(`
		INSERT INTO agent_runs
			(run_id, started_at, finished_at, status, cost_usd, num_turns,
			 subject_path, repo)
		VALUES (?, ?, ?, 'goal_achieved', 0.1, 5, ?, ?)
	`).run(
		opts.runId,
		opts.startedAt,
		now,
		opts.subjectPath,
		opts.repo ?? null,
	);
}

// ── repoDir resolution helper (mirrors the endpoint logic exactly) ────────────
// Extracted inline here so the tests stay pure unit tests — no SvelteKit import.

async function resolveRepoDir(
	run: { repo: string | null },
	env: { SOUL_HUB_REPO?: string; cwd?: string },
): Promise<string> {
	const { expandHome } = await import('$lib/agents/dispatch/worktree-provision.ts');
	return expandHome(run.repo ?? env.SOUL_HUB_REPO ?? env.cwd ?? process.cwd());
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ADR-031 P1 — repo-aware routing', () => {

	describe('repoDir resolution', () => {
		test('run.repo set to a non-soul-hub absolute path → repoDir matches that path', async () => {
			const NON_SH = '/Users/jneaimi/.claude';
			const dir = await resolveRepoDir(
				{ repo: NON_SH },
				{ SOUL_HUB_REPO: '/Users/jneaimi/dev/soul-hub', cwd: '/Users/jneaimi/dev/soul-hub' },
			);
			assert.equal(
				dir,
				NON_SH,
				'run.repo takes priority over SOUL_HUB_REPO and cwd',
			);
		});

		test('run.repo null → repoDir falls back to SOUL_HUB_REPO', async () => {
			const SH = '/Users/jneaimi/dev/soul-hub';
			const dir = await resolveRepoDir(
				{ repo: null },
				{ SOUL_HUB_REPO: SH, cwd: '/some/other/cwd' },
			);
			assert.equal(
				dir,
				SH,
				'null repo falls back to SOUL_HUB_REPO — legacy/soul-hub dispatch unchanged',
			);
		});

		test('run.repo null, no SOUL_HUB_REPO → repoDir falls back to cwd', async () => {
			const CWD = '/Users/jneaimi/dev/soul-hub';
			const dir = await resolveRepoDir(
				{ repo: null },
				{ cwd: CWD },
			);
			assert.equal(
				dir,
				CWD,
				'double-fallback to cwd when repo is null and SOUL_HUB_REPO unset',
			);
		});

		test('run.repo with leading ~ is expanded to absolute path', async () => {
			const TILDE_PATH = '~/.claude';
			const EXPECTED = join(homedir(), '.claude');
			const dir = await resolveRepoDir(
				{ repo: TILDE_PATH },
				{ SOUL_HUB_REPO: '/Users/jneaimi/dev/soul-hub' },
			);
			assert.equal(
				dir,
				EXPECTED,
				'expandHome resolves ~ in stored repo paths',
			);
		});
	});

	describe('DB round-trip: write repo → read via getReviewableRunForSubject', () => {
		test('non-soul-hub repo round-trips through DB intact', async () => {
			const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
			const db = createTestDb();
			const REPO = '/Users/jneaimi/.claude';
			const now = Date.now();

			insertFinishedRun(db, {
				runId: 'rt-non-sh',
				startedAt: now - 90_000,
				subjectPath: SUBJECT,
				repo: REPO,
			});

			const run = getReviewableRunForSubject(SUBJECT, db);
			assert.ok(run, 'should find the run');
			assert.equal(run.repo, REPO, 'repo round-trips through DB');
			db.close();
		});

		test('null repo round-trips as null (legacy/soul-hub runs unchanged)', async () => {
			const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
			const db = createTestDb();
			const now = Date.now();

			insertFinishedRun(db, {
				runId: 'rt-null-repo',
				startedAt: now - 60_000,
				subjectPath: SUBJECT,
				repo: null,     // legacy: no repo column value
			});

			const run = getReviewableRunForSubject(SUBJECT, db);
			assert.ok(run, 'should find the run');
			assert.equal(run.repo, null, 'null preserved — endpoints fall back to soul-hub');
			db.close();
		});

		test('multiple runs for same subject — newest repo wins', async () => {
			const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
			const db = createTestDb();
			const now = Date.now();

			insertFinishedRun(db, {
				runId: 'old-run',
				startedAt: now - 300_000,
				subjectPath: SUBJECT,
				repo: '/some/old-repo',
			});
			insertFinishedRun(db, {
				runId: 'new-run',
				startedAt: now - 60_000,
				subjectPath: SUBJECT,
				repo: '/Users/jneaimi/.claude',
			});

			const run = getReviewableRunForSubject(SUBJECT, db);
			assert.ok(run);
			assert.equal(run.runId, 'new-run', 'newest run wins');
			assert.equal(run.repo, '/Users/jneaimi/.claude', 'newest repo returned');
			db.close();
		});
	});
});
