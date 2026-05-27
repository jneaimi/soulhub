/**
 * soul-hub-agents ADR-018 — benign-drift guard tests.
 *
 * The load-bearing guarantee: the ship-merge clean-tree guard tolerates the
 * GitNexus index-count drift in AGENTS.md/CLAUDE.md but still blocks on ANY
 * real uncommitted change — so a merge can never silently proceed over real work.
 *
 * Run: node --import ./tests/agents/register.mjs --test --experimental-strip-types tests/agents/benign-drift.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	isBenignDriftPath,
	nonBenignDirtyPaths,
	BENIGN_DRIFT_PATHS,
} from '../../src/lib/agents/benign-drift.js';

test('BENIGN_DRIFT_PATHS is exactly the two GitNexus files', () => {
	assert.equal(BENIGN_DRIFT_PATHS.size, 2);
	assert.ok(BENIGN_DRIFT_PATHS.has('AGENTS.md'));
	assert.ok(BENIGN_DRIFT_PATHS.has('CLAUDE.md'));
});

test('isBenignDriftPath: the two drift files only (exact, root-relative)', () => {
	assert.equal(isBenignDriftPath('AGENTS.md'), true);
	assert.equal(isBenignDriftPath('CLAUDE.md'), true);
	assert.equal(isBenignDriftPath(' CLAUDE.md '), true, 'trims');
	assert.equal(isBenignDriftPath('src/foo.ts'), false);
	assert.equal(isBenignDriftPath('docs/CLAUDE.md'), false, 'nested CLAUDE.md is NOT auto-benign');
});

test('nonBenignDirtyPaths: only-drift dirty tree reads as clean', () => {
	assert.deepEqual(nonBenignDirtyPaths(' M AGENTS.md\n M CLAUDE.md\n'), []);
});

test('nonBenignDirtyPaths: a real dirty file blocks (returned)', () => {
	assert.deepEqual(nonBenignDirtyPaths(' M AGENTS.md\n M src/lib/foo.ts\n'), ['src/lib/foo.ts']);
});

test('nonBenignDirtyPaths: empty (truly clean) → []', () => {
	assert.deepEqual(nonBenignDirtyPaths(''), []);
});

test('nonBenignDirtyPaths: untracked + staged + rename are all parsed', () => {
	assert.deepEqual(nonBenignDirtyPaths('?? newfile.ts\n'), ['newfile.ts']);
	assert.deepEqual(nonBenignDirtyPaths('MM src/x.ts\n'), ['src/x.ts']);
	assert.deepEqual(nonBenignDirtyPaths('R  old.ts -> src/new.ts\n'), ['src/new.ts'], 'rename keys on new path');
});

test('nonBenignDirtyPaths: mixed benign + real → only the real path', () => {
	const porcelain = ' M CLAUDE.md\n M AGENTS.md\n M src/routes/api/agents/ship-merge/+server.ts\n';
	assert.deepEqual(nonBenignDirtyPaths(porcelain), ['src/routes/api/agents/ship-merge/+server.ts']);
});
