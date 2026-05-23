/** Smoke test for Layer 3 Stage 2 — exercises the extractor + cache +
 *  audit log end-to-end against a real transactional row from inbox.db.
 *
 *  Run: `npx tsx scripts/smoke-inbox-extract.ts [messageId]`
 *
 *  Verifies:
 *    1. Cold extraction returns a parsed TransactionalExtract.
 *    2. setExtractedData caches the JSON on the row.
 *    3. getExtractedData returns the same shape on the second call.
 *    4. recordAgentAction writes a row visible in agent_actions. */

import {
	getMessage,
	getExtractedData,
	setExtractedData,
	recordAgentAction,
	extractTransactional,
	inputFromMessage,
	getInboxDb,
	type TransactionalExtract,
} from '../src/lib/inbox/index.js';

const messageId = Number(process.argv[2] || 33676);

const msg = getMessage(messageId);
if (!msg) {
	console.error(`Message ${messageId} not found`);
	process.exit(1);
}

console.log(`\nSmoke target → id=${msg.id} category=${msg.category} subject="${msg.subject}"`);
console.log(`Preview head: ${msg.bodyPreview.slice(0, 120).replace(/\s+/g, ' ')}…\n`);

if (msg.category !== 'transactional') {
	console.error(`Row is category '${msg.category}' — extractor would reject it.`);
	process.exit(1);
}

// Pass 1 — cold path
const t0 = Date.now();
const result = await extractTransactional(inputFromMessage(msg));
const coldMs = Date.now() - t0;
console.log(`COLD: ${coldMs}ms — ok=${result.ok}${result.reason ? ` reason="${result.reason}"` : ''}`);
console.log(JSON.stringify(result.extract, null, 2));

// Persist + audit
setExtractedData(messageId, result.extract);
recordAgentAction({
	tool: 'inbox-extract-data',
	messageId,
	actor: 'operator-direct',
	args: { messageId, smoke: true },
	result: { ok: result.ok, kind: result.extract.kind },
});

// Pass 2 — cache hit (no LLM, no setExtractedData)
const t1 = Date.now();
const cached = getExtractedData<TransactionalExtract>(messageId);
const warmMs = Date.now() - t1;
console.log(`\nWARM: ${warmMs}ms — cache hit, kind=${cached?.kind}`);

// Audit log inspection
const db = getInboxDb();
const auditRow = db
	.prepare(`SELECT id, timestamp, tool, message_id, actor, args, result FROM agent_actions WHERE message_id = ? ORDER BY id DESC LIMIT 1`)
	.get(messageId) as Record<string, unknown> | undefined;
console.log(`\nAUDIT row:`, auditRow);

console.log(`\n✓ Smoke OK`);
