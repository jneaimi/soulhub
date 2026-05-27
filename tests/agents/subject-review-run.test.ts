/** ADR-026 D3 (drawer hydration) — `getReviewableRunForSubject` tests.
 *
 *  Backs the `/api/agents/review-handoff` endpoint that lets the AdrDrawer
 *  re-show the ADR-024 review card + Ship/Send-back for a PAST completed
 *  dispatch (not just a live in-drawer stream).
 *
 *  Covers:
 *   - returns the latest finished goal_achieved/success run for a subject,
 *     enriched with claude_session_id (needed for --resume on Send-back)
 *   - dedupes to the NEWEST run when a subject has several
 *   - ignores unfinished / non-success / wrong-subject rows
 *   - returns null for an unknown subject (no throw)
 *   - prefers the untruncated `handback` column; resultExcerpt still truncated
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/subject-review-run.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const SUBJECT = 'projects/soul-hub-hygiene/adr-008-retire-keeper-agent.md';

const HANDBACK = {
	branch: 'orchestration/run-1779000000000/adr-008-retire',
	commits: ['def456 feat: retire keeper'],
	files_changed: ['src/lib/agents/store.ts'],
	check_passed: true,
	build_passed: true,
	gate_results: { typecheck_gate: 'pass' },
	summary: 'Retired the keeper agent; janitor handles the mechanical sweeps.',
	follow_ups: ['Delete ~/.claude/agents/keeper.md manually'],
};

function fencedHandback(hb: object): string {
	return '```json\n' + JSON.stringify(hb, null, 2) + '\n```';
}

/** Minimal agent_runs schema mirroring the columns getReviewableRunForSubject reads. */
function createTestDb(): Database.Database {
	const d = new Database(':memory:');
	d.exec(`
		CREATE TABLE agent_runs (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id          TEXT    NOT NULL,
			agent_id        TEXT    NOT NULL DEFAULT 'soul-hub-implementer',
			backend         TEXT    NOT NULL DEFAULT 'claude-pty',
			mode            TEXT    NOT NULL DEFAULT 'production',
			task_spec       TEXT    NOT NULL DEFAULT 'test',
			started_at      INTEGER NOT NULL,
			finished_at     INTEGER,
			duration_ms     INTEGER,
			status          TEXT    NOT NULL,
			cost_usd        REAL    NOT NULL DEFAULT 0,
			num_turns       INTEGER NOT NULL DEFAULT 0,
			result_excerpt  TEXT,
			error_message   TEXT,
			claude_session_id TEXT,
			subject_path    TEXT,
			handback        TEXT,
			repo            TEXT
		)
	`);
	return d;
}

