/** Smoke test for inbox-drill-down — runs the composer against real
 *  rows and prints the formatted output. No WhatsApp, no network.
 *
 *  Run: `npx tsx scripts/smoke-inbox-drill-down.ts [messageId ...]`
 *
 *  With no args, uses a small default set covering the interesting
 *  cases: a receipt with full extract, a personal mail, an anomaly
 *  alert, and a not-found id. */

import { composeDrillDown } from '../src/lib/inbox/index.js';

const ids = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const targets =
	ids.length > 0
		? ids
		: [
				33602, // TAQA bill — receipt with amount + merchant + ref
				33425, // Personal — Somaya Badr
				33877, // Anomaly alert — Google security
				33676, // HeyGen receipt — has agent_actions history (smoke + worker)
				99999, // Sentinel not-found
		  ];

for (const id of targets) {
	console.log('━'.repeat(72));
	const text = composeDrillDown(id);
	if (text === null) {
		console.log(`(msg ${id}: not found)\n`);
		continue;
	}
	console.log(text);
	console.log('');
}
