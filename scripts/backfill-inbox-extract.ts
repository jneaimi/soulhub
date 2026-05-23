/** One-time backfill — extracts every transactional row where
 *  `extracted_data IS NULL`. Lets the Stage 2 burn-in start with a real
 *  sample without waiting for natural mail flow.
 *
 *  Run: `npx tsx scripts/backfill-inbox-extract.ts [--dry-run] [--limit N]`
 *
 *  - Serial 1-RPS-ish pace — Gemini Flash is generous but no need to
 *    burst. ~1s per row × 258 = ~4-5 minutes.
 *  - Audit log uses actor='operator-direct' + args={mode:'backfill'} so
 *    these rows are distinguishable from natural eager-mode runs
 *    (actor='worker', args.mode='eager') and from on-demand tool calls
 *    (actor='orchestrator').
 *  - Failures cache as {kind:'unknown', note} — the same retry-proof
 *    contract the orchestrator tool uses.
 *  - On Ctrl-C, the in-flight row's update lands but no further rows
 *    process (the loop check fires before each request). */

import {
	getInboxDb,
	rowToMessage,
	extractTransactional,
	inputFromMessage,
	setExtractedData,
	recordAgentAction,
	type TransactionalExtract,
} from '../src/lib/inbox/index.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const retryUnknown = args.includes('--retry-unknown');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Number.POSITIVE_INFINITY;

const db = getInboxDb();
const targetSql = retryUnknown
	? `SELECT * FROM messages WHERE category='transactional' AND json_extract(extracted_data, '$.kind') = 'unknown' ORDER BY date_received DESC LIMIT ?`
	: `SELECT * FROM messages WHERE category='transactional' AND extracted_data IS NULL ORDER BY date_received DESC LIMIT ?`;
const rows = db
	.prepare(targetSql)
	.all(Number.isFinite(limit) ? limit : 1000) as Record<string, unknown>[];

const mode = retryUnknown ? 'retry-unknown' : 'fresh';
console.log(`Backfill mode: ${mode}. Target: ${rows.length} rows.${dryRun ? ' (dry-run)' : ''}\n`);

if (rows.length === 0) {
	console.log('Nothing to do.');
	process.exit(0);
}

if (dryRun) {
	rows.slice(0, 10).forEach((r) => {
		const m = rowToMessage(r);
		console.log(`  ${m.id} — ${m.subject.slice(0, 70)}`);
	});
	if (rows.length > 10) console.log(`  ... and ${rows.length - 10} more`);
	process.exit(0);
}

const stats = {
	processed: 0,
	ok: 0,
	failed: 0,
	bodyFallbacks: 0,
	byKind: {} as Record<string, number>,
	totalMs: 0,
};

const t0 = Date.now();
for (let i = 0; i < rows.length; i++) {
	const msg = rowToMessage(rows[i]);
	const rowStart = Date.now();
	try {
		const result = await extractTransactional(inputFromMessage(msg));
		setExtractedData(msg.id, result.extract);
		recordAgentAction({
			tool: 'inbox-extract-data',
			messageId: msg.id,
			actor: 'operator-direct',
			args: { mode: retryUnknown ? 'backfill-retry-unknown' : 'backfill' },
			result: {
				ok: result.ok,
				kind: result.extract.kind,
				reason: result.reason,
				usedBodyFallback: result.usedBodyFallback,
			},
		});
		stats.processed++;
		if (result.ok) stats.ok++;
		else stats.failed++;
		if (result.usedBodyFallback) stats.bodyFallbacks++;
		stats.byKind[result.extract.kind] = (stats.byKind[result.extract.kind] || 0) + 1;
		stats.totalMs += Date.now() - rowStart;
	} catch (err) {
		stats.processed++;
		stats.failed++;
		console.warn(`  ${msg.id} EXCEPTION: ${(err as Error).message}`);
	}

	if ((i + 1) % 10 === 0 || i === rows.length - 1) {
		const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
		const avgMs = (stats.totalMs / Math.max(stats.processed, 1)).toFixed(0);
		console.log(
			`  [${i + 1}/${rows.length}] elapsed=${elapsed}s avg=${avgMs}ms ok=${stats.ok} fail=${stats.failed}`,
		);
	}
}

const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${totalSec}s.`);
console.log(`  processed:     ${stats.processed}`);
console.log(`  ok:            ${stats.ok}`);
console.log(`  failed:        ${stats.failed}`);
console.log(`  bodyFallbacks: ${stats.bodyFallbacks}`);
console.log(`  byKind:`, stats.byKind);

// Cost estimate (Gemini 2.5 Flash, rough):
//   preview-only row ≈ $0.00008
//   body-fallback row ≈ $0.00018 (2 LLM passes + larger context on pass 2)
const estCost = ((stats.processed - stats.bodyFallbacks) * 0.00008 + stats.bodyFallbacks * 0.00018).toFixed(4);
console.log(`  est. cost: ~$${estCost}`);
