/** Layer 3 Stage 3a smoke — offline simulation of the anomaly push gate.
 *
 *  Doesn't fire any WhatsApp messages. Runs:
 *    1. listAnomalyPushCandidates (with a long lookback so we see history)
 *    2. evaluateAnomalyGate against a sample threshold config
 *    3. formatAnomalyMessage for each push-eligible row
 *
 *  Run: `npx tsx scripts/smoke-inbox-anomaly.ts [--lookback-hours N] [--threshold N] [--currency AED]`
 *
 *  Use this to:
 *   - Preview what the heartbeat WOULD push given current data
 *   - Tune `thresholdAmount` / `thresholdCurrency` before enabling
 *   - Spot misformatted output before users see it */

import {
	listAnomalyPushCandidates,
	evaluateAnomalyGate,
	formatAnomalyMessage,
	type TransactionalExtract,
	type AnomalyConfig,
} from '../src/lib/inbox/index.js';
import { findContactByEmail } from '../src/lib/crm/index.js';

const args = process.argv.slice(2);
const lookbackIdx = args.indexOf('--lookback-hours');
const thresholdIdx = args.indexOf('--threshold');
const currencyIdx = args.indexOf('--currency');

const cfg: AnomalyConfig = {
	enabled: true,
	thresholdAmount: thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 1000,
	thresholdCurrency: currencyIdx >= 0 ? args[currencyIdx + 1] : 'AED',
	lookbackHours: lookbackIdx >= 0 ? Number(args[lookbackIdx + 1]) : 720, // 30 days for the smoke
	perTickCap: 999,
};

console.log(
	`\nAnomaly gate simulation (lookback=${cfg.lookbackHours}h, threshold=${cfg.thresholdCurrency} ${cfg.thresholdAmount}):\n`,
);

const candidates = listAnomalyPushCandidates({
	lookbackHours: cfg.lookbackHours,
	limit: 500,
});
console.log(`Candidate rows (transactional+personal, extracted, not yet anomaly-pushed): ${candidates.length}\n`);

const byReason: Record<string, number> = {};
const pushes: { id: number; reason: string; text: string }[] = [];

for (const msg of candidates) {
	let extract: TransactionalExtract | null = null;
	try {
		extract = msg.extractedData ? (JSON.parse(msg.extractedData) as TransactionalExtract) : null;
	} catch {
		extract = null;
	}
	if (!extract) continue;
	const crmHit = !!findContactByEmail(msg.fromAddress)?.contact;
	const decision = evaluateAnomalyGate(msg, extract, cfg, crmHit);
	byReason[decision.reason] = (byReason[decision.reason] || 0) + 1;
	if (decision.push) {
		pushes.push({
			id: msg.id,
			reason: decision.reason,
			text: formatAnomalyMessage(msg, extract, decision.reason),
		});
	}
}

console.log(`Decision breakdown:`);
for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${reason.padEnd(14)} ${count}`);
}

console.log(`\nTotal would-push: ${pushes.length}\n`);

// Show one example of each push reason for quick eyeballing
const seenReasons = new Set<string>();
const samples = pushes.filter((p) => {
	if (seenReasons.has(p.reason)) return false;
	seenReasons.add(p.reason);
	return true;
});
console.log(`Sample push messages (one per reason):\n`);
for (const s of samples) {
	console.log(`  [${s.reason}] ${s.text}`);
}

if (pushes.length > samples.length) {
	console.log(`\n  ... and ${pushes.length - samples.length} more — re-run with --threshold higher to filter`);
}
