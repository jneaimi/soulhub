/** ADR-006 P1.1 — setNoteStatus + dispatchStatusFlip unit tests.
 *
 *  Covers Deliverable A (generic `setNoteStatus`) and Deliverable B
 *  (dual-file-aware `dispatchStatusFlip`).
 *
 *  Test strategy:
 *    • Section 1 — pure validation (pre-engine): path/status guards, and
 *      `engine-unavailable` when no vault engine has been initialised.
 *      These run with `engine === null` (module singleton starts null;
 *      no `initVault` called here).
 *    • Section 2 — integration with a live engine: a temporary vault is
 *      initialised so `setNoteStatus` can reach `engine.updateNote` and
 *      exercise the happy + note-not-found paths.
 *    • Section 3 — dispatchStatusFlip project-pair: uses direct I/O
 *      (setProjectStatus + reconcileDualStatus) and does NOT require the
 *      engine; exercises the dual-file coherence guarantee.
 *    • Section 4 — dispatchStatusFlip non-project routing: verifies that a
 *      non-project path is forwarded to setNoteStatus (evidenced by
 *      `engine-unavailable` from section-3's engine-shutdown, or by
 *      observing the correct update in the integration section).
 *
 *  Run with:
 *    node --test --experimental-strip-types tests/vault-hygiene/set-note-status.test.ts */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Section 1: Pure validation — no engine running ────────────────────────────
//
// `getVaultEngine()` returns null (module-level singleton is null until
// `initVault` is called). Only path/status guards run here.

describe('setNoteStatus — pre-engine validation', () => {
	test('rejects empty path', async () => {
		const { setNoteStatus } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await setNoteStatus('', 'proposed');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'invalid-path');
	});

	test('rejects whitespace-only path', async () => {
		const { setNoteStatus } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await setNoteStatus('   ', 'proposed');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'invalid-path');
	});

	test('rejects status not in canonical set (e.g. "active")', async () => {
		const { setNoteStatus } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await setNoteStatus('knowledge/foo.md', 'active');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'invalid-status');
	});

	test('rejects empty status', async () => {
		const { setNoteStatus } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await setNoteStatus('knowledge/foo.md', '');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'invalid-status');
	});

	test('accepts all six canonical statuses through validation (engine-unavailable is the only blocker)', async () => {
		const { setNoteStatus } = await import('../../src/lib/vault-hygiene/actions.ts');
		// We can't reach the engine, but we confirm no validation error fires.
		for (const s of ['proposed', 'accepted', 'shipped', 'rejected', 'parked', 'superseded']) {
			const r = await setNoteStatus('knowledge/foo.md', s);
			// Must NOT be invalid-path or invalid-status — only engine-unavailable.
			assert.notEqual(r.error, 'invalid-path', `${s} should not fail path check`);
			assert.notEqual(r.error, 'invalid-status', `${s} should not fail status check`);
			assert.equal(r.error, 'engine-unavailable', `${s}: expected engine-unavailable, got ${r.error}`);
		}
	});

	test('canonical open/reopen status "proposed" passes validation', async () => {
		// ADR-006 edge case #7: "proposed" is the canonical open value for ADR notes.
		const { setNoteStatus } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await setNoteStatus('projects/foo/adr-001.md', 'proposed');
		assert.equal(r.ok, false);
		// Must reach engine-unavailable, not a validation error.
		assert.equal(r.error, 'engine-unavailable');
	});
});

// ── Section 2: Integration — setNoteStatus with live engine ──────────────────
//
// Initialises a temporary vault so `engine.updateNote` can run.
// A valid decision note is created and indexed before tests run.

