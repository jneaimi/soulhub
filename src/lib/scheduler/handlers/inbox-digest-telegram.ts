/** ADR-044 — Telegram-native inbox digest with inline action buttons.
 *
 *  Parallel handler to the original WhatsApp inbox-digest factory. Same
 *  data path (listDigestCandidates + groupByCategory + pickHighlights),
 *  different transport. Emits TWO message types per fire:
 *
 *   1. ONE summary text bubble — the scannable category counts + total.
 *      No buttons; the highlights below carry the action surface.
 *   2. N per-highlight bubbles — one bubble per highlight with the
 *      4-button keyboard (📥 Save / 📁 Archive / 🔇 Mute / ↩️ Draft reply).
 *      `maxHighlights` from params caps N; default 5.
 *
 *  No LLM in the digest path — same privacy + cost posture as the
 *  WhatsApp version. The reply-draft path DOES dispatch scribe but
 *  only on operator tap, never preemptively.
 *
 *  Settings shape (drop into `scheduler.tasks[]` in settings.json):
 *    {
 *      id: 'inbox-digest-telegram',
 *      type: 'inbox-digest-telegram',
 *      cron: '0 8 * * *',
 *      timezone: 'Asia/Dubai',
 *      enabled: false,
 *      params: {
 *        lookbackHours: 24,
 *        maxHighlights: 5,
 *        highlightMinAmount: 100,
 *        highlightCurrency: 'AED',
 *      }
 *    }
 *
 *  Kill switch: `INBOX_DIGEST_DISABLED=1` (shared with the WhatsApp
 *  version per the original ADR §D7 Guardrail 3). */

import { config as soulHubConfig } from '../../config.js';
import { sendText } from '../../channels/telegram/outbound.js';
import { buildInboxDigestKeyboard } from '../../channels/telegram/callback.js';
import {
	getInboxDb,
	rowToMessage,
	recordAgentAction,
	type InboxMessage,
	type TransactionalExtract,
} from '../../inbox/index.js';
import { enrichInboxRowsWithContact } from '../../crm/index.js';
import type { ContactEmailMatch } from '../../crm/types.js';
import type { TaskFn } from '../task-types.js';

interface DigestParams {
	lookbackHours?: number;
	maxHighlights?: number;
	highlightMinAmount?: number;
	highlightCurrency?: string;
	/** Skip the summary bubble. Heartbeat mode prefers no summary so the
	 *  operator only sees actionable items; daily mode wants the summary
	 *  for the big-picture view. Defaults to false (= send summary). */
	skipSummary?: boolean;
}

