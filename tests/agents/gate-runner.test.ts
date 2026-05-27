/**
 * soul-hub-agents ADR-016 — gate-runner synthesis tests.
 *
 * The load-bearing guarantee: a hand-back the gate-runner SYNTHESIZES (when the
 * agent emitted none) must be indistinguishable to the shared parser from one
 * the agent itself emitted — same shape, same green/red verdict — so the review
 * card + Ship & merge hydrate with zero special-casing.
 *
 * Run: node --import ./tests/agents/register.mjs --test --experimental-strip-types tests/agents/gate-runner.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeHandback } from '../../src/lib/agents/dispatch/gate-runner.js';
import { parseHandback, handbackGatesGreen } from '../../src/lib/agents/handback.js';

const BRANCH = 'orchestration/run-1779879398571/adr-002-chat-scope-provider';

test('synthesized hand-back round-trips through the shared parseHandback', () => {
	const block = synthesizeHandback({
		branch: BRANCH,
		commits: ['3465841abc'],
		files_changed: ['src/lib/chat/scope/resolve.ts'],
		typecheckOk: true,
		buildOk: true,
	});
	const parsed = parseHandback(block);
	assert.ok(parsed, 'parseHandback must recover the synthesized block');
	assert.equal(parsed!.branch, BRANCH);
	assert.equal(parsed!.check_passed, true);
	assert.equal(parsed!.build_passed, true);
	assert.deepEqual(parsed!.commits, ['3465841abc']);
	assert.deepEqual(parsed!.files_changed, ['src/lib/chat/scope/resolve.ts']);
});

test('both gates pass → handbackGatesGreen true', () => {
	const parsed = parseHandback(
		synthesizeHandback({ branch: BRANCH, commits: ['a'], files_changed: [], typecheckOk: true, buildOk: true }),
	);
	assert.ok(parsed);
	assert.equal(handbackGatesGreen(parsed!), true);
});

test('build fails → red verdict, never lowers the bar', () => {
	const parsed = parseHandback(
		synthesizeHandback({ branch: BRANCH, commits: ['a'], files_changed: [], typecheckOk: true, buildOk: false }),
	);
	assert.ok(parsed);
	assert.equal(parsed!.build_passed, false);
	assert.equal(parsed!.gate_results.build, 'fail');
	assert.equal(handbackGatesGreen(parsed!), false, 'a red build must block ship');
});

test('typecheck fails → red verdict', () => {
	const parsed = parseHandback(
		synthesizeHandback({ branch: BRANCH, commits: ['a'], files_changed: [], typecheckOk: false, buildOk: true }),
	);
	assert.ok(parsed);
	assert.equal(parsed!.check_passed, false);
	assert.equal(handbackGatesGreen(parsed!), false);
});

test('summary names the auto-derive provenance (operator-legible)', () => {
	const block = synthesizeHandback({
		branch: BRANCH,
		commits: ['a'],
		files_changed: [],
		typecheckOk: true,
		buildOk: true,
	});
	const parsed = parseHandback(block);
	assert.ok(parsed);
	assert.match(parsed!.summary, /auto-derived/i);
	assert.match(parsed!.summary, /ADR-016/);
});
