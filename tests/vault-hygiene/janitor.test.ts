/** Tests for runJanitorPass — deterministic vault-hygiene janitor (ADR-008).
 *
 *  Replaces the keeper agent's Job A on the 30-min heartbeat tick.
 *  Covers:
 *    1. A1 + A3 happy path: orphan note linked in zone index, missing `created`
 *       field backfilled — both in a single pass, zero errors.
 *    2. A1 idempotency: second run with the same report skips already-linked orphan.
 *    3. A2 happy path: stale inbox note with a known type is moved to canonical zone.
 *    4. A2 unknown type: stale note whose type is not in INBOX_TYPE_TO_ZONE is NOT moved.
 *    5. Summary string: "no auto-fixes needed" on a clean / empty report.
 *
 *  All tests share ONE VaultEngine singleton (initVault guard: one engine per
 *  process). Test notes are created in the temp vault BEFORE initVault so they
 *  are indexed on startup.
 *
 *  Run:
 *    node --import ./tests/vault-hygiene/register.mjs \
 *         --test --experimental-strip-types \
 *         tests/vault-hygiene/janitor.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HygieneReport } from '../../src/lib/vault-hygiene/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid frontmatter + body. */
function noteMd(type: string, body: string): string {
	return [
		'---',
		`type: ${type}`,
		"created: '2026-01-01'",
		'tags: [test]',
		'---',
		'',
		body,
		'',
	].join('\n');
}

/** Frontmatter WITHOUT a `created` field — triggers A3 backfill. */
function noteMdNoCreated(type: string, body: string): string {
	return ['---', `type: ${type}`, 'tags: [test]', '---', '', body, ''].join('\n');
}

/** Fully-populated empty HygieneReport. Override only the fields you need. */
function emptyReport(): HygieneReport {
	return {
		generatedAt: new Date().toISOString(),
		totals: {
			indexed: 0,
			orphans: 0,
			unresolved: 0,
			staleInbox: 0,
			statusContradictions: 0,
			governanceViolations: 0,
			misplacedNotes: 0,
			inboxDecisions: 0,
			adrImplementationDrift: 0,
		},
		healthScore: 100,
		orphans: [],
		unresolved: [],
		staleInbox: [],
		statusContradictions: [],
		governanceViolations: [],
		misplacedNotes: [],
		inboxDecisions: [],
		adrImplementationDrift: [],
	};
}

// ── Shared vault setup ─────────────────────────────────────────────────────────

let tmpVault = '';
let shutdown: () => void;

before(async () => {
	tmpVault = await mkdtemp(join(tmpdir(), 'soul-hub-janitor-'));

	// Required directories
	await mkdir(join(tmpVault, 'inbox'), { recursive: true });
	await mkdir(join(tmpVault, 'knowledge', 'learnings'), { recursive: true });
	await mkdir(join(tmpVault, '.vault', 'templates'), { recursive: true });

	// Zone index — healOrphans appends to this file.
	await writeFile(
		join(tmpVault, 'knowledge', 'index.md'),
		noteMd('index', '# Knowledge\n\nZone index for test vault.'),
	);

	// A1: orphan note for the happy-path test — not linked in index.md
	await writeFile(
		join(tmpVault, 'knowledge', 'orphan-note.md'),
		noteMd('learning', '# Orphan Note\n\nThis note has no inbound links yet.'),
	);

	// A1: separate orphan for idempotency test — also not yet linked
	await writeFile(
		join(tmpVault, 'knowledge', 'idempotency-orphan.md'),
		noteMd('learning', '# Idempotency Orphan\n\nUsed to test that second run is a no-op.'),
	);

	// A3: note missing the `created` field — healMissingFrontmatter should backfill it
	await writeFile(
		join(tmpVault, 'knowledge', 'no-created.md'),
		noteMdNoCreated('learning', '# No Created\n\nFrontmatter is missing the created field.'),
	);

	// A2: stale inbox note with a VALID type — should be moved to knowledge/learnings
	await writeFile(
		join(tmpVault, 'inbox', 'stale-learning.md'),
		noteMd('learning', '# Stale Learning\n\nAn old inbox note with a recognised type.'),
	);

	// A2: stale inbox note with an UNRECOGNIZED type — must NOT be moved
	await writeFile(
		join(tmpVault, 'inbox', 'stale-unknown.md'),
		noteMd('bogus-type', '# Stale Unknown\n\nAn old inbox note whose type is not in INBOX_TYPE_TO_ZONE.'),
	);

	// Initialise the vault engine (sets the module-level singleton).
	const { initVault } = await import('../../src/lib/vault/index.ts');
	const eng = await initVault(tmpVault);
	shutdown = () => eng.shutdown();
});

after(async () => {
	shutdown?.();
	await rm(tmpVault, { recursive: true, force: true });
});

// ── A1 + A3: orphan healing + frontmatter backfill (happy path) ───────────────

