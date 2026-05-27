/** ADR-026 follow-up — `abortsOnClientDisconnect` unit tests.
 *
 *  The predicate is the seam that lets the route guard both disconnect→abort
 *  paths without tangling mode-detection logic inline. The request-lifecycle
 *  behaviour (actual AbortController wiring) is not unit-testable here; this
 *  covers the predicate itself.
 *
 *  Run with:
 *    node --import ./tests/agents/register.mjs --test --experimental-strip-types \
 *      tests/agents/detach.test.ts */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── abortsOnClientDisconnect ──────────────────────────────────────────────

describe('abortsOnClientDisconnect', () => {
	test('production mode does NOT abort on client disconnect', async () => {
		const { abortsOnClientDisconnect } = await import(
			'../../src/lib/agents/dispatch/detach.ts'
		);
		assert.equal(abortsOnClientDisconnect('production'), false);
	});

	test('test mode DOES abort on client disconnect', async () => {
		const { abortsOnClientDisconnect } = await import(
			'../../src/lib/agents/dispatch/detach.ts'
		);
		assert.equal(abortsOnClientDisconnect('test'), true);
	});

	test('oneshot mode DOES abort on client disconnect (non-production)', async () => {
		const { abortsOnClientDisconnect } = await import(
			'../../src/lib/agents/dispatch/detach.ts'
		);
		assert.equal(abortsOnClientDisconnect('oneshot'), true);
	});
});
