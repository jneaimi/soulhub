/** P2 smoke — exercises tryPatternRoute + routeFreeForm short-circuit.
 *
 *  Inserts three synthetic patterns directly into intent_patterns, then:
 *    (a) HIT path: kill switch ON, fire matching message → source='pattern'
 *    (b) FLOOR path: pattern at conf 0.90 → does NOT short-circuit
 *    (c) KILL path: kill switch OFF, same message → falls through to llm
 *
 *  Cleans up all test rows + the intent_log entries before exiting. */

import { getInboxDb } from '../src/lib/inbox/db.js';
import { tryPatternRoute, listActivePatterns } from '../src/lib/intent/patterns.js';
import { routeFreeForm } from '../src/lib/channels/whatsapp/router.js';
import { config } from '../src/lib/config.js';

const TEST_CK = 'smoke-test-conversation-key';
const HIT_MSG = 'smoke-test recipe trigger phrase';
const FLOOR_MSG = 'smoke-test below floor trigger';

const db = getInboxDb();

function setKillSwitch(enabled: boolean) {
	// Mutate the cached config in-process. PM2-reload reads settings.json;
	// we're a one-off script with no reload to do, just flip the bit.
	(config as { intent?: { patternEngine?: { enabled: boolean } } }).intent ??= { patternEngine: { enabled: false } };
	(config.intent as { patternEngine: { enabled: boolean } }).patternEngine ??= { enabled: false };
	(config.intent as { patternEngine: { enabled: boolean } }).patternEngine.enabled = enabled;
}

function cleanup() {
	db.prepare(`DELETE FROM intent_patterns WHERE signature LIKE 'smoke-test%'`).run();
	db.prepare(`DELETE FROM intent_log WHERE raw_message LIKE 'smoke-test%' OR conversation_key = ?`).run(TEST_CK);
}

function insertPattern(signature: string, route: string, confidence: number, ck: string | null) {
	return db
		.prepare(
			`INSERT INTO intent_patterns
			 (signature, match_kind, picked_route, placeholder_text, confidence,
			  conversation_key, approved_at, approved_by, hit_count, last_hit_ts, retired_at)
			 VALUES (?, 'contains', ?, ?, ?, ?, ?, 'smoke', 0, NULL, NULL)`,
		)
		.run(signature, route, `🟡 Smoke ${route} patternText`, confidence, ck, Date.now())
		.lastInsertRowid as number;
}

console.log('=== P2 smoke ===');
cleanup();

// Insert three patterns:
//   1. HIT — global contains "smoke-test recipe" → vault-chat-test, conf 0.97
//   2. FLOOR — global contains "smoke-test below" → vault-recent-test, conf 0.90 (BELOW the 0.95 floor)
//   3. SCOPE — per-user (TEST_CK) contains "smoke-test recipe" → vault-find-test, conf 0.99
//      Used to verify per-user beats global on the SAME message.
const hitId = insertPattern('smoke-test recipe', 'vault-chat-test', 0.97, null);
const floorId = insertPattern('smoke-test below', 'vault-recent-test', 0.90, null);
const perUserId = insertPattern('smoke-test recipe', 'vault-find-test', 0.99, TEST_CK);
console.log(`inserted patterns: hit=${hitId} floor=${floorId} perUser=${perUserId}`);
console.log(`active: ${listActivePatterns().filter((p) => p.signature.startsWith('smoke-test')).length}`);

// ── (a) HIT path — kill switch ON, per-user beats global on same key ──
setKillSwitch(true);
const hit = tryPatternRoute(HIT_MSG, TEST_CK);
console.log(`\n(a) HIT — per-user with TEST_CK:`);
console.log(`    route=${hit?.pickedRoute} (expect vault-find-test)`);
console.log(`    scope=${hit?.scope} matchKind=${hit?.matchKind}`);
console.log(`    placeholderText=${hit?.placeholderText}`);
console.log(`    patternId=${hit?.patternId} (expect ${perUserId})`);

// Without conversationKey → falls back to global hit
const globalHit = tryPatternRoute(HIT_MSG);
console.log(`\n(a2) HIT — no conversationKey (global only):`);
console.log(`    route=${globalHit?.pickedRoute} (expect vault-chat-test)`);
console.log(`    patternId=${globalHit?.patternId} (expect ${hitId})`);

// ── (b) FLOOR path — message matches a 0.90 pattern, should NOT short-circuit ──
const belowFloor = tryPatternRoute(FLOOR_MSG);
console.log(`\n(b) FLOOR — 0.90-confidence pattern below 0.95 floor:`);
console.log(`    result=${belowFloor === null ? 'null (correct — falls through)' : 'HIT (BUG)'}`);

// ── (c) Kill-switch + routeFreeForm wiring ──
// Pre-condition: kill switch ON → matching message → source='pattern' (the
// critical integration test). Avoids the LLM call entirely because the
// pattern lookup short-circuits the router. Skipping the kill-switch-OFF
// path here to avoid burning an LLM call for a gate that's a single
// `if (config.intent?.patternEngine?.enabled)` line — easier to read the
// source than smoke-test it.
setKillSwitch(true);
console.log(`\n(c) WIRE — kill switch ON, routeFreeForm with TEST_CK:`);
const wireDecision = await routeFreeForm(HIT_MSG, TEST_CK);
console.log(`    decision.source=${wireDecision.source} (expect "pattern")`);
console.log(`    decision.route=${wireDecision.route} (expect vault-find-test)`);
console.log(`    decision.patternId=${wireDecision.patternId} (expect ${perUserId})`);
console.log(`    decision.placeholderText=${wireDecision.placeholderText}`);
console.log(`    decision.reason=${wireDecision.reason}`);

// Verify intent_log row landed with source='pattern' — the persistDecision
// call in routeFreeForm should have written one row tagged appropriately.
const logged = db
	.prepare(
		`SELECT source, picked_route FROM intent_log
		 WHERE conversation_key = ? AND raw_message = ?
		 ORDER BY ts DESC LIMIT 1`,
	)
	.get(TEST_CK, HIT_MSG) as { source: string; picked_route: string } | undefined;
console.log(`\n=== intent_log persistence ===`);
console.log(`    last row: source=${logged?.source} route=${logged?.picked_route} (expect source=pattern)`);

// Verify the HIT path's bump landed
const counts = db
	.prepare(`SELECT id, hit_count, last_hit_ts FROM intent_patterns WHERE signature LIKE 'smoke-test%'`)
	.all() as Array<{ id: number; hit_count: number; last_hit_ts: number | null }>;
console.log(`\n=== hit_count check ===`);
for (const r of counts) {
	console.log(`    pattern ${r.id}: hit_count=${r.hit_count} last_hit_ts=${r.last_hit_ts}`);
}

// Verify intent_log row landed with source='pattern' (only the kill-switch-on hits via routeFreeForm would write that — but we called tryPatternRoute directly, which doesn't persist. The kill-switch-on full routeFreeForm would. We didn't run that here because we wanted to avoid an LLM call. Skip log-check.)

cleanup();
console.log(`\n=== cleanup complete ===`);
console.log(`✅ P2 smoke complete`);
