/** Smoke test for Layer 3 Stage 2 — eager-mode worker hook.
 *
 *  Run: `INBOX_TRANSACTIONAL_EAGER_EXTRACT=1 npx tsx scripts/smoke-inbox-eager-extract.ts [messageId]`
 *
 *  Strategy:
 *   1. Clear extracted_data on a real transactional row so we can detect
 *      a fresh extraction.
 *   2. Call correctClassification(row, 'transactional') — exercises the
 *      worker-pipeline hook without needing a live IMAP sync to fire.
 *   3. Wait for setImmediate to drain (extraction is fire-and-forget).
 *   4. Verify extracted_data is repopulated AND an agent_actions row
 *      with actor='worker' exists. */

import {
	getMessage,
	getInboxDb,
	correctClassification,
} from '../src/lib/inbox/index.js';

const messageId = Number(process.argv[2] || 33676);

if (process.env.INBOX_TRANSACTIONAL_EAGER_EXTRACT !== '1') {
	console.error('Set INBOX_TRANSACTIONAL_EAGER_EXTRACT=1 to exercise the eager hook.');
	process.exit(2);
}

const msg = getMessage(messageId);
if (!msg) {
	console.error(`Message ${messageId} not found`);
	process.exit(1);
}
console.log(`\nTarget: id=${msg.id} category=${msg.category} subject="${msg.subject}"`);

if (msg.category !== 'transactional') {
	console.error(`Row is ${msg.category}; smoke needs an existing transactional row.`);
	process.exit(1);
}

const db = getInboxDb();
db.prepare(`UPDATE messages SET extracted_data = NULL, extracted_at = NULL WHERE id = ?`).run(messageId);
console.log(`Cleared extracted_data on ${messageId}.`);

// Trigger the worker hook via correctClassification — same category re-set.
const result = correctClassification(messageId, { category: 'transactional', scope: 'this' });
console.log(`correctClassification → ok=${result.ok} siblings=${result.siblingsUpdated}`);

// Wait long enough for the LLM call to complete (~1-2s typical).
const waitMs = 4000;
console.log(`Waiting ${waitMs}ms for setImmediate + extractor...`);
await new Promise((r) => setTimeout(r, waitMs));

// Check the row.
const after = db
	.prepare(`SELECT extracted_data, extracted_at FROM messages WHERE id = ?`)
	.get(messageId) as { extracted_data: string | null; extracted_at: number | null } | undefined;
console.log(`\nextracted_data:`, after?.extracted_data);
console.log(`extracted_at:`, after?.extracted_at);

// Check the audit row.
const audit = db
	.prepare(
		`SELECT id, tool, message_id, actor, args, result FROM agent_actions
		 WHERE message_id = ? AND actor = 'worker' ORDER BY id DESC LIMIT 1`,
	)
	.get(messageId);
console.log(`\nWORKER audit row:`, audit);

if (!after?.extracted_data || !audit) {
	console.error(`\n✗ Smoke FAILED — extraction or audit row missing.`);
	process.exit(1);
}
console.log(`\n✓ Eager-mode smoke OK`);
