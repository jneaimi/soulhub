/** ADR-007 P1 — proposal-store unit tests.
 *
 *  The store is a module-level in-memory Map with a 30-minute TTL.
 *  No vault engine is needed — the store is purely in-process state.
 *
 *  Test strategy:
 *    • Use a unique per-test rowKey (counter-prefixed) to prevent any
 *      cross-test interference from the shared module-level Map.
 *    • Cover the full lifecycle: dispatching → ready | error → delete.
 *    • Cover sad paths: unknown key → null; double-delete → no-op; no-throw.
 *
 *  Run:
 *    node --import ./tests/vault-hygiene/register.mjs \
 *         --test --experimental-strip-types \
 *         tests/vault-hygiene/proposal-store.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { HygieneProposal } from '../../src/lib/vault-hygiene/agent-types.ts';

// ── Shared fixture ────────────────────────────────────────────────────────────

const SAMPLE_PROPOSAL: HygieneProposal = {
	bucket: 'unresolved',
	target: 'projects/foo/adr-001.md',
	summary: 'Retarget broken link to the moved ADR',
	confidence: 'high',
	edits: [
		{
			op: 'retarget-link',
			source: 'projects/foo/adr-001.md',
			raw: 'old-adr-slug',
			newTarget: 'archive/foo/adr-001.md',
		},
	],
	alternatives: [],
};

let _counter = 0;
/** Return a guaranteed-unique rowKey for this test run. */
function key(label = 'row'): string {
	return `test-${label}-${++_counter}`;
}

// ── Section 1: setDispatching + getProposal ───────────────────────────────────

