/** Unified operator-notification primitive — soul-hub-governance ADR-004 (P4 P1).
 *
 *  One path for every proactive message to the operator, so the five bespoke
 *  Telegram-only senders converge onto a single substrate with: both-channel
 *  delivery (Telegram now; WhatsApp text-only, socket-gated, opt-in per ADR-004),
 *  intrinsic `saveProactiveTurn` (ADR-021 — so anaphoric replies have context),
 *  and a persistent dedup + send-log (the latter feeds the
 *  `operator-notification-budget` falsifier — ADR-002 dogfood).
 *
 *  Tiers: `urgent` (e.g. inbox spend anomaly — sent immediately) vs `digest`
 *  (the rolling operator digest). The budget falsifier counts `digest`-tier
 *  sends/24h; urgent exceptions are expected and uncounted. */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { config as soulHubConfig } from '../../config.js';
import { sendText as sendTelegram } from '../telegram/outbound.js';
import { whatsappHeartbeatChannel } from '../whatsapp/heartbeat-channel.js';
import { saveProactiveTurn } from '../../vault-chat/history.js';
import { getHeartbeatDb } from '../whatsapp/heartbeat-state.js';
import type { InlineKeyboardMarkup, TelegramDeliveryConfig } from '../telegram/types.js';

export type NotifyTier = 'urgent' | 'digest';
export type NotifyChannel = 'telegram' | 'whatsapp';

export interface NotifyOperatorInput {
	/** Logical source id (e.g. 'operator-digest', 'inbox-anomaly') — dedup + budget key. */
	source: string;
	tier: NotifyTier;
	text: string;
	/** Telegram inline keyboard (ignored on WhatsApp — text+deep-link only in P1). */
	keyboard?: InlineKeyboardMarkup;
	/** Override the dedup key; defaults to (source, dayKey, content-hash). */
	dedupKey?: string;
	/** Channels to deliver on. Default: Telegram only (WhatsApp is opt-in, ADR-004). */
	channels?: NotifyChannel[];
}

export interface NotifyOperatorResult {
	ok: boolean;
	sent: NotifyChannel[];
	deduped?: boolean;
	error?: string;
	/** Telegram message ids of the delivered message (for in-place edits /
	 *  callback wiring, e.g. the fix-batch button). Empty unless Telegram sent. */
	telegramMessageIds?: number[];
}

/** Persistent send-log + dedup ledger. One row per delivered logical message. */
function ensureTable(db: Database.Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS operator_notifications (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		dedup_key TEXT NOT NULL,
		source TEXT NOT NULL,
		tier TEXT NOT NULL,
		sent_at INTEGER NOT NULL,
		channels TEXT NOT NULL
	)`);
	db.exec(`CREATE INDEX IF NOT EXISTS idx_opnotif_sent ON operator_notifications(sent_at)`);
}

function dayKey(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

function resolveTelegramChatId(): string | null {
	const allow = soulHubConfig.channels?.telegram?.access?.allowFrom;
	if (Array.isArray(allow) && allow.length > 0 && typeof allow[0] === 'string') return allow[0];
	const env = process.env.TELEGRAM_CHAT_ID;
	return env && env.trim() ? env.trim() : null;
}

/** Count `digest`-tier operator sends in the trailing `windowMs` — the
 *  `operator-notification-budget` falsifier's measurement. */
export function countOperatorSends(tier: NotifyTier, windowMs = 24 * 3_600_000, now = Date.now()): number {
	const db = getHeartbeatDb();
	ensureTable(db);
	const row = db
		.prepare(`SELECT COUNT(*) AS n FROM operator_notifications WHERE tier = ? AND sent_at > ?`)
		.get(tier, now - windowMs) as { n: number };
	return row.n;
}

/**
 * Deliver one proactive message to the operator. Returns which channels sent;
 * silently dedups a byte-identical (source, day) message. Telegram failures are
 * surfaced; WhatsApp is best-effort (skipped when the socket is down).
 */
export async function notifyOperator(input: NotifyOperatorInput): Promise<NotifyOperatorResult> {
	const { source, tier, text } = input;
	if (!text.trim()) return { ok: false, sent: [], error: 'empty text' };

	const channels = input.channels ?? soulHubConfig.notifications.operatorChannels;
	const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
	// Digest-tier dedup is DATE-STABLE (no content hash): at most one digest per
	// source per UTC-day, regardless of body drift. catchup-on-boot regenerates
	// the digest with live counts/timestamps, so a content-hashed key let every
	// re-fire through — three duplicate `operator-digest` sends on 2026-05-22
	// tripped the `operator-notification-budget` falsifier (4 > budget 3). The
	// dedup gate runs before delivery, so this also stops the duplicate Telegram
	// messages, while preserving catchup's intended late-delivery of a *missed*
	// digest. Urgent-tier keeps content-hash dedup so distinct alerts still send.
	const dedupKey =
		input.dedupKey ?? (tier === 'digest' ? `${source}:${dayKey()}` : `${source}:${dayKey()}:${hash}`);

	const db = getHeartbeatDb();
	ensureTable(db);
	const seen = db
		.prepare(`SELECT 1 FROM operator_notifications WHERE dedup_key = ? AND sent_at > ?`)
		.get(dedupKey, Date.now() - 24 * 3_600_000);
	if (seen) return { ok: true, sent: [], deduped: true };

	const sent: NotifyChannel[] = [];
	let firstError: string | undefined;
	let telegramMessageIds: number[] = [];

	if (channels.includes('telegram')) {
		const chatId = resolveTelegramChatId();
		const delivery = soulHubConfig.channels?.telegram?.delivery as TelegramDeliveryConfig | undefined;
		if (chatId && delivery) {
			const r = await sendTelegram(chatId, text, delivery, input.keyboard ? { replyMarkup: input.keyboard } : undefined);
			if (r.ok && r.messageIds.length > 0) {
				sent.push('telegram');
				telegramMessageIds = r.messageIds;
				// ADR-021 — proactive sends must persist a turn so anaphoric replies resolve.
				saveProactiveTurn(String(chatId), text, 'scheduler');
			} else {
				firstError = r.error ?? 'telegram-send-failed';
			}
		} else {
			firstError = 'no-telegram-target';
		}
	}

	if (channels.includes('whatsapp')) {
		// WhatsApp: text-only, socket-gated, best-effort (ADR-004 — degrade, never
		// block). The operator's number is the heartbeat delivery target (one
		// operator number, shared); if it's unset we skip rather than error, so a
		// stale `operatorChannels: ['whatsapp']` never wedges the whole notify.
		const target = soulHubConfig.heartbeat?.delivery?.target;
		if (target) {
			try {
				const r = await whatsappHeartbeatChannel.deliver(target, text);
				if (r.ok) sent.push('whatsapp');
				else if (!firstError) firstError = r.error ?? 'whatsapp-send-failed';
			} catch {
				/* socket down — skip WhatsApp silently */
			}
		} else if (!firstError) {
			firstError = 'no-whatsapp-target';
		}
	}

	if (sent.length === 0) return { ok: false, sent, error: firstError ?? 'no-channel-delivered' };

	db.prepare(
		`INSERT INTO operator_notifications (dedup_key, source, tier, sent_at, channels) VALUES (?, ?, ?, ?, ?)`,
	).run(dedupKey, source, tier, Date.now(), sent.join(','));

	return { ok: true, sent, telegramMessageIds };
}
