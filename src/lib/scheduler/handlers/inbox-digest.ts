/** Task handler: inbox-digest (Layer 3 Stage 3b).
 *
 *  See ADR 2026-05-11-inbox-agent-workflows-layer-3 §D4.2.
 *
 *  Fires once a day (08:00 by default), composes a single WhatsApp
 *  message summarising queued inbox mail from the lookback window,
 *  EXCLUDING rows already real-time-pushed by S3a anomaly push. The
 *  no-match rows S3a defers per tick land here.
 *
 *  Server-formatted, NO LLM in the digest path. The shape is
 *  intentionally tight — one preamble line, per-category counts,
 *  N highlights — so the operator can scan it in ≤3 seconds.
 *
 *  Privacy: reads `extracted_data` + envelope only. Never fetches
 *  bodies. (Bodies were already pulled if extraction needed the fallback;
 *  here we just read the cached JSON.)
 *
 *  Settings shape (drop into `scheduler.tasks[]` in settings.json):
 *    {
 *      id: 'inbox-digest-daily',
 *      type: 'inbox-digest',
 *      cron: '0 8 * * *',
 *      timezone: 'Asia/Dubai',
 *      enabled: false,
 *      params: {
 *        target: '+971506691134',    // required — WhatsApp recipient
 *        lookbackHours: 24,          // optional (default 24)
 *        maxHighlights: 5,           // optional (default 5)
 *        highlightMinAmount: 100,    // optional (default 100)
 *        highlightCurrency: 'AED',   // optional (default 'AED')
 *      }
 *    }
 *
 *  Kill switch: `INBOX_DIGEST_DISABLED=1` (per ADR §D7 Guardrail 3). */

import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import { getSocket } from '../../channels/whatsapp/connection.js';
import { sendText } from '../../channels/whatsapp/outbound.js';
import { workerSend } from '../../channels/whatsapp/worker-client.js';
import { saveProactiveTurn } from '../../vault-chat/history.js';
import {
	getInboxDb,
	rowToMessage,
	recordAgentAction,
	type InboxMessage,
	type TransactionalExtract,
} from '../../inbox/index.js';
import type { TaskFn } from '../task-types.js';

interface DigestParams {
	target?: string;
	lookbackHours?: number;
	maxHighlights?: number;
	highlightMinAmount?: number;
	highlightCurrency?: string;
}

interface DigestRunResult {
	ok: boolean;
	skipped?: 'kill-switch' | 'no-target' | 'empty-window';
	pushed?: boolean;
	candidateCount?: number;
	highlightCount?: number;
	error?: string;
}

interface CategoryGroup {
	category: string;
	count: number;
	kinds: Record<string, number>;
}

interface Highlight {
	msg: InboxMessage;
	extract: TransactionalExtract | null;
	score: number;
	tag: string;
}

export function inboxDigestFactory(rawParams: unknown): TaskFn {
	const params: DigestParams =
		typeof rawParams === 'object' && rawParams !== null ? (rawParams as DigestParams) : {};
	const lookbackHours = params.lookbackHours ?? 24;
	const maxHighlights = params.maxHighlights ?? 5;
	const highlightMinAmount = params.highlightMinAmount ?? 100;
	const highlightCurrency = (params.highlightCurrency ?? 'AED').toUpperCase();
	const target = params.target;

	return async (): Promise<DigestRunResult> => {
		if (process.env.INBOX_DIGEST_DISABLED === '1') {
			return { ok: true, skipped: 'kill-switch' };
		}
		if (!target) {
			return { ok: false, skipped: 'no-target', error: 'params.target is required' };
		}

		const candidates = listDigestCandidates(lookbackHours);
		if (candidates.length === 0) {
			return { ok: true, skipped: 'empty-window', candidateCount: 0 };
		}

		const groups = groupByCategory(candidates);
		const highlights = pickHighlights(
			candidates,
			maxHighlights,
			highlightMinAmount,
			highlightCurrency,
		);

		const text = formatDigest(groups, highlights);
		const delivery = await sendWhatsAppMessage(target, text);

		// Audit row — one per digest fire, regardless of delivery. This is
		// the operator's "did the digest run today" log.
		recordAgentAction({
			tool: 'inbox-digest',
			messageId: null,
			actor: 'worker',
			args: {
				lookbackHours,
				candidates: candidates.length,
				highlights: highlights.length,
			},
			result: {
				pushed: delivery.ok,
				error: delivery.error,
			},
		});

		if (delivery.ok) {
			saveProactiveTurn(target, text, 'heartbeat');
		}

		return {
			ok: delivery.ok,
			pushed: delivery.ok,
			candidateCount: candidates.length,
			highlightCount: highlights.length,
			error: delivery.error,
		};
	};
}

/** Pull rows that match the digest window. Excludes any row that S3a
 *  already real-time-pushed (`pushed=true` in agent_actions). The
 *  no-match rows S3a deferred ARE included — they're exactly what the
 *  digest is for. */
function listDigestCandidates(lookbackHours: number): InboxMessage[] {
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
	return rows.map(rowToMessage);
}