describe('A1 + A3 — orphan healing and frontmatter backfill (happy path)', () => {
	test('links orphan to zone index (orphansFixed=1) and backfills missing created field (frontmatterBackfilled≥1); zero errors', async () => {
		const { runJanitorPass } = await import('../../src/lib/vault-hygiene/janitor.ts');
		const report: HygieneReport = {
			...emptyReport(),
			orphans: [
				{ path: 'knowledge/orphan-note.md', title: 'Orphan Note', suggestedFix: '' },
			],
		};

		const result = await runJanitorPass(report);

		// Counts
		assert.equal(result.errors, 0, `expected 0 errors; got: ${result.errors}`);
		assert.equal(result.orphansFixed, 1, `orphansFixed should be 1; got: ${result.orphansFixed}`);
		assert.ok(
			result.frontmatterBackfilled >= 1,
			`frontmatterBackfilled should be ≥1 (no-created.md); got: ${result.frontmatterBackfilled}`,
		);

		// knowledge/index.md must have been updated with a link to the orphan
		const indexContent = await readFile(join(tmpVault, 'knowledge', 'index.md'), 'utf-8');
		assert.ok(
			indexContent.includes('[[knowledge/orphan-note'),
			`knowledge/index.md should contain [[knowledge/orphan-note…\n${indexContent}`,
		);

		// no-created.md must now have a `created:` line in its frontmatter
		const noCreatedContent = await readFile(join(tmpVault, 'knowledge', 'no-created.md'), 'utf-8');
		assert.ok(
			/^created:\s/m.test(noCreatedContent),
			`no-created.md should have a created: field after the janitor pass\n${noCreatedContent}`,
		);

		// Summary must mention the fixes
		assert.ok(
			result.summary.includes('auto-fixed'),
			`summary should mention "auto-fixed"; got: "${result.summary}"`,
		);
	});
});

// ── A1: Idempotency ───────────────────────────────────────────────────────────

describe('A1 idempotency — second run skips already-linked orphan', () => {
	test('first run links idempotency-orphan (orphansFixed=1); second run skips it (orphansFixed=0, skipped≥1)', async () => {
		const { runJanitorPass } = await import('../../src/lib/vault-hygiene/janitor.ts');
		const report: HygieneReport = {
			...emptyReport(),
			orphans: [
				{ path: 'knowledge/idempotency-orphan.md', title: 'Idempotency Orphan', suggestedFix: '' },
			],
		};

		// ── First run ──
		const result1 = await runJanitorPass(report);
		assert.equal(result1.orphansFixed, 1, `first run: orphansFixed should be 1; got: ${result1.orphansFixed}`);

		const indexAfterFirst = await readFile(join(tmpVault, 'knowledge', 'index.md'), 'utf-8');
		assert.ok(
			indexAfterFirst.includes('[[knowledge/idempotency-orphan'),
			`index.md should have [[knowledge/idempotency-orphan after first run\n${indexAfterFirst}`,
		);

		// ── Second run (same report, link already present) ──
		// healOrphans reads index.md fresh from disk, detects alreadyLinked → skips.
		const result2 = await runJanitorPass(report);
		assert.equal(result2.orphansFixed, 0, `second run: orphansFixed should be 0; got: ${result2.orphansFixed}`);
		assert.ok(
			result2.skipped >= 1,
			`second run: skipped should be ≥1 (already-linked orphan); got: ${result2.skipped}`,
		);
		assert.equal(result2.errors, 0, `second run: expected 0 errors; got: ${result2.errors}`);
	});
});

// ── A2: Stale inbox filing — happy path ───────────────────────────────────────

describe('A2 stale inbox filing — valid type moved to canonical zone', () => {
	test('stale inbox note (type: learning) is moved; inboxFiled=1, errors=0', async () => {
		const { runJanitorPass } = await import('../../src/lib/vault-hygiene/janitor.ts');
		const report: HygieneReport = {
			...emptyReport(),
			staleInbox: [
				{
					path: 'inbox/stale-learning.md',
					title: 'Stale Learning',
					ageDays: 10,
					suggestedFix: '',
				},
			],
		};

		const result = await runJanitorPass(report);

		assert.equal(result.inboxFiled, 1, `inboxFiled should be 1; got: ${result.inboxFiled}`);
		assert.equal(result.errors, 0, `expected 0 errors; got: ${result.errors}`);
	});
});

// ── A2: Stale inbox filing — unknown type ─────────────────────────────────────

describe('A2 stale inbox filing — unrecognized type NOT moved', () => {
	test('stale note with type not in INBOX_TYPE_TO_ZONE is left in inbox; inboxFiled=0', async () => {
		const { runJanitorPass } = await import('../../src/lib/vault-hygiene/janitor.ts');
		const report: HygieneReport = {
			...emptyReport(),
			staleInbox: [
				{
					path: 'inbox/stale-unknown.md',
					title: 'Stale Unknown',
					ageDays: 10,
					suggestedFix: '',
				},
			],
		};

		const result = await runJanitorPass(report);

		assert.equal(result.inboxFiled, 0, `inboxFiled should be 0 for unrecognized type; got: ${result.inboxFiled}`);
		assert.equal(result.errors, 0, `expected 0 errors; got: ${result.errors}`);
	});
});

// ── Summary string — no-op pass ───────────────────────────────────────────────

describe('summary string — "no auto-fixes needed" on a clean vault + empty report', () => {
	test('empty report after all fixes applied produces "no auto-fixes needed" summary', async () => {
		const { runJanitorPass } = await import('../../src/lib/vault-hygiene/janitor.ts');
		// By this point all orphans are linked, no-created.md has been backfilled,
		// and no stale inbox notes remain with missing frontmatter.
		// An empty report + already-clean vault ⇒ all three jobs produce zero fixes.
		const result = await runJanitorPass(emptyReport());

		assert.ok(
			result.summary.includes('no auto-fixes needed'),
			`summary should say "no auto-fixes needed"; got: "${result.summary}"`,
		);
		assert.equal(result.orphansFixed, 0, `orphansFixed should be 0; got: ${result.orphansFixed}`);
		assert.equal(result.inboxFiled, 0, `inboxFiled should be 0; got: ${result.inboxFiled}`);
		assert.equal(result.errors, 0, `errors should be 0; got: ${result.errors}`);
	});
});
