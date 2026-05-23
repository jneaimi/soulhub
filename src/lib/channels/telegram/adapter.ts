/** Telegram `ChannelAdapter` registration. Implements the same outbound
 *  contract the legacy `channels/telegram.ts` shim exposed (sendText
 *  with optional file), so existing callers (orchestrator-v2 alerts,
 *  pipeline runner, declared-secrets registry) are unaffected.
 *
 *  Inbound is webhook-driven — see `webhook-handler.ts` and the
 *  `/api/channels/telegram/_webhook` route. */

import { stat } from 'node:fs/promises';
import { config as soulHubConfig } from '../../config.js';
import { TelegramChannelSchema } from '../../config.schema.js';
import type {
	ChannelAdapter,
	ChannelMeta,
	SendResult,
	TestResult,
} from '../types.js';
import { getMe } from './client.js';
import { sendMedia, sendText } from './outbound.js';
import { kindFromPath } from './media-kind.js';
import { refreshBotIdentity } from './connection.js';
import type { TelegramChannelConfig } from './types.js';

export const meta: ChannelMeta = {
	id: 'telegram',
	name: 'Telegram',
	icon: 'send',
	fields: [
		{
			key: 'token',
			label: 'Bot Token',
			type: 'secret',
			env: 'TELEGRAM_BOT_TOKEN',
			required: true,
			link: 'https://core.telegram.org/bots#botfather',
		},
		// `TELEGRAM_CHAT_ID` retained as an optional fallback target so
		// existing callers (`orchestrator-v2/alerts`) keep working before
		// the user migrates to settings-based allowlists.
		{
			key: 'chatId',
			label: 'Default Chat ID',
			type: 'secret',
			env: 'TELEGRAM_CHAT_ID',
			required: false,
		},
	],
	actions: ['send'],
};

export function readChannelConfig(): TelegramChannelConfig | null {
	const raw = soulHubConfig.channels?.telegram ?? {};
	const parsed = TelegramChannelSchema.safeParse(raw);
	if (!parsed.success) return null;
	return parsed.data;
}

export function isConfigured(): boolean {
	if (!process.env.TELEGRAM_BOT_TOKEN) return false;
	const cfg = readChannelConfig();
	return !!cfg?.enabled;
}

/** Resolve the default outbound chat_id. Order of precedence:
 *   1. First numeric entry in `channels.telegram.access.allowFrom`
 *   2. Group chat id from `groupAllowFrom[0]` (negative integer)
 *   3. `TELEGRAM_CHAT_ID` env var (legacy/notifications fallback)
 *  Returns null if nothing usable is configured — caller surfaces a
 *  precise error to the user. */
function resolveDefaultChatId(cfg: TelegramChannelConfig): string | null {
	const dm = cfg.access.allowFrom.find((v) => v !== '*');
	if (dm) return dm;
	const grp = cfg.access.groupAllowFrom[0];
	if (grp) return grp;
	const env = process.env.TELEGRAM_CHAT_ID;
	if (env) return env;
	return null;
}

export async function send(message: string, attachPath?: string): Promise<SendResult> {
	const cfg = readChannelConfig();
	if (!cfg?.enabled) {
		return { ok: false, error: 'Telegram channel disabled in settings.' };
	}
	if (!process.env.TELEGRAM_BOT_TOKEN) {
		return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not set.' };
	}
	const chatId = resolveDefaultChatId(cfg);
	if (!chatId) {
		return {
			ok: false,
			error:
				'No recipient configured — add a Telegram user_id to channels.telegram.access.allowFrom or set TELEGRAM_CHAT_ID.',
		};
	}

	if (attachPath) {
		try {
			const fileStat = await stat(attachPath);
			const cap = cfg.delivery.maxMediaSizeMB * 1024 * 1024;
			if (fileStat.size > cap) {
				return {
					ok: false,
					error: `File exceeds ${cfg.delivery.maxMediaSizeMB}MB cap.`,
				};
			}
		} catch (err) {
			return { ok: false, error: `read failed: ${(err as Error).message}` };
		}

		const kind = kindFromPath(attachPath);
		const result = await sendMedia(chatId, {
			kind,
			path: attachPath,
			caption: message || undefined,
		});
		if (!result.ok) return { ok: false, error: result.error };
		return { ok: true, messageId: String(result.messageId ?? '') };
	}

	const result = await sendText(chatId, message, cfg.delivery);
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true, messageId: String(result.messageIds[0] ?? '') };
}

/** Health check — `getMe` validates the token; if a chat id is configured
 *  we don't probe it (Telegram's `getChat` requires the bot to have seen
 *  the chat at least once, which fails on first-run setups even when
 *  everything is fine). */
export async function test(): Promise<TestResult> {
	if (!process.env.TELEGRAM_BOT_TOKEN) {
		return { ok: false, status: 'unconfigured', message: 'TELEGRAM_BOT_TOKEN is not set.' };
	}
	const me = await getMe();
	if (me.ok) {
		// Cache it while we're here so the inbound dispatcher can use it.
		await refreshBotIdentity();
		return { ok: true, status: 'ok' };
	}
	if (me.httpStatus === 401) {
		return { ok: false, status: 'unauthorized', message: 'Bot token rejected.' };
	}
	if (me.httpStatus === 429) {
		return {
			ok: false,
			status: 'ratelimit',
			message: 'Telegram rate limit hit — try again shortly.',
		};
	}
	return {
		ok: false,
		status: 'invalid',
		message: me.description ?? me.error ?? 'getMe failed',
	};
}

export const adapter: ChannelAdapter = { meta, send, isConfigured, test };