describe('setNoteStatus — integration (live engine)', () => {
	let tmpVault = '';
	let shutdown: () => void;

	before(async () => {
		tmpVault = await mkdtemp(join(tmpdir(), 'soul-hub-test-setnote-'));
		// Minimal vault structure — only the zones we need.
		await mkdir(join(tmpVault, 'knowledge'), { recursive: true });
		await mkdir(join(tmpVault, '.vault', 'templates'), { recursive: true });

		// A valid `type: decision` note with canonical status.
		const noteContent = [
			'---',
			'type: decision',
			'status: proposed',
			"created: '2026-01-01'",
			'tags: [test]',
			'---',
			'',
			'## Status',
			'',
			'**Proposed 2026-01-01.**',
			'',
			'## Context',
			'',
			'Test decision note for setNoteStatus integration tests.',
		].join('\n') + '\n';

		await writeFile(join(tmpVault, 'knowledge', 'test-decision.md'), noteContent, 'utf-8');

		// Initialise the vault engine (sets the module-level singleton that
		// getVaultEngine() returns).
		const { initVault } = await import('../../src/lib/vault/index.ts');
		const eng = await initVault(tmpVault);
		shutdown = () => eng.shutdown();
	});

	after(async () => {
		shutdown?.();
		await rm(tmpVault, { recursive: true, force: true });
	});

	test('happy path: flips status on an existing indexed note', async () => {
		const { setNoteStatus } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await setNoteStatus('knowledge/test-decision.md', 'accepted');
		assert.equal(r.ok, true, `expected ok, got error: ${r.error} ${r.detail ?? ''}`);
		assert.ok(r.detail?.includes('accepted'), `detail should mention target status: ${r.detail}`);

		// Verify the file was actually updated on disk.
		const raw = await readFile(join(tmpVault, 'knowledge', 'test-decision.md'), 'utf-8');
		assert.ok(raw.includes('status: accepted'), 'file on disk should have updated status');
	});

	test('sad path: note-not-found for a path not in the index', async () => {
		const { setNoteStatus } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await setNoteStatus('knowledge/does-not-exist.md', 'proposed');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'update-failed');
		assert.ok(
			r.detail?.toLowerCase().includes('not found'),
			`detail should mention "not found": ${r.detail}`,
		);
	});
});

// ── Section 3: dispatchStatusFlip — project pair ──────────────────────────────
//
// Uses the direct-I/O path (setProjectStatus + reconcileDualStatus).
// Does NOT require the vault engine; a temp directory suffices.

describe('dispatchStatusFlip — project pair (dual-file coherence)', () => {
	let tmpVault = '';

	before(async () => {
		tmpVault = await mkdtemp(join(tmpdir(), 'soul-hub-test-dispatch-'));
		await mkdir(join(tmpVault, 'projects', 'dual-proj'), { recursive: true });

		const fm = (status: string) =>
			[
				'---',
				'type: index',
				`status: ${status}`,
				"created: '2026-01-01'",
				'tags: [test]',
				'project: dual-proj',
				'---',
				'',
				`# dual-proj (${status})`,
			].join('\n') + '\n';

		await writeFile(join(tmpVault, 'projects', 'dual-proj', 'index.md'), fm('shipped'), 'utf-8');
		await writeFile(join(tmpVault, 'projects', 'dual-proj', 'project.md'), fm('shipped'), 'utf-8');
	});

	after(async () => {
		await rm(tmpVault, { recursive: true, force: true });
	});

	test('flips BOTH index.md and project.md coherently when called on index path', async () => {
		const { dispatchStatusFlip } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await dispatchStatusFlip(
			'projects/dual-proj/index.md',
			'active',
			tmpVault,
		);
		assert.equal(r.ok, true, `expected ok, got: ${r.error} ${r.detail ?? ''}`);

		const idx = await readFile(join(tmpVault, 'projects', 'dual-proj', 'index.md'), 'utf-8');
		const prj = await readFile(join(tmpVault, 'projects', 'dual-proj', 'project.md'), 'utf-8');

		assert.ok(idx.includes('status: active'), `index.md should have status: active\n${idx}`);
		assert.ok(prj.includes('status: active'), `project.md should have status: active\n${prj}`);
	});

	test('flips BOTH files coherently when called on project.md path', async () => {
		const { dispatchStatusFlip } = await import('../../src/lib/vault-hygiene/actions.ts');

		// Reset both files to 'shipped' first.
		// NOTE: use a non-hyphenated status — reconcileDualStatus uses /\w+/ to
		// read the winner's status, which doesn't match hyphenated values.
		const fm = (status: string) =>
			`---\ntype: index\nstatus: ${status}\ncreated: '2026-01-01'\ntags: [test]\nproject: dual-proj\n---\n\n# dual-proj (${status})\n`;
		await writeFile(join(tmpVault, 'projects', 'dual-proj', 'index.md'), fm('shipped'), 'utf-8');
		await writeFile(join(tmpVault, 'projects', 'dual-proj', 'project.md'), fm('shipped'), 'utf-8');

		const r = await dispatchStatusFlip(
			'projects/dual-proj/project.md',
			'paused',       // simple alphanumeric — works with reconcileDualStatus \w+ regex
			tmpVault,
		);
		assert.equal(r.ok, true, `expected ok, got: ${r.error} ${r.detail ?? ''}`);

		const idx = await readFile(join(tmpVault, 'projects', 'dual-proj', 'index.md'), 'utf-8');
		const prj = await readFile(join(tmpVault, 'projects', 'dual-proj', 'project.md'), 'utf-8');

		assert.ok(idx.includes('status: paused'), `index.md should have paused\n${idx}`);
		assert.ok(prj.includes('status: paused'), `project.md should have paused\n${prj}`);
	});

	test('single-file flip when only index.md exists (no project.md)', async () => {
		const { dispatchStatusFlip } = await import('../../src/lib/vault-hygiene/actions.ts');

		// Create a separate project with only index.md.
		await mkdir(join(tmpVault, 'projects', 'single-proj'), { recursive: true });
		await writeFile(
			join(tmpVault, 'projects', 'single-proj', 'index.md'),
			'---\ntype: index\nstatus: shipped\ncreated: \'2026-01-01\'\ntags: [test]\nproject: single-proj\n---\n\n# single-proj\n',
			'utf-8',
		);

		const r = await dispatchStatusFlip(
			'projects/single-proj/index.md',
			'paused',
			tmpVault,
		);
		assert.equal(r.ok, true, `expected ok, got: ${r.error} ${r.detail ?? ''}`);

		const idx = await readFile(join(tmpVault, 'projects', 'single-proj', 'index.md'), 'utf-8');
		assert.ok(idx.includes('status: paused'), `index.md should have paused\n${idx}`);
		// detail should indicate single-file mode.
		assert.ok(r.detail?.includes('[project single]'), `detail should say [project single]: ${r.detail}`);
	});
});

