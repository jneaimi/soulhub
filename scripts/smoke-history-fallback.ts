/** P3 smoke — exercises tryHistoryFallback (ADR-023 §Phase 3).
 *
 *  Seeds synthetic rows into intent_log, then verifies:
 *    (a) high-agreement → hit at conf=1.0
 *    (b) mixed routes below minAgreement → null
 *    (c) too few votes → null
 *    (d) `source='fallback'` rows excluded from voting
 *    (e) old rows outside windowDays excluded
 *    (f) end-to-end via routeFreeForm with historyFallback gate on
 *
 *  Cleans up all seeded rows on exit. */

import { getInboxDb } from '../src/lib/inbox/db.js';
import { tryHistoryFallback } from '../src/lib/intent/patterns.js';
import { normalizeSignature } from '../src/lib/intent/normalize.js';
import { routeFreeForm } from '../src/lib/channels/whatsapp/router.js';
import { config } from '../src/lib/config.js';

const TEST_CK = 'smoke-history-conversation-key';
// Carefully chosen to NOT match any regex bucket in regexPreFilter:
// no "inbox/email/queued/receipts/recent/latest/show me/what's new/find/where",
// no bare digits, no acknowledgment word, no analysis-intent verb. The
// normalized_signature still produces a stable string for history grouping.
const TEST_MSG = 'smoke history fixture phrase alpha bravo';
const SIG = normalizeSignature(TEST_MSG);

const db = getInboxDb();

function setHistoryGate(enabled: boolean) {
	(config as { intent?: { patternEngine?: { historyFallback?: boolean; enabled?: boolean } } }).intent ??= {};
	const intent = config.intent as { patternEngine: { historyFallback: boolean; enabled: boolean; historyMinVotes?: number; historyMinAgreement?: number; historyWindowDays?: number } };
	intent.patternEngine ??= { enabled: false, historyFallback: false };
	intent.patternEngine.historyFallback = enabled;
	intent.patternEngine.enabled = false; // ensure P2 doesn't preempt P3
}

function cleanup() {
	db.prepare(`DELETE FROM intent_log WHERE conversation_key = ?`).run(TEST_CK);
}

function seedRows(rows: Array<{ route: string; source?: 'llm' | 'regex' | 'pattern' | 'fallback'; ageDays?: number }>) {
	const now = Date.now();
	const stmt = db.prepare(
		`INSERT OR REPLACE INTO intent_log
		 (ts, conversation_key, raw_message, normalized_signature, picked_route, source, confidence)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	rows.forEach((r, i) => {
		const ts = now - (r.ageDays ?? 0) * 24 * 60 * 60 * 1000 - i; // unique ts
		stmt.run(ts, TEST_CK, TEST_MSG, SIG, r.route, r.source ?? 'llm', 0.7);
	});
}

console.log('=== P3 smoke ===');
console.log(`normalized_signature = "${SIG}"`);
cleanup();

// ── (a) HIGH AGREEMENT — 6 rows all to vault-chat ──
seedRows([
	{ route: 'vault-chat' }, { route: 'vault-chat' }, { route: 'vault-chat' },
	{ route: 'vault-chat' }, { route: 'vault-chat' }, { route: 'vault-chat' },
]);
const a = tryHistoryFallback(TEST_MSG, TEST_CK);
console.log(`\n(a) HIGH — 6/6 vault-chat:`);
console.log(`    hit? ${a !== null}`);
console.log(`    route=${a?.pickedRoute} conf=${a?.confidence}`);
console.log(`    votes=${JSON.stringify(a?.votes)}`);
console.log(`    kind=${a?.kind} patternId=${a?.patternId}`);

cleanup();

// ── (b) BELOW AGREEMENT — 4 vault-chat + 1 vault-find → 4/5 = 0.80 (< 0.90) ──
seedRows([
	{ route: 'vault-chat' }, { route: 'vault-chat' }, { route: 'vault-chat' },
	{ route: 'vault-chat' }, { route: 'vault-find' },
]);
const b = tryHistoryFallback(TEST_MSG, TEST_CK);
console.log(`\n(b) BELOW AGREEMENT — 4/5 vault-chat, 1 vault-find (0.80 < 0.90):`);
console.log(`    result=${b === null ? 'null (correct)' : 'HIT (BUG)'}`);

cleanup();

// ── (c) TOO FEW VOTES — 4 rows ──
seedRows([
	{ route: 'vault-chat' }, { route: 'vault-chat' },
	{ route: 'vault-chat' }, { route: 'vault-chat' },
]);
const c = tryHistoryFallback(TEST_MSG, TEST_CK);
console.log(`\n(c) TOO FEW VOTES — 4 rows (< minVotes 5):`);
console.log(`    result=${c === null ? 'null (correct)' : 'HIT (BUG)'}`);

cleanup();

// ── (d) FALLBACK ROWS EXCLUDED — 5 fallback + 1 llm vault-chat ──
seedRows([
	{ route: 'vault-chat', source: 'fallback' },
	{ route: 'vault-chat', source: 'fallback' },
	{ route: 'vault-chat', source: 'fallback' },
	{ route: 'vault-chat', source: 'fallback' },
	{ route: 'vault-chat', source: 'fallback' },
	{ route: 'vault-chat', source: 'llm' },
]);
const d = tryHistoryFallback(TEST_MSG, TEST_CK);
console.log(`\n(d) FALLBACK EXCLUDED — 5 fallback + 1 llm:`);
console.log(`    result=${d === null ? 'null (correct — only 1 valid vote)' : 'HIT (BUG)'}`);

cleanup();

// ── (e) OLD ROWS EXCLUDED — 6 rows, all 60 days old (window 30) ──
seedRows([
	{ route: 'vault-chat', ageDays: 60 }, { route: 'vault-chat', ageDays: 60 },
	{ route: 'vault-chat', ageDays: 60 }, { route: 'vault-chat', ageDays: 60 },
	{ route: 'vault-chat', ageDays: 60 }, { route: 'vault-chat', ageDays: 60 },
]);
const e = tryHistoryFallback(TEST_MSG, TEST_CK);
console.log(`\n(e) WINDOW EXCLUSION — 6 rows 60d old (window 30d):`);
console.log(`    result=${e === null ? 'null (correct)' : 'HIT (BUG)'}`);

cleanup();

// ── (f) END-TO-END via routeFreeForm with the gate on ──
seedRows([
	{ route: 'vault-chat' }, { route: 'vault-chat' }, { route: 'vault-chat' },
	{ route: 'vault-chat' }, { route: 'vault-chat' }, { route: 'vault-chat' },
]);
setHistoryGate(true);
console.log(`\n(f) WIRE — routeFreeForm with historyFallback ON:`);
const decision = await routeFreeForm(TEST_MSG, TEST_CK);
console.log(`    decision.source=${decision.source} (expect "pattern")`);
console.log(`    decision.route=${decision.route} (expect vault-chat)`);
console.log(`    decision.reason=${decision.reason}`);
console.log(`    decision.patternId=${decision.patternId} (expect undefined — history hits don't carry an id)`);

// Verify the routeFreeForm call also wrote a row to intent_log via persistDecision
const lastLogRow = db
	.prepare(
		`SELECT source, picked_route FROM intent_log
		 WHERE conversation_key = ? ORDER BY ts DESC LIMIT 1`,
	)
	.get(TEST_CK) as { source: string; picked_route: string } | undefined;
console.log(`    last intent_log row source=${lastLogRow?.source} (expect "pattern")`);

cleanup();
console.log(`\n=== cleanup complete ===`);
console.log(`✅ P3 smoke complete`);