interface DigestRunResult {
	ok: boolean;
	skipped?: 'kill-switch' | 'no-target' | 'empty-window';
	summarySent?: boolean;
	highlightsSent?: number;
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

export function inboxDigestTelegramFactory(rawParams: unknown): TaskFn {
	const params: DigestParams =
		typeof rawParams === 'object' && rawParams !== null ? (rawParams as DigestParams) : {};
	const lookbackHours = params.lookbackHours ?? 24;
	const maxHighlights = params.maxHighlights ?? 5;
	const highlightMinAmount = params.highlightMinAmount ?? 100;
	const highlightCurrency = (params.highlightCurrency ?? 'AED').toUpperCase();
	const skipSummary = params.skipSummary ?? false;

	return async (): Promise<DigestRunResult> => {
		if (process.env.INBOX_DIGEST_DISABLED === '1') {
			return { ok: true, skipped: 'kill-switch' };
		}
		const chatId = resolveTelegramChatId();
		if (!chatId) return { ok: false, skipped: 'no-target', error: 'no Telegram chat id' };
		const delivery = soulHubConfig.channels?.telegram?.delivery;
		if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

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

		// ADR-044.A — CRM enrichment for highlight bubbles. Bulk-match all
		// highlight senders against the CRM in one query, then attach the
		// match (if any) to the formatter so highlights from known
		// contacts get a `🤝 CRM: <stage>` badge.
		const enriched = enrichInboxRowsWithContact(highlights.map((h) => h.msg));
		const crmByMsgId = new Map<number, ContactEmailMatch | null>();
		for (const e of enriched) {
			crmByMsgId.set(e.message.id, e.contactMatch);
		}

		// Heartbeat-style: when no items qualify after dedup, fire NOTHING.
		// Daily-style: send the summary even with 0 highlights so the
		// operator sees "today was quiet."
		if (highlights.length === 0 && skipSummary) {
			return {
				ok: true,
				skipped: 'empty-window',
				candidateCount: candidates.length,
				highlightCount: 0,
			};
		}

		let summarySent = false;
		if (!skipSummary) {
			const summaryText = formatSummary(groups, candidates.length);
			const summary = await sendText(chatId, summaryText, delivery);
			summarySent = summary.ok;
		}

		let highlightsSent = 0;
		for (const h of highlights) {
			const text = formatHighlightMessage(h, crmByMsgId.get(h.msg.id) ?? null);
			const result = await sendText(chatId, text, delivery, {
				replyMarkup: buildInboxDigestKeyboard(h.msg.id),
			});
			if (result.ok && result.messageIds.length > 0) {
				// ADR-044.G — per-highlight dedup row. listDigestCandidates
				// excludes any message_id with a `sent:true` record under this
				// tool name, so the next tick won't re-push this item.
				recordAgentAction({
					tool: 'inbox-digest-telegram',
					messageId: h.msg.id,
					actor: 'worker',
					args: { lookbackHours },
					result: { sent: true, tgMessageId: result.messageIds[0] },
				});
				highlightsSent++;
			}
		}

		recordAgentAction({
			tool: 'inbox-digest-telegram',
			messageId: null,
			actor: 'worker',
			args: {
				lookbackHours,
				candidates: candidates.length,
				highlights: highlights.length,
				skipSummary,
			},
			result: {
				summarySent,
				highlightsSent,
			},
		});

		return {
			ok: true,
			summarySent,
			highlightsSent,
			candidateCount: candidates.length,
			highlightCount: highlights.length,
		};
	};
}

function resolveTelegramChatId(): string | null {
	const fromConfig = soulHubConfig.channels?.telegram?.access?.allowFrom?.[0];
	if (fromConfig) return String(fromConfig);
	return process.env.TELEGRAM_CHAT_ID ?? null;
}

/** Pull rows that match the digest window. Two exclusions beyond category +
 *  status: anomaly-pushed (S3a already DM'd them on WhatsApp) and digest-pushed
 *  (ADR-044.G dedup — heartbeat-style runs every 30min, would otherwise re-send
 *  the same item each tick). Both exclusions ride `agent_actions` rows tagged
 *  with the tool name + a positive result flag. Rows muted via ADR-044
 *  sender_pattern→bulk rules naturally fall out because the category filter
 *  is transactional/notification/personal. */
function listDigestCandidates(lookbackHours: number): InboxMessage[] {
	const db = getInboxDb();
	const sinceMs = Date.now() - lookbackHours * 3600 * 1000;
	const rows = db
		.prepare(
			`SELECT m.* FROM messages m
			 WHERE m.category IN ('transactional', 'notification', 'personal')
			   AND m.date_received > ?
			   AND m.process_status = 'queued'
			   AND NOT EXISTS (
				 SELECT 1 FROM agent_actions a
				 WHERE a.message_id = m.id
				   AND a.tool = 'inbox-anomaly-push'
				   AND json_extract(a.result, '$.pushed') = 1
			   )
			   AND NOT EXISTS (
				 SELECT 1 FROM agent_actions a
				 WHERE a.message_id = m.id
				   AND a.tool = 'inbox-digest-telegram'
				   AND json_extract(a.result, '$.sent') = 1
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
	const order = ['transactional', 'personal', 'notification', 'unclassified'];
	return Array.from(byCat.values()).sort(
		(a, b) => order.indexOf(a.category) - order.indexOf(b.category),
	);
}

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

function formatSummary(groups: CategoryGroup[], total: number): string {
	const today = new Date().toLocaleDateString('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
	});
	const lines: string[] = [`📥 *Inbox digest* — ${today}`, ''];
	for (const g of groups) {
		const kindBreakdown = Object.entries(g.kinds)
			.sort((a, b) => b[1] - a[1])
			.map(([k, n]) => `${n} ${k}`)
			.join(', ');
		const tail = kindBreakdown ? ` (${kindBreakdown})` : '';
		lines.push(`  · ${g.count} ${g.category}${tail}`);
	}
	lines.push('', `Total: ${total} queued · highlights below ↓`);
	return lines.join('\n');
}

function formatHighlightMessage(h: Highlight, crmMatch: ContactEmailMatch | null): string {
	const { msg, extract } = h;
	const from = msg.fromName || msg.fromAddress || 'unknown';
	const dateStr = new Date(msg.dateReceived).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'short',
	});

	// ADR-044.D — CRM badge lifted into the title row so the operator's
	// eye lands on "this is your pipeline" before reading the subject.
	// The badge eats budget from the subject (Telegram lines wrap badly
	// past ~80 chars), so shorten the subject when a badge is present.
	const lines: string[] = [];
	if (crmMatch) {
		const c = crmMatch.contact;
		const stagePart = c.stage ? `🤝 *${c.stage}*` : '🤝 *CRM*';
		lines.push(`${h.tag} ${stagePart} — *${truncate(msg.subject, 55)}*`);
	} else {
		lines.push(`${h.tag} *${truncate(msg.subject, 80)}*`);
	}
	lines.push('');

	// From line — when CRM hit, append company so the contact's
	// organisational context sits right under the badge.
	if (crmMatch?.contact.company) {
		lines.push(`From: ${from} · *${crmMatch.contact.company}*`);
	} else {
		lines.push(`From: ${from}`);
	}
	if (extract?.amount !== undefined && extract.currency) {
		const card = extract.cardLast4 ? ` ••${extract.cardLast4}` : '';
		const merchant = extract.merchant ? ` @ ${extract.merchant}` : '';
		lines.push(`Amount: ${extract.currency} ${formatAmount(extract.amount)}${merchant}${card}`);
	}
	if (extract?.anomalyHint) {
		lines.push(`⚠️ ${extract.anomalyHint}`);
	}
	if (msg.bodyPreview) {
		lines.push('', `_${truncate(msg.bodyPreview, 200)}_`);
	}
	lines.push('', `\`msg ${msg.id}\` · ${dateStr}`);
	return lines.join('\n');
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