function groupByCategory(rows: InboxMessage[]): CategoryGroup[] {
	const byCat = new Map<string, CategoryGroup>();
	for (const m of rows) {
		const cat = m.category ?? 'unclassified';
		const group = byCat.get(cat) ?? { category: cat, count: 0, kinds: {} };
		group.count++;
		const extract = safeParse(m.extractedData);
		if (extract?.kind) {
			group.kinds[extract.kind] = (group.kinds[extract.kind] || 0) + 1;
		}
		byCat.set(cat, group);
	}
	// Standard category order — biggest categories first for scannability.
	const order = ['transactional', 'personal', 'notification', 'unclassified'];
	return Array.from(byCat.values()).sort(
		(a, b) => order.indexOf(a.category) - order.indexOf(b.category),
	);
}

/** Pick the N most-interesting rows. Scoring favours: personal mail >
 *  anomalyHint > large amounts > everything else. Within each tier,
 *  newer first. */
function pickHighlights(
	rows: InboxMessage[],
	max: number,
	minAmount: number,
	currency: string,
): Highlight[] {
	const scored: Highlight[] = rows.map((m) => {
		const extract = safeParse(m.extractedData);
		let score = 0;
		let tag = '';

		if (m.category === 'personal') {
			score = 1000;
			tag = '✉️';
		} else if (extract?.anomalyHint) {
			score = 900;
			tag = '⚠️';
		} else if (
			extract?.amount !== undefined &&
			extract.amount >= minAmount &&
			(extract.currency ?? '').toUpperCase() === currency
		) {
			score = 500 + extract.amount;
			tag = '💸';
		} else if (extract?.amount !== undefined) {
			score = 100;
			tag = '·';
		}

		return { msg: m, extract, score, tag };
	});

	return scored
		.filter((h) => h.score > 0)
		.sort((a, b) => b.score - a.score || b.msg.dateReceived - a.msg.dateReceived)
		.slice(0, max);
}

function formatDigest(groups: CategoryGroup[], highlights: Highlight[]): string {
	const today = new Date().toLocaleDateString('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
	});
	const lines: string[] = [`📥 Inbox digest — ${today}`];

	for (const g of groups) {
		const kindBreakdown = Object.entries(g.kinds)
			.sort((a, b) => b[1] - a[1])
			.map(([k, n]) => `${n} ${k}`)
			.join(', ');
		const tail = kindBreakdown ? ` (${kindBreakdown})` : '';
		lines.push(`  · ${g.count} ${g.category}${tail}`);
	}

	if (highlights.length > 0) {
		lines.push('', 'Highlights:');
		for (const h of highlights) {
			lines.push(`  ${h.tag} ${summarise(h)} (msg ${h.msg.id})`);
		}
	}

	lines.push('', '(reply with a msg id to drill down)');
	return lines.join('\n');
}

function summarise(h: Highlight): string {
	const { msg, extract } = h;
	if (msg.category === 'personal') {
		const from = msg.fromName || msg.fromAddress || 'unknown';
		return `${from} — "${truncate(msg.subject, 55)}"`;
	}
	if (!extract) return truncate(msg.subject, 70);

	const parts: string[] = [];
	if (extract.amount !== undefined && extract.currency) {
		parts.push(`${extract.currency} ${formatAmount(extract.amount)}`);
	}
	if (extract.merchant) {
		parts.push(extract.amount !== undefined ? `@ ${extract.merchant}` : extract.merchant);
	}
	if (extract.cardLast4) parts.push(`••${extract.cardLast4}`);
	// Anomaly alerts often have just a merchant ("Google", "Apple") with
	// no amount or card — too ambiguous on its own. Append a subject hint
	// so the operator sees what the alert was about.
	if (extract.amount === undefined && !extract.cardLast4 && msg.subject) {
		parts.push(`— ${truncate(msg.subject, 45)}`);
	}
	if (parts.length === 0) parts.push(truncate(msg.subject, 55));
	return parts.join(' ');
}

function safeParse(json: string | null): TransactionalExtract | null {
	if (!json) return null;
	try {
		return JSON.parse(json) as TransactionalExtract;
	} catch {
		return null;
	}
}

function formatAmount(n: number): string {
	if (Math.round(n) === n) return n.toLocaleString('en-US');
	return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function truncate(s: string, n: number): string {
	if (!s) return '';
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Local WhatsApp send — mirrors heartbeat.ts `deliver`. Kept inline
 *  rather than lifted into a shared helper because the surface area
 *  is tiny and the heartbeat copy reads naturally next to its tick
 *  context. Refactor if a third caller appears. */
async function sendWhatsAppMessage(
	target: string,
	text: string,
): Promise<{ ok: boolean; error?: string }> {
	const cfg = readWhatsAppConfig();
	if (!cfg) return { ok: false, error: 'WhatsApp config unavailable' };

	const jid = `${target.replace(/^\+/, '')}@s.whatsapp.net`;

	if (cfg.worker.enabled) {
		const result = await workerSend(cfg.worker, { to: jid, text });
		return { ok: !!result?.ok, error: result?.error };
	}
	const sock = getSocket();
	if (!sock) return { ok: false, error: 'WhatsApp socket not connected' };
	const result = await sendText(sock, jid, text, cfg.delivery);
	return { ok: result.ok, error: result.error };
}

function readWhatsAppConfig(): ReturnType<typeof WhatsAppChannelSchema.parse> | null {
	const raw = soulHubConfig.channels?.whatsapp ?? {};
	const parsed = WhatsAppChannelSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}
