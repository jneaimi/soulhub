/** Phase 4 voice-queue smoke test.
 *
 *  Two layers:
 *
 *   1. Pure function `isWithinEligibilityWindow` — covers the date-window
 *      semantics added in ADR-003 amended (`voice_due:` deferred eligibility).
 *      No vault, no DB needed.
 *
 *   2. DB helpers `markVoiceAcked` / `getAckedPaths` / `pruneOldVoiceAcks`
 *      — verifies the v5 migration ran and the ack flow round-trips.
 *
 *  Vault integration (`getEligibleVoiceItems`) needs an initialised
 *  VaultEngine which only the running app has — that's exercised live in
 *  the post-deploy verification step, not here.
 *
 *  Run: `npx tsx scripts/smoke-test-voice-queue.ts`
 */

import { isWithinEligibilityWindow } from '../src/lib/vault/voice-queue.js';
import {
	getHeartbeatDb,
	markVoiceAcked,
	getAckedPaths,
	isVoiceAcked,
	pruneOldVoiceAcks,
	applyReplyAck,
} from '../src/lib/channels/whatsapp/heartbeat-state.js';

let passed = 0;
let failed = 0;

function check(label: string, predicate: boolean, detail?: string): void {
	if (predicate) {
		console.log(`  ✓ ${label}`);
		passed += 1;
	} else {
		console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
		failed += 1;
	}
}

const TEST_PREFIX = 'inbox/_test-voice-queue/';

function cleanTestRows(): void {
	const db = getHeartbeatDb();
	db.prepare("DELETE FROM voice_acks WHERE note_path LIKE ?").run(`${TEST_PREFIX}%`);
}

