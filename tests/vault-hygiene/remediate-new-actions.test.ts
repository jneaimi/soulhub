/** ADR-006 P1.2 — remediate API: move + reopen-status action tests.
 *
 *  Tests the TOCTOU re-validation logic and the underlying primitives that
 *  the /api/hygiene/remediate route dispatches for the two new actions.
 *  Does NOT spin up an HTTP server — the key invariants are verified by
 *  exercising the detection functions and action primitives directly.
 *
 *  Happy path:
 *    • move: inbox/recipe note is flagged by getMisplacedNotes → engine.moveNote succeeds
 *    • reopen-status: shipped+open-tasks note is flagged → dispatchStatusFlip succeeds
 *
 *  Sad path (validation — maps to HTTP 400):
 *    • missing targetZone / missing status caught before dispatch
 *
 *  Sad path (TOCTOU stale — maps to HTTP 409):
 *    • getMisplacedNotes.find() returns undefined for non-existent source → stale
 *    • getStatusContradictions.find() returns undefined for non-existent source → stale
 *
 *  All vault-engine tests share ONE initVault call (initVault() has an
 *  `if (engine) return engine` guard — multiple initialisations in one
 *  process return the first engine, not a new one per describe block).
 *
 *  Run:
 *    node --import ./tests/vault-hygiene/register.mjs \
 *         --test --experimental-strip-types \
 *         tests/vault-hygiene/remediate-new-actions.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Validation helpers ────────────────────────────────────────────────────────
//
// Inline mirrors of the route handler's validation guards.  These confirm
// the guards are both necessary (bad input is caught) and sufficient (good
// input passes through).

function validateMove(body: Record<string, unknown>): string | null {
	if (!body.source || typeof body.source !== 'string') return 'source is required';
	if (!body.targetZone || typeof body.targetZone !== 'string')
		return 'targetZone is required for move';
	return null;
}

function validateReopenStatus(body: Record<string, unknown>): string | null {
	if (!body.source || typeof body.source !== 'string') return 'source is required';
	if (!body.status || typeof body.status !== 'string')
		return 'status is required for reopen-status';
	return null;
}

// ── Section 1: Validation (no vault needed) ───────────────────────────────────

describe('move — missing targetZone (sad path, 400)', () => {
	test('missing targetZone triggers validation error', () => {
		const err = validateMove({ source: 'inbox/note.md' });
		assert.equal(err, 'targetZone is required for move');
	});

	test('empty string targetZone triggers validation error', () => {
		const err = validateMove({ source: 'inbox/note.md', targetZone: '' });
		assert.equal(err, 'targetZone is required for move');
	});

	test('valid source + targetZone passes validation', () => {
		const err = validateMove({ source: 'inbox/note.md', targetZone: 'knowledge' });
		assert.equal(err, null, 'valid body should produce no validation error');
	});
});

describe('reopen-status — missing status (sad path, 400)', () => {
	test('missing status triggers validation error', () => {
		const err = validateReopenStatus({ source: 'projects/foo/adr-001.md' });
		assert.equal(err, 'status is required for reopen-status');
	});

	test('empty string status triggers validation error', () => {
		const err = validateReopenStatus({ source: 'projects/foo/adr-001.md', status: '' });
		assert.equal(err, 'status is required for reopen-status');
	});

	test('valid source + status passes validation', () => {
		const err = validateReopenStatus({ source: 'projects/foo/adr-001.md', status: 'proposed' });
		assert.equal(err, null, 'valid body should produce no validation error');
	});
});

// ── Section 2: Integration tests (single shared vault) ────────────────────────
//
// initVault() has an `if (engine) return engine` guard so multiple calls in
// the same process return the FIRST engine, not a per-describe one.  All
// tests that need a vault engine therefore share one `before` and one `after`.
//
// The shared vault contains:
//   inbox/2026-01-01-pasta-recipe.md   — misplaced (inbox note typed 'recipe')
//   knowledge/drifted-adr.md           — status contradiction (shipped + open task)
//
// Stale tests use paths that do NOT exist in the vault, so find() returns
// undefined — exactly the condition that causes the route to return 409.

describe('TOCTOU + happy path — shared vault', () => {
	let tmpVault = '';
	let eng: Awaited<ReturnType<typeof import('../../src/lib/vault/index.ts').initVault>>;
	let shutdown: (() => void) | undefined;

	before(async () => {
		tmpVault = await mkdtemp(join(tmpdir(), 'soul-hub-test-p1-2-'));

		// Create the vault structure.
		await mkdir(join(tmpVault, 'inbox'), { recursive: true });
		await mkdir(join(tmpVault, 'knowledge', 'cooking', 'recipes'), { recursive: true });
		await mkdir(join(tmpVault, '.vault', 'templates'), { recursive: true });

		// Misplaced note: inbox recipe note that classifyZone routes to
		// knowledge/cooking/recipes (type: recipe → step 4 in classifyZone).
		await writeFile(
			join(tmpVault, 'inbox', '2026-01-01-pasta-recipe.md'),
			[
				'---',
				'type: recipe',
				'created: "2026-01-01"',
				'tags: [cooking, recipe]',
				'---',
				'',
				'# My Pasta Recipe',
				'',
				'Ingredients: pasta, sauce.',
				'Instructions: boil, mix.',
			].join('\n') + '\n',
			'utf-8',
		);

		// Status contradiction: shipped note with an open task checkbox.
		await writeFile(
			join(tmpVault, 'knowledge', 'drifted-adr.md'),
			[
				'---',
				'type: decision',
				'status: shipped',
				'created: "2026-01-01"',
				'tags: [test]',
				'---',
				'',
				'## Status',
				'',
				'**Shipped 2026-01-01.** One task remains.',
				'',
				'## Tasks',
				'',
				'- [ ] Write the post-ship doc',
			].join('\n') + '\n',
			'utf-8',
		);

		const { initVault } = await import('../../src/lib/vault/index.ts');
		eng = await initVault(tmpVault);
		shutdown = () => eng.shutdown();
	});

	after(async () => {
		shutdown?.();
		await rm(tmpVault, { recursive: true, force: true });
	});

	// ── move: TOCTOU stale (409) ──────────────────────────────────────────────

	test('stale guard: getMisplacedNotes.find() returns undefined for non-existent source', async () => {
		const { getMisplacedNotes } = await import('../../src/lib/vault-hygiene/misplaced-notes.ts');
		const fresh = getMisplacedNotes(eng);
		// A source path that was never in the vault → stale guard fires (409).
		const stillFlagged = fresh.find(
			(m) => m.path === 'inbox/old-recipe.md' && m.suggestedZone === 'knowledge/cooking/recipes',
		);
		assert.equal(stillFlagged, undefined, 'non-existent path should not be in fresh list → 409 stale');
	});

	test('stale guard: getMisplacedNotes.find() also rejects wrong targetZone for real path', async () => {
		const { getMisplacedNotes } = await import('../../src/lib/vault-hygiene/misplaced-notes.ts');
		const fresh = getMisplacedNotes(eng);
		// Wrong targetZone for the real misplaced note → classifier changed → stale guard fires.
		const stillFlagged = fresh.find(
			(m) => m.path === 'inbox/2026-01-01-pasta-recipe.md' && m.suggestedZone === 'knowledge/research',
		);
		assert.equal(stillFlagged, undefined, 'wrong suggestedZone should not match → 409 stale');
	});

	// ── move: happy path ──────────────────────────────────────────────────────

	test('getMisplacedNotes flags the inbox recipe note for knowledge/cooking/recipes', async () => {
		const { getMisplacedNotes } = await import('../../src/lib/vault-hygiene/misplaced-notes.ts');
		const items = getMisplacedNotes(eng);
		const flagged = items.find((m) => m.path === 'inbox/2026-01-01-pasta-recipe.md');
		assert.ok(flagged, 'recipe note in inbox should be flagged as misplaced');
		assert.equal(
			flagged.suggestedZone,
			'knowledge/cooking/recipes',
			'suggested zone should be knowledge/cooking/recipes (classifyZone step 4: type=recipe)',
		);
	});

	test('engine.moveNote succeeds for a flagged misplaced note (happy path)', async () => {
		const result = await eng.moveNote(
			'inbox/2026-01-01-pasta-recipe.md',
			'knowledge/cooking/recipes',
		);
		assert.equal(
			result.success,
			true,
			`moveNote should succeed, got: ${!result.success ? (result as { error: string }).error : 'ok'}`,
		);
	});

	// ── reopen-status: TOCTOU stale (409) ────────────────────────────────────

	test('stale guard: getStatusContradictions.find() returns undefined for non-existent source', async () => {
		const { getStatusContradictions } = await import('../../src/lib/vault-hygiene/status-contradictions.ts');
		const fresh = getStatusContradictions(eng);
		// A path that never existed → stale guard fires (409).
		const stillFlagged = fresh.find((sc) => sc.path === 'knowledge/already-resolved.md');
		assert.equal(stillFlagged, undefined, 'non-existent path should not be in fresh list → 409 stale');
	});

	// ── reopen-status: happy path ─────────────────────────────────────────────

	test('getStatusContradictions flags the shipped+open-task note', async () => {
		const { getStatusContradictions } = await import('../../src/lib/vault-hygiene/status-contradictions.ts');
		const items = getStatusContradictions(eng);
		const flagged = items.find((sc) => sc.path === 'knowledge/drifted-adr.md');
		assert.ok(flagged, 'shipped note with open task should be flagged as status contradiction');
		assert.equal(flagged.status, 'shipped');
		assert.equal(flagged.openTaskCount, 1);
	});

	test('dispatchStatusFlip flips the note to "proposed" (canonical open, ADR-006 edge case #7)', async () => {
		const { dispatchStatusFlip } = await import('../../src/lib/vault-hygiene/actions.ts');
		const result = await dispatchStatusFlip(
			'knowledge/drifted-adr.md',
			'proposed',
			tmpVault,
		);
		assert.equal(
			result.ok,
			true,
			`dispatchStatusFlip should succeed: ${result.error ?? ''} ${result.detail ?? ''}`,
		);
		const raw = await readFile(join(tmpVault, 'knowledge', 'drifted-adr.md'), 'utf-8');
		assert.ok(raw.includes('status: proposed'), `file on disk should have status: proposed\n${raw}`);
	});

	test('after flip: getStatusContradictions no longer flags the note (TOCTOU guard passes)', async () => {
		const { getStatusContradictions } = await import('../../src/lib/vault-hygiene/status-contradictions.ts');
		const items = getStatusContradictions(eng);
		// `proposed` is not in COMPLETED_STATUSES → no contradiction after the flip.
		const stillFlagged = items.find((sc) => sc.path === 'knowledge/drifted-adr.md');
		assert.equal(
			stillFlagged,
			undefined,
			'note should not be flagged after status flip — TOCTOU would now allow a second action',
		);
	});
});