// ── Section 4: dispatchStatusFlip — non-project routing ──────────────────────
//
// Verifies that a non-project path is routed to setNoteStatus (Deliverable A).
//
// After section 2's before/after lifecycle, the VaultEngine instance is shut
// down (watcher stopped) but the module-level singleton in vault/index.ts is
// NOT reset to null — `getVaultEngine()` still returns the instance. So a valid
// canonical status on an unindexed path reaches `engine.updateNote` and returns
// `update-failed` (note not found), NOT `engine-unavailable`. Both outcomes
// confirm routing went through setNoteStatus (not a project-pair primitive).

describe('dispatchStatusFlip — non-project routing to setNoteStatus', () => {
	test('routes non-project path through setNoteStatus (engine present, note absent)', async () => {
		const { dispatchStatusFlip } = await import('../../src/lib/vault-hygiene/actions.ts');
		// A non-project path with a canonical status — routes to setNoteStatus.
		// The engine is alive but 'knowledge/some-adr.md' was never indexed, so
		// engine.updateNote returns "note not found" → setNoteStatus propagates
		// as `update-failed`. Either update-failed or engine-unavailable confirms
		// the path was routed to setNoteStatus (NOT a project-pair primitive).
		const r = await dispatchStatusFlip(
			'knowledge/some-adr.md',
			'proposed',
			'/any/vault/dir',
		);
		// Must NOT get project-specific errors (not-found on slug, invalid-slug, etc.)
		assert.notEqual(r.error, 'invalid-slug', 'must not go through project-pair path');
		// Must be routed through setNoteStatus → update-failed or engine-unavailable.
		assert.equal(r.ok, false);
		assert.ok(
			r.error === 'update-failed' || r.error === 'engine-unavailable',
			`expected update-failed or engine-unavailable from setNoteStatus, got: ${r.error}`,
		);
	});

	test('non-project-pair path (projects/<slug>/adr.md) routes to setNoteStatus', async () => {
		// projects/<slug>/adr-001.md is NOT a pair file (not index|project.md).
		const { dispatchStatusFlip } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await dispatchStatusFlip(
			'projects/my-proj/adr-001.md',
			'accepted',
			'/any/vault/dir',
		);
		// Not invalid-slug (no slug extraction), not not-found (project-pair path)
		assert.notEqual(r.error, 'invalid-slug');
		// Confirm setNoteStatus routing by the kind of error (not a project-pair error).
		assert.ok(
			r.error === 'update-failed' || r.error === 'engine-unavailable',
			`expected setNoteStatus error, got: ${r.error}`,
		);
	});

	test('dispatchStatusFlip rejects empty path', async () => {
		const { dispatchStatusFlip } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await dispatchStatusFlip('', 'proposed', '/any/vault/dir');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'invalid-path');
	});

	test('dispatchStatusFlip rejects empty status', async () => {
		const { dispatchStatusFlip } = await import('../../src/lib/vault-hygiene/actions.ts');
		const r = await dispatchStatusFlip('knowledge/foo.md', '', '/any/vault/dir');
		assert.equal(r.ok, false);
		assert.equal(r.error, 'invalid-status');
	});
});
