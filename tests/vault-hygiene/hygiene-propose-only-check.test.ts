/** ADR-007 P1 — hygiene-agent-propose-only-check falsifier tests.
 *
 *  Exercises the runtime guard that asserts the `hygiene-fixer` agent
 *  NEVER writes to the vault (propose-only guarantee).
 *
 *  Test strategy:
 *    • Section 1 (no engine): `getVaultEngine()` returns null → falsifier
 *      returns green (fail-open: can't be a false-positive when no vault
 *      is running). This section runs FIRST, before any initVault call,
 *      so the singleton is still null.
 *    • Sections 2-4 share a single `describe` block with a scoped `before`
 *      that calls initVault.  The scoped hook fires AFTER Section 1 finishes,
 *      preserving the null-engine guarantee for that section.
 *    • Section 2: engine running, zero fixer writes → green.
 *    • Section 3: real write with actor='hygiene-remediate' (executor) does
 *      NOT trip the guard → green.
 *    • Section 4: real write with actor='hygiene-fixer' → falsifier throws
 *      "PROPOSE-ONLY VIOLATED" (the load-bearing FAIL case).
 *
 *  To exercise the engine-method path (rather than the REST-API fallback
 *  that isn't reachable in unit tests), sections 2-4 monkey-patch
 *  `getWritesByAgent` onto the engine instance so the falsifier uses the
 *  faster primary branch.  The patch delegates to the real
 *  `engine.getWriteLog({ agent })` so we test against real write-log data.
 *
 *  Ordering invariant: node:test runs describe-block before() hooks just
 *  before that block's own tests.  Placing Section 1 in the first (engine-
 *  free) describe guarantees it runs with engine === null.
 *
 *  Run:
 *    node --import ./tests/vault-hygiene/register.mjs \
 *         --test --experimental-strip-types \
 *         tests/vault-hygiene/hygiene-propose-only-check.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VaultEngine } from '../../src/lib/vault/index.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function noteMd(body: string): string {
	return [
		'---',
		'type: learning',
		"created: '2026-01-01'",
		'tags: [test]',
		'---',
		'',
		body,
		'',
	].join('\n');
}

/** Monkey-patch the engine with a `getWritesByAgent` shim so the falsifier
 *  exercises its faster primary branch instead of the unavailable REST API. */
function patchEngine(eng: VaultEngine): void {
	(eng as unknown as Record<string, unknown>).getWritesByAgent = (agentId: string) =>
		eng.getWriteLog({ agent: agentId });
}

function unpatchEngine(eng: VaultEngine): void {
	delete (eng as unknown as Record<string, unknown>).getWritesByAgent;
}

// ── Section 1: No engine — MUST run before initVault ─────────────────────────
//
// No before() in this describe block.  The vault singleton starts as null
// in a fresh process; we assert the falsifier is fail-open in that state.

describe('propose-only-check — no vault engine (fail-open)', () => {
	test('returns green when engine is null', async () => {
		const { hygieneAgentProposeOnlyCheckFactory } = await import(
			'../../src/lib/scheduler/handlers/hygiene-agent-propose-only-check.ts'
		);
		const fn = hygieneAgentProposeOnlyCheckFactory({});
		const result = await fn() as Record<string, unknown>;
		assert.equal(result.ok, true, 'should return ok:true when engine is unavailable');
		assert.equal(result.status, 'green');
		// The fail-open path returns a detail that includes 'unavailable'.
		assert.ok(
			String(result.detail ?? '').toLowerCase().includes('unavailable'),
			`detail should mention 'unavailable': "${result.detail}"`,
		);
	});
});

// ── Sections 2-4: Shared engine (scoped before/after) ────────────────────────
//
// The before() fires AFTER Section 1 finishes, so Section 1 still sees null.

