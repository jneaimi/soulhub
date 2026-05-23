/** ADR-044.H — Telegram-native anomaly push (replaces the WhatsApp S3a rail).
 *
 *  Same gate logic as the original WhatsApp `runAnomalyPush` in
 *  `src/lib/channels/whatsapp/heartbeat.ts` (now retired), different
 *  transport + UX:
 *
 *    - Each qualifying row fires as its OWN Telegram bubble with the
 *      same 4-button inline keyboard as the digest highlights
 *      (Save / Archive / Mute / Draft reply). The anomaly isn't worth
 *      pushing without actions — you'd still need to triage.
 *    - Format reuses the digest's `formatHighlightMessage` so the
 *      operator sees identical content shape across the two surfaces.
 *      Only difference: the anomaly TAG comes from the gate decision
 *      (⚠️ anomalyHint, 💸 threshold, 🤝 crm-sender, ✉️ personal)
 *      rather than the digest's heuristic score.
 *    - Dedup writes TWO `agent_actions` rows on success:
 *        a) `inbox-anomaly-push` (result.pushed=1) — original S3a key,
 *           preserved so existing analytics + the cold-start re-run
 *           protection in `listAnomalyPushCandidates` still work.
 *        b) `inbox-digest-telegram` (result.sent=1) — so the heartbeat
 *           digest task (ADR-044.G) doesn't re-surface the same row.
 *      Same-row twice = belt-and-suspenders against future query drift.
 *
 *  Cadence: scheduler task `inbox-anomaly-telegram` runs every 30 min
 *  during 08:00-22:59 Dubai. Same window as the digest (no point
 *  pushing at 03:00).
 *  Per-tick cap from settings (default 2 — anomalies are LOW-volume by
 *  design; the threshold is calibrated so most days fire 0 anomalies).
 *
 *  Kill switches: `INBOX_AGENT_DISABLED=1` (all Layer 3 off) or
 *  `cfg.inboxAnomaly.enabled=false` (just this rail off). */

import { config as soulHubConfig } from '../../config.js';
import { sendText } from '../../channels/telegram/outbound.js';
import { buildInboxDigestKeyboard } from '../../channels/telegram/callback.js';
import {
	listAnomalyPushCandidates,
	recordAgentAction,
	type InboxMessage,
	type TransactionalExtract,
} from '../../inbox/index.js';
import { evaluateAnomalyGate, type AnomalyReason } from '../../inbox/anomaly.js';
import { findContactByEmail } from '../../crm/index.js';
import { saveProactiveTurn } from '../../vault-chat/history.js';
import type { TaskFn } from '../task-types.js';

interface AnomalyTelegramParams {
	thresholdAmount?: number;
	thresholdCurrency?: string;
	lookbackHours?: number;
	perTickCap?: number;
}

interface AnomalyTelegramResult {
	ok: boolean;
	skipped?: 'kill-switch' | 'no-target' | 'master-disabled' | 'empty-window';
	candidatesEvaluated?: number;
	pushed?: number;
	error?: string;
}

