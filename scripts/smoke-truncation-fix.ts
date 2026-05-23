/** Verify the 2026-05-14 truncation fix.
 *
 *  Replays the exact prompt that surfaced the bug ("Let's get something out
 *  there from our content menu and see which is worth writing about?") with
 *  the same history Jasem saw — a heartbeat focus message preceding it.
 *
 *  Checks:
 *    - tools used (expects vaultSearch chain on content/signal-forge/reports)
 *    - stepsUsed (expects <= MAX_STEPS=8, ideally < 5 after the bump)
 *    - output ends on sentence-terminal punctuation (no half-sentence)
 *    - output length is substantive (not a 1-char abstain fallback)
 *
 *  Run:
 *    npx tsx scripts/smoke-truncation-fix.ts
 *  Or against a different branch:
 *    BRANCH=glm-4.6 npx tsx scripts/smoke-truncation-fix.ts */

const BRANCH = process.env.BRANCH ?? 'deepseek-v4-pro';
process.env.ORCHESTRATOR_V2_BRANCH_OVERRIDE = BRANCH;

import { decideV2 } from '../src/lib/orchestrator-v2/index.js';
import { config } from '../src/lib/config.js';
import { getInboxDb } from '../src/lib/inbox/db.js';
import { initVault } from '../src/lib/vault/index.js';

const TEST_CK = `smoke-trunc:${BRANCH}:${Date.now()}`;
const PROMPT = "Let's get something out there from our content menu and see which is worth writing about?";
const PRIOR_ASSISTANT = `Hey Jasem. You've got a 2-slot focus today: signal-forge is at the top of the list, but social-media-launch has been stalled for 10 days and needs a nudge.\n(reply 'done' / 'skip' / 'later' to ack · 'more' for sources)`;

async function main() {
	console.log(`=== Truncation-fix smoke ===`);
	console.log(`branch: ${BRANCH}`);
	console.log(`conversationKey: ${TEST_CK}`);
	const vaultStart = Date.now();
	await initVault(config.resolved.vaultDir);
	console.log(`vault initialized in ${Date.now() - vaultStart}ms`);
	console.log('');

	const start = Date.now();
	const result = await decideV2(PROMPT, {
		history: [{ role: 'assistant', content: PRIOR_ASSISTANT }],
		conversationKey: TEST_CK,
		senderNumber: '+971000000099',
		channel: 'whatsapp',
		account: config.account ?? 'jasem',
		timezone: 'Asia/Dubai',
		imgConfig: { enabled: false, maxPerDay: 0, systemPromptPath: '' },
		youtubeConfig: { enabled: false, maxPerDay: 0 },
		tiktokConfig: { enabled: false, maxPerDay: 0, maxDurationSec: 0 },
		remindersConfig: { enabled: config.reminders?.enabled ?? true },
		heartbeatConfig: {
			enabled: false,
			activeHours: { start: '08:00', end: '23:00', timezone: 'Asia/Dubai' },
			muteUntil: null,
		},
	});
	const elapsed = Date.now() - start;

	const out = result.v2Output;
	const tools = (result.telemetry?.toolCalls ?? []).map((t) => `${t.name}(${t.argSummary})`);
	const stepsUsed = result.telemetry?.stepsUsed;
	const text =
		out?.kind === 'text' ? out.text :
		out?.kind === 'proposal' ? `[PROPOSAL] ${out.text}` :
		out?.kind === 'error' ? `[ERROR] ${out.text}` :
		`(${out?.kind ?? 'none'})`;

	console.log(`branch=${result.telemetry?.modelBranch} model=${result.telemetry?.model}`);
	console.log(`steps=${stepsUsed} latency=${elapsed}ms cost=$${(result.telemetry?.costUsd ?? 0).toFixed(5)}`);
	console.log(`tools (${tools.length}):`);
	for (const t of tools) console.log(`  - ${t}`);
	console.log(``);
	console.log(`reply length: ${text.length}`);
	console.log(`reply tail: ${JSON.stringify(text.slice(-100))}`);
	console.log(``);
	console.log(`--- full reply ---`);
	console.log(text);
	console.log(`---`);

	const endsCleanly = /[.!?)\]"'`»”]\s*$/.test(text.trim());
	console.log(``);
	console.log(`PASS criteria:`);
	console.log(`  steps <= 8:           ${stepsUsed !== undefined && stepsUsed <= 8 ? 'OK' : 'FAIL'} (got ${stepsUsed})`);
	console.log(`  length >= 50:         ${text.length >= 50 ? 'OK' : 'FAIL'} (got ${text.length})`);
	console.log(`  ends on terminator:   ${endsCleanly ? 'OK' : 'FAIL'} (tail=${JSON.stringify(text.trim().slice(-20))})`);
	console.log(``);

	// Cleanup
	const db = getInboxDb();
	const d1 = db.prepare(`DELETE FROM chat_history WHERE conversation_key = ?`).run(TEST_CK);
	const d2 = db.prepare(`DELETE FROM intent_log WHERE conversation_key = ?`).run(TEST_CK);
	const d3 = db.prepare(`DELETE FROM model_branch_assignment WHERE conversation_key = ?`).run(TEST_CK);
	console.log(`cleanup: chat_history=${d1.changes} intent_log=${d2.changes} branch_assignment=${d3.changes}`);

	process.exit(endsCleanly && text.length >= 50 && (stepsUsed ?? 99) <= 8 ? 0 : 1);
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