describe('propose-only-check — with vault engine', () => {
	let tmpVault = '';
	let eng: VaultEngine;
	let engineShutdown: () => void;

	before(async () => {
		tmpVault = await mkdtemp(join(tmpdir(), 'soul-hub-falsifier-'));
		await mkdir(join(tmpVault, 'knowledge'), { recursive: true });
		await mkdir(join(tmpVault, '.vault', 'templates'), { recursive: true });

		// Note for executor-actor write in section 3.
		await writeFile(
			join(tmpVault, 'knowledge', 'executor-write-note.md'),
			noteMd('Written by the executor (hygiene-remediate), not the fixer.'),
		);
		// Note for fixer-actor write in section 4 (FAIL case).
		await writeFile(
			join(tmpVault, 'knowledge', 'fixer-write-note.md'),
			noteMd('This note will have a write attributed to hygiene-fixer.'),
		);

		const { initVault } = await import('../../src/lib/vault/index.ts');
		eng = await initVault(tmpVault);
		engineShutdown = () => eng.shutdown();

		// Patch engine with getWritesByAgent so the falsifier uses its engine branch.
		patchEngine(eng);
	});

	after(async () => {
		unpatchEngine(eng);
		engineShutdown?.();
		await rm(tmpVault, { recursive: true, force: true });
	});

	// ── Section 2: Zero fixer writes → green ─────────────────────────────────

	test('returns green when the write log has no hygiene-fixer entries', async () => {
		const { hygieneAgentProposeOnlyCheckFactory } = await import(
			'../../src/lib/scheduler/handlers/hygiene-agent-propose-only-check.ts'
		);
		const fn = hygieneAgentProposeOnlyCheckFactory({});
		const result = await fn() as Record<string, unknown>;
		assert.equal(result.ok, true);
		assert.equal(result.status, 'green');
		assert.equal(result.fixerWriteCount, 0, 'fixerWriteCount must be 0');
		assert.equal(result.dataSource, 'engine', 'should use the engine path, not REST API');
	});

	// ── Section 3: Executor writes do NOT trip the guard ─────────────────────

	test('executor write (hygiene-remediate) does not trigger the guard', async () => {
		const updateResult = await eng.updateNote(
			'knowledge/executor-write-note.md',
			{ content: noteMd('Updated by the executor.') },
			{ actor: 'hygiene-remediate', actorContext: 'test: executor-actor write' },
		);
		assert.ok(
			'success' in updateResult && updateResult.success,
			`engine.updateNote must succeed: ${JSON.stringify(updateResult)}`,
		);

		// Confirm the executor write is in the log.
		const remediateWrites = eng.getWriteLog({ agent: 'hygiene-remediate' });
		assert.ok(remediateWrites.length > 0, 'hygiene-remediate write must be logged');

		// Falsifier must still return green (only checks hygiene-fixer).
		const { hygieneAgentProposeOnlyCheckFactory } = await import(
			'../../src/lib/scheduler/handlers/hygiene-agent-propose-only-check.ts'
		);
		const fn = hygieneAgentProposeOnlyCheckFactory({});
		const result = await fn() as Record<string, unknown>;
		assert.equal(result.ok, true);
		assert.equal(result.status, 'green');
		assert.equal(result.fixerWriteCount, 0, 'executor writes must not be counted as fixer writes');
	});

	// ── Section 4: Fixer write → FAIL (load-bearing test) ───────────────────

	test('throws PROPOSE-ONLY VIOLATED when a hygiene-fixer write is in the log', async () => {
		// Perform a write with actor='hygiene-fixer' to simulate a propose-only leak.
		const updateResult = await eng.updateNote(
			'knowledge/fixer-write-note.md',
			{ content: noteMd('Mutated directly by the fixer — this is the violation.') },
			{ actor: 'hygiene-fixer', actorContext: 'test: intentional fixer-actor write' },
		);
		assert.ok(
			'success' in updateResult && updateResult.success,
			`engine.updateNote must succeed for FAIL test setup: ${JSON.stringify(updateResult)}`,
		);

		// Confirm the fixer write is in the log.
		const fixerWrites = eng.getWriteLog({ agent: 'hygiene-fixer' });
		assert.ok(fixerWrites.length > 0, 'hygiene-fixer write must be in the log for this test');

		// Falsifier must throw.
		const { hygieneAgentProposeOnlyCheckFactory } = await import(
			'../../src/lib/scheduler/handlers/hygiene-agent-propose-only-check.ts'
		);
		const fn = hygieneAgentProposeOnlyCheckFactory({});
		// Wrap in an explicit async lambda so TypeScript sees () => Promise<unknown>
		// (TaskFn's return type is `Promise<unknown> | unknown`, which is too wide).
		await assert.rejects(async () => { await fn(); }, (err: Error) => {
			assert.ok(
				err.message.includes('PROPOSE-ONLY VIOLATED'),
				`error must include PROPOSE-ONLY VIOLATED: "${err.message}"`,
			);
			assert.ok(
				err.message.includes('hygiene-fixer'),
				`error must name the fixer agent: "${err.message}"`,
			);
			return true;
		});
	});
});