export function inboxAnomalyTelegramFactory(rawParams: unknown): TaskFn {
	const params: AnomalyTelegramParams =
		typeof rawParams === 'object' && rawParams !== null ? (rawParams as AnomalyTelegramParams) : {};

	return async (): Promise<AnomalyTelegramResult> => {
		if (process.env.INBOX_AGENT_DISABLED === '1') {
			return { ok: true, skipped: 'kill-switch' };
		}
		const cfg = soulHubConfig.channels?.whatsapp?.inboxAnomaly;
		if (!cfg || !cfg.enabled) {
			return { ok: true, skipped: 'master-disabled' };
		}

		const chatId = resolveTelegramChatId();
		if (!chatId) return { ok: false, skipped: 'no-target', error: 'no Telegram chat id' };
		const delivery = soulHubConfig.channels?.telegram?.delivery;
		if (!delivery) return { ok: false, error: 'no-telegram-delivery-config' };

		const thresholdAmount = params.thresholdAmount ?? cfg.thresholdAmount;
		const thresholdCurrency = (params.thresholdCurrency ?? cfg.thresholdCurrency).toUpperCase();
		const lookbackHours = params.lookbackHours ?? cfg.lookbackHours;
		const perTickCap = params.perTickCap ?? cfg.perTickCap;

		const candidates = listAnomalyPushCandidates({
			lookbackHours,
			limit: perTickCap * 4,
		});
		if (candidates.length === 0) {
			return { ok: true, skipped: 'empty-window', candidatesEvaluated: 0, pushed: 0 };
		}

		const gateCfg = {
			enabled: cfg.enabled,
			thresholdAmount,
			thresholdCurrency,
			lookbackHours,
			perTickCap,
		};

		let pushed = 0;
		let evaluated = 0;
		for (const msg of candidates) {
			if (pushed >= perTickCap) break;
			evaluated++;

			const extract = safeParseExtract(msg.extractedData);
			if (!extract) continue;

			const crmMatch = msg.fromAddress ? findContactByEmail(msg.fromAddress) : null;
			const decision = evaluateAnomalyGate(msg, extract, gateCfg, !!crmMatch);
			if (!decision.push) {
				recordAgentAction({
					tool: 'inbox-anomaly-push',
					messageId: msg.id,
					actor: 'worker',
					args: { reason: decision.reason, transport: 'telegram' },
					result: { pushed: false },
				});
				continue;
			}

			const text = formatAnomalyHighlight(msg, extract, decision.reason, crmMatch);
			const result = await sendText(chatId, text, delivery, {
				replyMarkup: buildInboxDigestKeyboard(msg.id),
			});
			recordAgentAction({
				tool: 'inbox-anomaly-push',
				messageId: msg.id,
				actor: 'worker',
				args: { reason: decision.reason, crmHit: !!crmMatch, transport: 'telegram' },
				result: { pushed: result.ok, error: result.ok ? undefined : 'send failed' },
			});
			if (result.ok && result.messageIds.length > 0) {
				// Belt-and-suspenders: also record a digest-sent row so the
				// heartbeat digest task (ADR-044.G) doesn't re-push the same
				// item later via its `inbox-digest-telegram + sent:true`
				// dedup clause.
				recordAgentAction({
					tool: 'inbox-digest-telegram',
					messageId: msg.id,
					actor: 'worker',
					args: { via: 'anomaly-push' },
					result: { sent: true, tgMessageId: result.messageIds[0] },
				});
				saveProactiveTurn(String(chatId), text, 'heartbeat');
				pushed++;
			}
		}

		return { ok: true, candidatesEvaluated: evaluated, pushed };
	};
}

function resolveTelegramChatId(): string | null {
	const fromConfig = soulHubConfig.channels?.telegram?.access?.allowFrom?.[0];
	if (fromConfig) return String(fromConfig);
	return process.env.TELEGRAM_CHAT_ID ?? null;
}

function safeParseExtract(json: string | null): TransactionalExtract | null {
	if (!json) return null;
	try {
		return JSON.parse(json) as TransactionalExtract;
	} catch {
		return null;
	}
}

/** Telegram anomaly highlight formatter — same layout as the digest's
 *  `formatHighlightMessage` (subject in title with optional CRM badge,
 *  From line with optional company, body preview, msg id) but the
 *  leading tag is chosen by the anomaly reason rather than the
 *  digest's score heuristic. Operator sees identical content shape
 *  across both surfaces — only the trigger differs. */
function formatAnomalyHighlight(
	msg: InboxMessage,
	extract: TransactionalExtract,
	reason: AnomalyReason,
	crmMatch: ReturnType<typeof findContactByEmail>,
): string {
	const tag = reasonTag(reason);
	const from = msg.fromName || msg.fromAddress || 'unknown';
	const dateStr = new Date(msg.dateReceived).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'short',
	});

	const lines: string[] = [];
	if (crmMatch) {
		const c = crmMatch.contact;
		const stagePart = c.stage ? `🤝 *${c.stage}*` : '🤝 *CRM*';
		lines.push(`${tag} ${stagePart} — *${truncate(msg.subject, 55)}*`);
	} else {
		lines.push(`${tag} *${truncate(msg.subject, 80)}*`);
	}
	lines.push('');

	if (crmMatch?.contact.company) {
		lines.push(`From: ${from} · *${crmMatch.contact.company}*`);
	} else {
		lines.push(`From: ${from}`);
	}
	if (extract.amount !== undefined && extract.currency) {
		const card = extract.cardLast4 ? ` ••${extract.cardLast4}` : '';
		const merchant = extract.merchant ? ` @ ${extract.merchant}` : '';
		lines.push(
			`Amount: ${extract.currency} ${formatAmount(extract.amount)}${merchant}${card}`,
		);
	}
	if (extract.anomalyHint) {
		lines.push(`⚠️ ${extract.anomalyHint}`);
	}
	if (msg.bodyPreview) {
		lines.push('', `_${truncate(msg.bodyPreview, 200)}_`);
	}
	lines.push('', `\`msg ${msg.id}\` · ${dateStr} · anomaly`);
	return lines.join('\n');
}

function reasonTag(reason: AnomalyReason): string {
	switch (reason) {
		case 'personal':
			return '✉️';
		case 'anomalyHint':
			return '⚠️';
		case 'threshold':
			return '💸';
		case 'crm-sender':
			return '🤝';
		case 'no-match':
			return '·';
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
