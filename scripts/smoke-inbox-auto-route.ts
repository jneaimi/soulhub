/** Layer 3 Stage 4 smoke — offline simulation of the auto-route gate.
 *
 *  Doesn't actually write to vault or mark messages processed (PREVIEW
 *  mode). Runs:
 *    1. listAutoRouteCandidates (long lookback)
 *    2. evaluateAutoRouteRule against an operator-supplied config
 *    3. Print per-row routing decision + reason
 *
 *  Run: `npx tsx scripts/smoke-inbox-auto-route.ts [--lookback-hours N] [--receipts-min N] [--payments-min N] [--enable receipts|payments|alerts|shipping|service-alerts]`
 *
 *  Default: ALL rules ON (so the smoke reveals every potential auto-route),
 *  receipts threshold 50 AED, payments threshold 200 AED. Override per
 *  flag to preview the operator's intended production config. */

import {
	listAutoRouteCandidates,
	evaluateAutoRouteRule,
	type AutoRouteReason,
} from '../src/lib/inbox/index.js';
import type { InboxAutoRouteConfig } from '../src/lib/config.schema.js';
import type { TransactionalExtract } from '../src/lib/inbox/extractor.js';

const args = process.argv.slice(2);
const flag = (k: string): string | undefined => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : undefined;
};
const has = (k: string): boolean => args.includes(k);

const lookbackHours = Number(flag('--lookback-hours') ?? 720); // 30 days
const receiptsMin = Number(flag('--receipts-min') ?? 50);
const paymentsMin = Number(flag('--payments-min') ?? 200);

// Default: all rules ON for preview. Restrict via --enable list:
//   --enable receipts,payments
const enableFlag = flag('--enable');
const enabled = enableFlag
	? new Set(enableFlag.split(',').map((s) => s.trim()))
	: new Set(['receipts', 'payments', 'alerts', 'shipping', 'service-alerts']);

const cfg: InboxAutoRouteConfig = {
	enabled: true,
	intervalMs: 60_000,
	lookbackHours,
	perTickCap: 999,
	receipts: { enabled: enabled.has('receipts'), minAmount: receiptsMin, currency: 'AED' },
	payments: { enabled: enabled.has('payments'), minAmount: paymentsMin, currency: 'AED' },
	alerts: { enabled: enabled.has('alerts'), anomalyOnly: true },
	shipping: { enabled: enabled.has('shipping') },
	serviceAlerts: { enabled: enabled.has('service-alerts'), anomalyOnly: true },
};

console.log(
	`\nAuto-route preview (lookback=${lookbackHours}h, enabled=${[...enabled].join(', ') || 'NONE'}):\n`,
);

const candidates = listAutoRouteCandidates({ lookbackHours, limit: 500 });
console.log(`Eligible queued candidates (transactional+notification, not yet routed): ${candidates.length}\n`);

const byReason: Record<string, number> = {};
const routes: { id: number; subject: string; reason: AutoRouteReason }[] = [];

for (const msg of candidates) {
	let extract: TransactionalExtract | null = null;
	if (msg.extractedData) {
		try {
			extract = JSON.parse(msg.extractedData) as TransactionalExtract;
		} catch {
			extract = null;
		}
	}
	const decision = evaluateAutoRouteRule(msg, extract, cfg);
	byReason[decision.reason] = (byReason[decision.reason] ?? 0) + 1;
	if (decision.route) {
		routes.push({
			id: msg.id,
			subject: msg.subject.slice(0, 60),
			reason: decision.reason,
		});
	}
}

console.log('Decision breakdown:');
for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${reason.padEnd(28)} ${count}`);
}
console.log();

if (routes.length === 0) {
	console.log('No rows would be auto-routed under this config.');
} else {
	console.log(`Would auto-route ${routes.length} row(s):`);
	for (const r of routes.slice(0, 25)) {
		console.log(`  msg ${r.id.toString().padStart(6)} [${r.reason.padEnd(26)}] ${r.subject}`);
	}
	if (routes.length > 25) console.log(`  …(+ ${routes.length - 25} more)`);
}

console.log('\nNOTE: smoke is preview-only. No vault notes written, no rows marked processed.');