function main(): void {
	console.log('— eligibility window (pure) —');

	const T = (iso: string) => new Date(iso);
	const NOW = T('2026-05-04T14:00:00Z');

	// No voice_due → 48h since `created` window
	check(
		'no due, created 1h ago → eligible',
		isWithinEligibilityWindow(T('2026-05-04T13:00:00Z'), null, NOW),
	);
	check(
		'no due, created 60h ago → not eligible (>48h)',
		!isWithinEligibilityWindow(T('2026-05-02T02:00:00Z'), null, NOW),
	);
	check(
		'no due, no created → never eligible',
		!isWithinEligibilityWindow(null, null, NOW),
	);
	check(
		'no due, created exactly 48h ago → still eligible (boundary)',
		isWithinEligibilityWindow(T('2026-05-02T14:00:00Z'), null, NOW),
	);

	// voice_due → today >= due AND today <= due + 14d
	check(
		'due tomorrow → not eligible (before due)',
		!isWithinEligibilityWindow(T('2026-05-04T00:00:00Z'), T('2026-05-05T00:00:00Z'), NOW),
	);
	check(
		'due today → eligible',
		isWithinEligibilityWindow(T('2026-05-04T00:00:00Z'), T('2026-05-04T00:00:00Z'), NOW),
	);
	check(
		'due 7d ago → eligible (within 14d post-due window)',
		isWithinEligibilityWindow(T('2026-04-15T00:00:00Z'), T('2026-04-27T00:00:00Z'), NOW),
	);
	check(
		'due 15d ago → not eligible (past 14d post-due window)',
		!isWithinEligibilityWindow(T('2026-04-15T00:00:00Z'), T('2026-04-19T00:00:00Z'), NOW),
	);

	// voice_due ignores 48h-since-created — important: a Phase-5 milestone
	// note hand-written today with voice_due:2026-05-16 must NOT expire by
	// 48h-since-created on 2026-05-06.
	check(
		'created 12 days ago + due today → eligible (due window wins)',
		isWithinEligibilityWindow(T('2026-04-22T00:00:00Z'), T('2026-05-04T00:00:00Z'), NOW),
	);

	console.log('— DB ack helpers (round-trip) —');

	cleanTestRows();
	const a = `${TEST_PREFIX}note-a.md`;
	const b = `${TEST_PREFIX}note-b.md`;
	const c = `${TEST_PREFIX}note-c.md`;

	check('isVoiceAcked(a) is false initially', !isVoiceAcked(a));

	markVoiceAcked([a, b], 'auto');
	check('isVoiceAcked(a) true after mark', isVoiceAcked(a));
	check('isVoiceAcked(b) true after mark', isVoiceAcked(b));
	check('isVoiceAcked(c) still false', !isVoiceAcked(c));

	const set = getAckedPaths([a, b, c]);
	check('getAckedPaths returns a + b only', set.has(a) && set.has(b) && !set.has(c), `got ${[...set].join(', ')}`);

	// Idempotency — re-acking should not throw, no new row.
	markVoiceAcked([a], 'auto');
	const all = getHeartbeatDb()
		.prepare("SELECT COUNT(*) AS n FROM voice_acks WHERE note_path LIKE ?")
		.get(`${TEST_PREFIX}%`) as { n: number };
	check('re-ack is idempotent (still 2 rows for a + b)', all.n === 2, `got ${all.n}`);

	// Prune — set acked_at to 31 days ago and verify pruneOldVoiceAcks removes it.
	const longAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
	getHeartbeatDb().prepare('UPDATE voice_acks SET acked_at = ? WHERE note_path = ?').run(longAgo, a);
	const removed = pruneOldVoiceAcks();
	check('pruneOldVoiceAcks dropped 1 stale row', removed === 1, `removed ${removed}`);
	check('a is no longer acked after prune', !isVoiceAcked(a));
	check('b is still acked after prune (only a was stale)', isVoiceAcked(b));

	cleanTestRows();
	check('cleanup leaves zero test rows', !isVoiceAcked(a) && !isVoiceAcked(b));

	console.log('— reply-ack (Phase 4.5) —');

	// Setup: three auto-acked rows, fresh.
	cleanTestRows();
	const x = `${TEST_PREFIX}reply-x.md`;
	const y = `${TEST_PREFIX}reply-y.md`;
	const z = `${TEST_PREFIX}reply-z.md`;
	markVoiceAcked([x, y, z], 'auto');
	check('three auto-acked rows present', isVoiceAcked(x) && isVoiceAcked(y) && isVoiceAcked(z));

	// done/skip/later all UPDATE the recent rows.
	const doneCount = applyReplyAck('reply-done');
	check('reply-done updates recent auto rows (3)', doneCount === 3, `got ${doneCount}`);

	// Re-applying after upgrade should be no-op (rows aren't 'auto' anymore).
	const noop = applyReplyAck('reply-skip');
	check('subsequent reply-skip does not double-apply', noop === 0, `got ${noop}`);

	// Items with reply-done remain acked (no cooldown — permanent).
	check('reply-done items still acked', isVoiceAcked(x) && isVoiceAcked(y) && isVoiceAcked(z));

	// reply-later cooldown: a fresh auto-acked row gets a 4h cooldown,
	// items remain "acked" until the cooldown expires.
	cleanTestRows();
	const p = `${TEST_PREFIX}reply-p.md`;
	markVoiceAcked([p], 'auto');
	const laterCount = applyReplyAck('reply-later');
	check('reply-later updates 1 row', laterCount === 1);
	check('reply-later item still acked while cooldown active', isVoiceAcked(p));

	// Force cooldown into the past — note becomes re-eligible.
	const past = Date.now() - 1000;
	getHeartbeatDb().prepare('UPDATE voice_acks SET cooldown_until = ? WHERE note_path = ?').run(past, p);
	check('after cooldown expires, isVoiceAcked is false', !isVoiceAcked(p));
	check('after cooldown expires, getAckedPaths excludes the row', !getAckedPaths([p]).has(p));

	// Window: rows older than 30 min are NOT touched by applyReplyAck.
	cleanTestRows();
	const oldRow = `${TEST_PREFIX}old.md`;
	const recentRow = `${TEST_PREFIX}recent.md`;
	markVoiceAcked([oldRow, recentRow], 'auto');
	const oldTs = Date.now() - 31 * 60 * 1000; // 31 min ago
	getHeartbeatDb().prepare('UPDATE voice_acks SET acked_at = ? WHERE note_path = ?').run(oldTs, oldRow);
	const winCount = applyReplyAck('reply-skip');
	check('window respects 30-min default — only recent row updated', winCount === 1, `got ${winCount}`);

	// Edge: applyReplyAck with no recent rows → returns 0 (dispatcher
	// uses this to decide whether to short-circuit).
	cleanTestRows();
	const empty = applyReplyAck('reply-done');
	check('applyReplyAck on empty table returns 0', empty === 0, `got ${empty}`);

	cleanTestRows();
	check('final cleanup', !isVoiceAcked(p) && !isVoiceAcked(x));

	console.log(`\n${passed} passed / ${failed} failed`);
	if (failed > 0) process.exit(1);
}

main();