function insertRun(
	d: Database.Database,
	row: {
		runId: string;
		startedAt: number;
		finishedAt: number | null;
		status: string;
		subjectPath: string | null;
		sessionId?: string | null;
		resultExcerpt?: string | null;
		handback?: string | null;
		costUsd?: number;
		numTurns?: number;
		/** ADR-031 P1 — expanded repo path; null = legacy/soul-hub. */
		repo?: string | null;
	},
): void {
	d.prepare(`
		INSERT INTO agent_runs
			(run_id, started_at, finished_at, status, cost_usd, num_turns,
			 claude_session_id, subject_path, result_excerpt, handback, repo)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		row.runId,
		row.startedAt,
		row.finishedAt,
		row.status,
		row.costUsd ?? 0.42,
		row.numTurns ?? 12,
		row.sessionId ?? null,
		row.subjectPath,
		row.resultExcerpt ?? null,
		row.handback ?? null,
		row.repo ?? null,
	);
}

describe('getReviewableRunForSubject', () => {
	let db: Database.Database;

	before(() => {
		db = createTestDb();
	});
	after(() => {
		db.close();
	});

	test('returns the latest finished success run with claude_session_id', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const now = Date.now();
		insertRun(db, {
			runId: 'srr-001',
			startedAt: now - 300_000,
			finishedAt: now - 60_000,
			status: 'goal_achieved',
			subjectPath: SUBJECT,
			sessionId: 'sess-abc-123',
			handback: fencedHandback(HANDBACK),
			costUsd: 7.89,
			numTurns: 31,
		});

		const run = getReviewableRunForSubject(SUBJECT, db);
		assert.ok(run, 'should find the run');
		assert.equal(run.runId, 'srr-001');
		assert.equal(run.status, 'goal_achieved');
		assert.equal(run.claudeSessionId, 'sess-abc-123', 'session id must be carried for --resume');
		assert.equal(run.costUsd, 7.89);
		assert.equal(run.numTurns, 31);
		assert.ok(run.handback?.includes(HANDBACK.branch), 'handback block preserved');
	});

	test('dedupes to the NEWEST run when a subject has several', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const fresh = createTestDb();
		const now = Date.now();
		insertRun(fresh, {
			runId: 'old',
			startedAt: now - 600_000,
			finishedAt: now - 500_000,
			status: 'success',
			subjectPath: SUBJECT,
			sessionId: 'sess-old',
		});
		insertRun(fresh, {
			runId: 'new',
			startedAt: now - 120_000,
			finishedAt: now - 30_000,
			status: 'goal_achieved',
			subjectPath: SUBJECT,
			sessionId: 'sess-new',
		});

		const run = getReviewableRunForSubject(SUBJECT, fresh);
		assert.equal(run?.runId, 'new', 'newest started_at wins');
		assert.equal(run?.claudeSessionId, 'sess-new');
		fresh.close();
	});

	test('ignores unfinished, non-success, and other-subject rows', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const fresh = createTestDb();
		const now = Date.now();
		// unfinished (running)
		insertRun(fresh, {
			runId: 'running',
			startedAt: now - 10_000,
			finishedAt: null,
			status: 'running',
			subjectPath: SUBJECT,
		});
		// finished but failed
		insertRun(fresh, {
			runId: 'failed',
			startedAt: now - 20_000,
			finishedAt: now - 5_000,
			status: 'error',
			subjectPath: SUBJECT,
		});
		// success but a different subject
		insertRun(fresh, {
			runId: 'other',
			startedAt: now - 30_000,
			finishedAt: now - 6_000,
			status: 'success',
			subjectPath: 'projects/soul-hub/adr-001-other.md',
		});

		assert.equal(
			getReviewableRunForSubject(SUBJECT, fresh),
			null,
			'no eligible run for SUBJECT → null',
		);
		fresh.close();
	});

	test('returns null for an unknown subject (no throw)', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		assert.equal(getReviewableRunForSubject('projects/nope/adr-999.md', db), null);
	});

	test('prefers untruncated handback; resultExcerpt stays truncated', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const { parseHandBack } = await import('$lib/agents/handback.ts');
		const fresh = createTestDb();
		const now = Date.now();
		const fullBlock = fencedHandback(HANDBACK);
		const longOutput = 'A'.repeat(2000) + '\n\n' + fullBlock;
		const truncatedExcerpt = longOutput.slice(0, 800) + '…';

		insertRun(fresh, {
			runId: 'trunc',
			startedAt: now - 90_000,
			finishedAt: now - 10_000,
			status: 'goal_achieved',
			subjectPath: SUBJECT,
			resultExcerpt: truncatedExcerpt,
			handback: fullBlock,
		});

		const run = getReviewableRunForSubject(SUBJECT, fresh);
		assert.ok(run);
		// The fix: parse the stored handback → full HandBack.
		const hb = parseHandBack(run.handback);
		assert.ok(hb, 'parseHandBack on stored handback succeeds');
		assert.equal(hb.summary, HANDBACK.summary);
		// And prove the original bug: the truncated excerpt would NOT parse.
		assert.equal(parseHandBack(run.resultExcerpt), null, 'truncated excerpt does not parse');
		fresh.close();
	});

	// ── ADR-031 P1 — repo column tests ────────────────────────────────────────

	test('ADR-031: returns persisted non-soul-hub repo for the run', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const fresh = createTestDb();
		const now = Date.now();
		const NON_SOUL_HUB_REPO = '/Users/jneaimi/claude-config';

		insertRun(fresh, {
			runId: 'repo-bound',
			startedAt: now - 120_000,
			finishedAt: now - 30_000,
			status: 'goal_achieved',
			subjectPath: SUBJECT,
			repo: NON_SOUL_HUB_REPO,
		});

		const run = getReviewableRunForSubject(SUBJECT, fresh);
		assert.ok(run, 'should find the run');
		assert.equal(
			run.repo,
			NON_SOUL_HUB_REPO,
			'repo field must match the stored non-soul-hub path',
		);
		fresh.close();
	});

	test('ADR-031: null repo is preserved — legacy/soul-hub run reads back as null', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const fresh = createTestDb();
		const now = Date.now();

		// repo is omitted → defaults to null (legacy/soul-hub behaviour).
		insertRun(fresh, {
			runId: 'null-repo',
			startedAt: now - 60_000,
			finishedAt: now - 10_000,
			status: 'success',
			subjectPath: SUBJECT,
		});

		const run = getReviewableRunForSubject(SUBJECT, fresh);
		assert.ok(run, 'should find the run');
		assert.equal(
			run.repo,
			null,
			'null repo preserved — endpoints fall back to SOUL_HUB_REPO ?? cwd',
		);
		fresh.close();
	});

	// ── soul-hub-agents ADR-017 — reviewability follows the artifact, not the status label ──

	test('ADR-017: an `error` run WITH a hand-back IS reviewable (false-error recovery)', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const fresh = createTestDb();
		const now = Date.now();
		// The ADR-003 run #491 shape: committed work + green hand-back, but the
		// stall-detector marked it `error` (no end_turn after the hand-back).
		insertRun(fresh, {
			runId: 'false-error',
			startedAt: now - 60_000,
			finishedAt: now - 10_000,
			status: 'error',
			subjectPath: SUBJECT,
			handback: fencedHandback(HANDBACK),
		});
		const run = getReviewableRunForSubject(SUBJECT, fresh);
		assert.ok(run, 'an error run carrying a hand-back must still surface for review');
		assert.equal(run.status, 'error');
		assert.ok(run.handback?.includes(HANDBACK.branch), 'hand-back preserved');
		fresh.close();
	});

	test('ADR-017: an `error` run with NO hand-back stays hidden (safety floor)', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const fresh = createTestDb();
		const now = Date.now();
		insertRun(fresh, {
			runId: 'real-error',
			startedAt: now - 60_000,
			finishedAt: now - 10_000,
			status: 'error',
			subjectPath: SUBJECT,
			// no hand-back — a genuine failure with nothing to review
		});
		assert.equal(
			getReviewableRunForSubject(SUBJECT, fresh),
			null,
			'a true failure (error + no hand-back) must not surface',
		);
		fresh.close();
	});

	test('ADR-017: newest wins across mixed statuses (newer error-with-handback over older success)', async () => {
		const { getReviewableRunForSubject } = await import('$lib/agents/runs.ts');
		const fresh = createTestDb();
		const now = Date.now();
		insertRun(fresh, {
			runId: 'older-success',
			startedAt: now - 600_000,
			finishedAt: now - 500_000,
			status: 'success',
			subjectPath: SUBJECT,
			handback: fencedHandback(HANDBACK),
		});
		insertRun(fresh, {
			runId: 'newer-false-error',
			startedAt: now - 120_000,
			finishedAt: now - 30_000,
			status: 'error',
			subjectPath: SUBJECT,
			handback: fencedHandback(HANDBACK),
		});
		assert.equal(
			getReviewableRunForSubject(SUBJECT, fresh)?.runId,
			'newer-false-error',
			'latest started_at wins regardless of status label',
		);
		fresh.close();
	});
});
