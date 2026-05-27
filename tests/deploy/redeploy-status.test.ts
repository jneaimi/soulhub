/**
 * ADR-016 — readRedeployStatus / resetRedeployStatus unit tests.
 * ADR-018 — reconcileRedeployStatusOnBoot unit tests (falsifiers 1 + 2 from ADR-018).
 *
 * Falsifier coverage (ADR-016):
 *   1. Happy: resetRedeployStatus writes a parseable status; readRedeployStatus reads it back.
 *   2. Sad: missing file → readRedeployStatus returns { state: 'idle' }.
 *   3. Sad: corrupt file → returns { state: 'idle' }, no crash.
 *   4. Sad: valid JSON but no `state` field → returns { state: 'idle' }.
 *
 * Falsifier coverage (ADR-018):
 *   F1. Stuck→done: state:reloading + toSha===buildSha → reconciled to done.
 *   F2. Stuck→done: state:building + toSha===buildSha → reconciled to done.
 *   F3. Stuck→failed: state:reloading + toSha≠buildSha → reconciled to failed.
 *   F4. No false-success: state:reloading + no toSha → reconciled to failed.
 *   F5. Terminal states untouched: done, failed, idle → no-op.
 *   F6. Non-terminal but matching toSha preserves fromSha/startedAt.
 *   F7. Write failure does not throw (best-effort).
 *
 * Run with:
 *   node --import ./tests/deploy/register.mjs --test --experimental-strip-types \
 *     tests/deploy/redeploy-status.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Override SOUL_HUB_HOME so the status file goes to a temp dir (not ~/.soul-hub).
const TMP_HOME = resolve(tmpdir(), `soul-hub-test-${Date.now()}`);

before(() => {
	mkdirSync(resolve(TMP_HOME, 'data'), { recursive: true });
	process.env.SOUL_HUB_HOME = TMP_HOME;
});

after(() => {
	rmSync(TMP_HOME, { recursive: true, force: true });
	delete process.env.SOUL_HUB_HOME;
});

// Import AFTER setting SOUL_HUB_HOME so soulHubDataFile picks up the temp path.
import { readRedeployStatus, resetRedeployStatus, reconcileRedeployStatusOnBoot } from '$lib/redeploy/index.ts';

const STATUS_PATH = resolve(TMP_HOME, 'data', 'redeploy-status.json');

describe('readRedeployStatus + resetRedeployStatus', () => {
	test('happy: reset writes started status, read returns it', () => {
		const FROM = 'a'.repeat(40);
		const TO = 'b'.repeat(40);

		resetRedeployStatus(FROM, TO);
		const status = readRedeployStatus();

		assert.equal(status.state, 'started');
		assert.equal(status.fromSha, FROM);
		assert.equal(status.toSha, TO);
		assert.ok(typeof status.startedAt === 'string', 'startedAt should be a string');
	});

	test('sad: missing status file → { state: "idle" }, no throw', () => {
		// Delete the file if it exists from the previous test.
		if (existsSync(STATUS_PATH)) rmSync(STATUS_PATH);

		const status = readRedeployStatus();
		assert.deepEqual(status, { state: 'idle' });
	});

	test('sad: corrupt JSON → { state: "idle" }, no throw', () => {
		writeFileSync(STATUS_PATH, 'not valid json !!{{{', 'utf-8');
		const status = readRedeployStatus();
		assert.deepEqual(status, { state: 'idle' });
	});

	test('sad: valid JSON without state field → { state: "idle" }', () => {
		writeFileSync(STATUS_PATH, JSON.stringify({ foo: 'bar' }), 'utf-8');
		const status = readRedeployStatus();
		assert.deepEqual(status, { state: 'idle' });
	});

	test('sad: resetRedeployStatus with write failure does not throw', () => {
		// Temporarily make the data dir a file to cause a write failure.
		rmSync(resolve(TMP_HOME, 'data'), { recursive: true });
		writeFileSync(resolve(TMP_HOME, 'data'), 'not a dir'); // file, not dir

		// Should not throw — best-effort.
		assert.doesNotThrow(() => resetRedeployStatus('a'.repeat(40), 'b'.repeat(40)));

		// Restore for subsequent tests.
		rmSync(resolve(TMP_HOME, 'data'));
		mkdirSync(resolve(TMP_HOME, 'data'), { recursive: true });
	});
});

// ── ADR-018 falsifiers ─────────────────────────────────────────────────────

const BUILD_SHA = 'c'.repeat(40);
const OTHER_SHA = 'd'.repeat(40);
const FROM_SHA  = 'e'.repeat(40);

describe('reconcileRedeployStatusOnBoot (ADR-018)', () => {
	// Helper: write a raw status object directly to the status file.
	function writeRawStatus(obj: Record<string, unknown>): void {
		writeFileSync(STATUS_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
	}

	test('F1: reloading + matching toSha → done (banner-unblock case)', () => {
		writeRawStatus({ state: 'reloading', toSha: BUILD_SHA, fromSha: FROM_SHA, startedAt: '2026-01-01T00:00:00Z' });
		reconcileRedeployStatusOnBoot(BUILD_SHA);
		const result = readRedeployStatus();
		assert.equal(result.state, 'done', 'state should be reconciled to done');
		assert.equal(result.toSha, BUILD_SHA, 'toSha should be preserved');
		assert.equal(result.fromSha, FROM_SHA, 'fromSha should be preserved');
		assert.ok(typeof result.finishedAt === 'string', 'finishedAt should be stamped');
	});

	test('F2: building + matching toSha → done', () => {
		writeRawStatus({ state: 'building', toSha: BUILD_SHA, fromSha: FROM_SHA, startedAt: '2026-01-01T00:00:00Z' });
		reconcileRedeployStatusOnBoot(BUILD_SHA);
		const result = readRedeployStatus();
		assert.equal(result.state, 'done');
	});

	test('F3: reloading + toSha ≠ buildSha → failed (no false-success)', () => {
		writeRawStatus({ state: 'reloading', toSha: OTHER_SHA, fromSha: FROM_SHA, startedAt: '2026-01-01T00:00:00Z' });
		reconcileRedeployStatusOnBoot(BUILD_SHA);
		const result = readRedeployStatus();
		assert.equal(result.state, 'failed', 'state should be reconciled to failed');
		assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error message should be set');
		assert.equal(result.toSha, OTHER_SHA, 'toSha should be preserved');
	});

	test('F4: reloading + no toSha → failed', () => {
		writeRawStatus({ state: 'reloading', fromSha: FROM_SHA, startedAt: '2026-01-01T00:00:00Z' });
		reconcileRedeployStatusOnBoot(BUILD_SHA);
		const result = readRedeployStatus();
		assert.equal(result.state, 'failed');
		assert.ok(typeof result.error === 'string' && result.error.length > 0);
	});

	test('F5a: terminal state "done" → untouched', () => {
		writeRawStatus({ state: 'done', toSha: BUILD_SHA, fromSha: FROM_SHA, finishedAt: '2026-01-01T01:00:00Z' });
		reconcileRedeployStatusOnBoot(BUILD_SHA);
		const result = readRedeployStatus();
		assert.equal(result.state, 'done', 'done should not be re-written');
		// finishedAt should be the original, not a new timestamp
		assert.equal(result.finishedAt, '2026-01-01T01:00:00Z');
	});

	test('F5b: terminal state "failed" → untouched', () => {
		writeRawStatus({ state: 'failed', error: 'original', toSha: OTHER_SHA });
		reconcileRedeployStatusOnBoot(BUILD_SHA);
		const result = readRedeployStatus();
		assert.equal(result.state, 'failed');
		assert.equal(result.error, 'original', 'error should be the original, not overwritten');
	});

	test('F5c: idle (missing file) → no-op, file stays absent', () => {
		if (existsSync(STATUS_PATH)) rmSync(STATUS_PATH);
		assert.doesNotThrow(() => reconcileRedeployStatusOnBoot(BUILD_SHA));
		assert.equal(existsSync(STATUS_PATH), false, 'reconcile should not create a file from idle');
	});

	test('F6: reconciled done preserves fromSha and startedAt', () => {
		const STARTED = '2026-05-27T10:00:00.000Z';
		writeRawStatus({ state: 'reloading', toSha: BUILD_SHA, fromSha: FROM_SHA, startedAt: STARTED });
		reconcileRedeployStatusOnBoot(BUILD_SHA);
		const result = readRedeployStatus();
		assert.equal(result.fromSha, FROM_SHA);
		assert.equal(result.startedAt, STARTED);
	});

	test('F7: write failure does not throw (best-effort)', () => {
		writeRawStatus({ state: 'reloading', toSha: BUILD_SHA });
		// Temporarily replace the data dir with a file to cause a write error.
		rmSync(resolve(TMP_HOME, 'data'), { recursive: true });
		writeFileSync(resolve(TMP_HOME, 'data'), 'not a dir');

		assert.doesNotThrow(() => reconcileRedeployStatusOnBoot(BUILD_SHA));

		// Restore.
		rmSync(resolve(TMP_HOME, 'data'));
		mkdirSync(resolve(TMP_HOME, 'data'), { recursive: true });
	});
});
