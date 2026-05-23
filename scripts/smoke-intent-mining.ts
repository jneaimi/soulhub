/** One-off smoke test for ADR-023 Phase 1.5.
 *
 *  Runs the analyst end-to-end against the shared SQLite DB:
 *    1. Reads last 7 days of intent_log + chat_history
 *    2. Dumps the corpus markdown
 *    3. Dispatches the intent-learner agent (claude-pty, Sonnet)
 *    4. Reads + validates the JSON proposals file
 *    5. Persists survivors to intent_patterns_proposed
 *    6. Sends Telegram nudge with [Review][Approve all][Skip]
 *
 *  Bypasses minNewRows gate (lastRunAt: 0). Used once to validate the
 *  build; the scheduler handler fires the same `runIntentMining` on cron. */

import { runIntentMining } from '../src/lib/intent/learner.js';

const result = await runIntentMining({
	lookbackDays: 7,
	minNewRows: 0, // bypass watermark for smoke
	notify: 'telegram',
});

console.log('\n=== SMOKE RESULT ===');
console.log(JSON.stringify(result, null, 2));

if (result.skipped) {
	console.log(`\n⚠ skipped: ${result.skipReason}`);
	process.exit(2);
}

if (result.agentStatus !== 'success') {
	console.log(`\n✗ agent status: ${result.agentStatus}`);
	process.exit(1);
}

console.log(`\n✅ smoke passed`);
console.log(`   corpus: ${result.corpusPath}`);
console.log(`   report: ${result.reportPath}`);
console.log(`   proposals JSON: ${result.proposalsPath}`);
console.log(`   accepted: ${result.proposalsAccepted}`);
console.log(`   telegram nudge sent: ${result.telegramNudgeSent}`);
