/** Layer 3 Stage 3b smoke — offline simulation of the digest composer.
 *
 *  Runs the same query + grouping + formatting the scheduled handler
 *  would run, then prints the assembled message to stdout INSTEAD of
 *  firing WhatsApp. Useful for:
 *   - Previewing what tomorrow's 08:00 digest will look like
 *   - Tuning highlightMinAmount / highlightCurrency
 *   - Spotting empty-window cases before the cron fires
 *
 *  Run: `npx tsx scripts/smoke-inbox-digest.ts [--lookback-hours N]
 *                                              [--min-amount N]
 *                                              [--currency AED]
 *                                              [--max-highlights N]` */

import {
	getInboxDb,
	rowToMessage,
	type InboxMessage,
	type TransactionalExtract,
} from '../src/lib/inbox/index.js';

const args = process.argv.slice(2);
const argIdx = (name: string) => args.indexOf(name);
const lookbackHours = argIdx('--lookback-hours') >= 0 ? Number(args[argIdx('--lookback-hours') + 1]) : 24;
const minAmount = argIdx('--min-amount') >= 0 ? Number(args[argIdx('--min-amount') + 1]) : 100;
const currency = (argIdx('--currency') >= 0 ? args[argIdx('--currency') + 1] : 'AED').toUpperCase();
const maxHighlights = argIdx('--max-highlights') >= 0 ? Number(args[argIdx('--max-highlights') + 1]) : 5;

const db = getInboxDb();
const sinceMs = Date.now() - lookbackHours * 3600 * 1000;
const rows = db
	.prepare(
		`SELECT m.* FROM messages m
		 WHERE m.category IN ('transactional', 'notification', 'personal')
		   AND m.date_received > ?
		   AND NOT EXISTS (
			 SELECT 1 FROM agent_actions a
			 WHERE a.message_id = m.id
			   AND a.tool = 'inbox-anomaly-push'
			   AND json_extract(a.result, '$.pushed') = 1
		   )
		 ORDER BY m.date_received DESC`,
	)
	.all(sinceMs) as Record<string, unknown>[];
const candidates: InboxMessage[] = rows.map(rowToMessage);

console.log(`\nDigest simulation (lookback=${lookbackHours}h, highlights ≥${currency} ${minAmount}, max=${maxHighlights}):\n`);
console.log(`Candidate rows in window (queued, NOT real-time-pushed): ${candidates.length}\n`);

if (candidates.length === 0) {
	console.log('(empty window — handler would skip)');
	process.exit(0);
}

// Mirror the handler's grouping
const byCat = new Map<string, { count: number; kinds: Record<string, number> }>();
for (const m of candidates) {
	const cat = m.category ?? 'unclassified';
	const g = byCat.get(cat) ?? { count: 0, kinds: {} };
	g.count++;
	const e = safeParse(m.extractedData);
	if (e?.kind) g.kinds[e.kind] = (g.kinds[e.kind] || 0) + 1;
	byCat.set(cat, g);
}

console.log('Per-category breakdown:');
for (const [cat, g] of byCat) {
	const k = Object.entries(g.kinds).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c} ${n}`).join(', ');
	console.log(`  ${cat.padEnd(15)} ${g.count}${k ? `  (${k})` : ''}`);
}

// Mirror the handler's highlight scoring
const scored = candidates.map((m) => {
	const e = safeParse(m.extractedData);
	let score = 0;
	let tag = '';
	if (m.category === 'personal') { score = 1000; tag = '✉️'; }
	else if (e?.anomalyHint) { score = 900; tag = '⚠️'; }
	else if (e?.amount !== undefined && e.amount >= minAmount && (e.currency ?? '').toUpperCase() === currency) {
		score = 500 + e.amount;
		tag = '💸';
	} else if (e?.amount !== undefined) { score = 100; tag = '·'; }
	return { msg: m, extract: e, score, tag };
});
const highlights = scored
	.filter((h) => h.score > 0)
	.sort((a, b) => b.score - a.score || b.msg.dateReceived - a.msg.dateReceived)
	.slice(0, maxHighlights);

console.log('\n──────── Would-send message ────────\n');

const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
console.log(`📥 Inbox digest — ${today}`);
for (const [cat, g] of byCat) {
	const k = Object.entries(g.kinds).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c} ${n}`).join(', ');
	console.log(`  · ${g.count} ${cat}${k ? ` (${k})` : ''}`);
}
if (highlights.length > 0) {
	console.log('');
	console.log('Highlights:');
	for (const h of highlights) {
		const summary = summarise(h);
		console.log(`  ${h.tag} ${summary} (msg ${h.msg.id})`);
	}
}
console.log('');
console.log('(reply with a msg id to drill down)');

function safeParse(json: string | null): TransactionalExtract | null {
	if (!json) return null;
	try { return JSON.parse(json) as TransactionalExtract; } catch { return null; }
}

function summarise(h: { msg: InboxMessage; extract: TransactionalExtract | null }): string {
	const { msg, extract } = h;
	if (msg.category === 'personal') {
		const from = msg.fromName || msg.fromAddress || 'unknown';
		return `${from} — "${truncate(msg.subject, 55)}"`;
	}
	if (!extract) return truncate(msg.subject, 70);
	const parts: string[] = [];
	if (extract.amount !== undefined && extract.currency) parts.push(`${extract.currency} ${formatAmount(extract.amount)}`);
	if (extract.merchant) parts.push(extract.amount !== undefined ? `@ ${extract.merchant}` : extract.merchant);
	if (extract.cardLast4) parts.push(`••${extract.cardLast4}`);
	if (extract.amount === undefined && !extract.cardLast4 && msg.subject) {
		parts.push(`— ${truncate(msg.subject, 45)}`);
	}
	if (parts.length === 0) parts.push(truncate(msg.subject, 55));
	return parts.join(' ');
}

function formatAmount(n: number): string {
	if (Math.round(n) === n) return n.toLocaleString('en-US');
	return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function truncate(s: string, n: number): string {
	if (!s) return '';
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