describe('proposal-store — setDispatching', () => {
	test('creates an entry with status "dispatching"', async () => {
		const { setDispatching, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('dispatch-basic');
		setDispatching(k);
		const entry = getProposal(k);
		assert.ok(entry, 'entry should exist after setDispatching');
		assert.equal(entry.rowKey, k);
		assert.equal(entry.status, 'dispatching');
		assert.ok(typeof entry.updatedAt === 'number' && entry.updatedAt > 0, 'updatedAt must be set');
	});

	test('stores optional runId when provided', async () => {
		const { setDispatching, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('dispatch-runid');
		setDispatching(k, 'run-abc-xyz');
		const entry = getProposal(k);
		assert.ok(entry);
		assert.equal(entry.runId, 'run-abc-xyz');
	});

	test('entry has no proposal field while dispatching', async () => {
		const { setDispatching, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('dispatch-no-proposal');
		setDispatching(k);
		const entry = getProposal(k);
		assert.ok(entry);
		assert.equal(entry.proposal, undefined, 'proposal must be absent while dispatching');
		assert.equal(entry.error, undefined, 'error must be absent while dispatching');
	});
});

// ── Section 2: getProposal — sad paths ────────────────────────────────────────

describe('proposal-store — getProposal sad paths', () => {
	test('returns null for an unknown key', async () => {
		const { getProposal } = await import('../../src/lib/vault-hygiene/proposal-store.ts');
		assert.equal(getProposal('definitely-not-a-key-xyz-9999'), null);
	});
});

// ── Section 3: updateRunId ────────────────────────────────────────────────────

describe('proposal-store — updateRunId', () => {
	test('replaces the runId on an in-flight entry', async () => {
		const { setDispatching, updateRunId, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('update-runid');
		setDispatching(k, 'initial-run');
		updateRunId(k, 'final-run-id');
		const entry = getProposal(k);
		assert.ok(entry);
		assert.equal(entry.runId, 'final-run-id', 'runId should be replaced');
		assert.equal(entry.status, 'dispatching', 'status must remain dispatching');
	});

	test('is a no-op for an unknown key — does not throw', async () => {
		const { updateRunId, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		// Must not throw
		updateRunId('no-such-key-abc', 'run-xyz');
		assert.equal(getProposal('no-such-key-abc'), null);
	});
});

// ── Section 4: setReady ───────────────────────────────────────────────────────

describe('proposal-store — setReady', () => {
	test('transitions status to "ready" and stores the proposal', async () => {
		const { setDispatching, setReady, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('ready-basic');
		setDispatching(k);
		setReady(k, SAMPLE_PROPOSAL, '{"raw":"output"}');
		const entry = getProposal(k);
		assert.ok(entry);
		assert.equal(entry.status, 'ready');
		assert.deepEqual(entry.proposal, SAMPLE_PROPOSAL);
		assert.equal(entry.rawOutput, '{"raw":"output"}');
	});

	test('preserves all proposal fields faithfully', async () => {
		const { setReady, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('ready-fields');
		setReady(k, SAMPLE_PROPOSAL);
		const entry = getProposal(k);
		assert.ok(entry?.proposal);
		const p = entry.proposal!;
		assert.equal(p.bucket, 'unresolved');
		assert.equal(p.target, 'projects/foo/adr-001.md');
		assert.equal(p.confidence, 'high');
		assert.equal(p.edits.length, 1);
		assert.equal(p.edits[0].op, 'retarget-link');
		assert.equal(p.alternatives.length, 0);
	});

	test('can setReady without prior setDispatching (direct transition)', async () => {
		const { setReady, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('ready-direct');
		setReady(k, SAMPLE_PROPOSAL);
		const entry = getProposal(k);
		assert.ok(entry);
		assert.equal(entry.status, 'ready');
	});

	test('alternatives array is preserved', async () => {
		const { setReady, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const proposalWithAlts: HygieneProposal = {
			...SAMPLE_PROPOSAL,
			alternatives: [
				[{ op: 'retarget-link', source: 'x.md', raw: 'x', newTarget: 'y.md' }],
			],
		};
		const k = key('ready-alts');
		setReady(k, proposalWithAlts);
		const entry = getProposal(k);
		assert.ok(entry?.proposal);
		assert.equal(entry.proposal!.alternatives.length, 1);
		assert.equal(entry.proposal!.alternatives[0][0].op, 'retarget-link');
	});
});

// ── Section 5: setError ───────────────────────────────────────────────────────

describe('proposal-store — setError', () => {
	test('transitions status to "error" with message', async () => {
		const { setDispatching, setError, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('error-basic');
		setDispatching(k);
		setError(k, 'Agent output was not valid JSON', '>>> raw <<<');
		const entry = getProposal(k);
		assert.ok(entry);
		assert.equal(entry.status, 'error');
		assert.equal(entry.error, 'Agent output was not valid JSON');
		assert.equal(entry.rawOutput, '>>> raw <<<');
	});

	test('error entry has no proposal field', async () => {
		const { setError, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('error-no-proposal');
		setError(k, 'dispatch threw unexpectedly');
		const entry = getProposal(k);
		assert.ok(entry);
		assert.equal(entry.proposal, undefined, 'proposal must be absent on error');
	});
});

// ── Section 6: deleteProposal ─────────────────────────────────────────────────

describe('proposal-store — deleteProposal', () => {
	test('removes an existing entry', async () => {
		const { setDispatching, deleteProposal, getProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('delete-existing');
		setDispatching(k);
		assert.ok(getProposal(k), 'entry must exist before delete');
		deleteProposal(k);
		assert.equal(getProposal(k), null, 'entry must be null after delete');
	});

	test('is a no-op for an unknown key — does not throw', async () => {
		const { deleteProposal } = await import('../../src/lib/vault-hygiene/proposal-store.ts');
		assert.doesNotThrow(() => deleteProposal('ghost-key-abc-xyz'));
	});

	test('double-delete is a no-op — does not throw', async () => {
		const { setDispatching, deleteProposal } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('double-delete');
		setDispatching(k);
		deleteProposal(k);
		assert.doesNotThrow(() => deleteProposal(k));
	});
});

// ── Section 7: getStatus ──────────────────────────────────────────────────────

describe('proposal-store — getStatus', () => {
	test('returns "dispatching" for a dispatching entry', async () => {
		const { setDispatching, getStatus } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('status-dispatching');
		setDispatching(k);
		assert.equal(getStatus(k), 'dispatching');
	});

	test('returns "ready" after setReady', async () => {
		const { setReady, getStatus } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('status-ready');
		setReady(k, SAMPLE_PROPOSAL);
		assert.equal(getStatus(k), 'ready');
	});

	test('returns "error" after setError', async () => {
		const { setError, getStatus } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('status-error');
		setError(k, 'something went wrong');
		assert.equal(getStatus(k), 'error');
	});

	test('returns "not-found" for an unknown key', async () => {
		const { getStatus } = await import('../../src/lib/vault-hygiene/proposal-store.ts');
		assert.equal(getStatus('no-such-key-9999'), 'not-found');
	});

	test('returns "not-found" after deleteProposal', async () => {
		const { setDispatching, deleteProposal, getStatus } = await import(
			'../../src/lib/vault-hygiene/proposal-store.ts'
		);
		const k = key('status-after-delete');
		setDispatching(k);
		deleteProposal(k);
		assert.equal(getStatus(k), 'not-found');
	});
});
