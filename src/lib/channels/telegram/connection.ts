/** Bot identity + webhook lifecycle.
 *
 *  The bot's `id` and `username` are read once at startup (or via the
 *  `setup` endpoint) and cached in-process so the inbound dispatcher
 *  can detect mentions without re-calling `getMe` per message. */

import {
	getChatMenuButton,
	getMe,
	getMyCommands,
	getWebhookInfo,
	setChatMenuButton,
	setMyCommands,
	setWebhook,
	type MenuButton,
	type WebhookInfo,
	type BotCommand,
} from './client.js';
import type { BotInfo, TelegramChannelConfig } from './types.js';

let cachedBot: BotInfo | null = null;

/** Fetch the bot's identity (id + username) and cache it. Subsequent
 *  reads are zero-cost. Returns null if the token is missing or
 *  invalid — the inbound mention detector falls back to the raw
 *  `text_mention` entity (still works for replies) in that case. */
export async function refreshBotIdentity(): Promise<BotInfo | null> {
	const result = await getMe();
	if (!result.ok || !result.result) {
		cachedBot = null;
		return null;
	}
	cachedBot = result.result;
	return cachedBot;
}

export function getBotIdentity(): BotInfo | null {
	return cachedBot;
}

export interface SetupResult {
	ok: boolean;
	bot?: BotInfo;
	webhook?: WebhookInfo;
	commands?: BotCommand[];
	menuButton?: MenuButton;
	error?: string;
}

/** Idempotent setup. Calls `getMe` (caches identity), `setWebhook` if a
 *  URL is configured, and `setMyCommands` from the channel intent map.
 *  Safe to call repeatedly — Telegram returns the same status object
 *  even when nothing changed. */
export async function setupTelegram(
	config: TelegramChannelConfig,
): Promise<SetupResult> {
	const me = await refreshBotIdentity();
	if (!me) {
		return { ok: false, error: 'getMe failed — check TELEGRAM_BOT_TOKEN' };
	}

	if (config.webhook.url) {
		const wh = await setWebhook({
			url: config.webhook.url,
			secret_token: config.webhook.secretToken,
			allowed_updates: ['message', 'edited_message', 'callback_query'],
			drop_pending_updates: false,
		});
		if (!wh.ok) {
			return { ok: false, bot: me, error: `setWebhook: ${wh.error}` };
		}
	}

	const commands = buildBotCommands(config);
	if (commands.length > 0) {
		const cmd = await setMyCommands({ commands });
		if (!cmd.ok) {
			// Non-fatal — webhook is the critical part.
			console.warn(`[telegram] setMyCommands failed: ${cmd.error}`);
		}
	}

	const menuButton = buildMenuButton(config);
	if (menuButton) {
		const mb = await setChatMenuButton({ menu_button: menuButton });
		if (!mb.ok) {
			console.warn(`[telegram] setChatMenuButton failed: ${mb.error}`);
		}
	}

	const info = await getWebhookInfo();
	const live = await getMyCommands();
	const liveButton = await getChatMenuButton();
	return {
		ok: true,
		bot: me,
		webhook: info.ok ? info.result : undefined,
		commands: live.ok ? live.result : commands,
		menuButton: liveButton.ok ? liveButton.result : menuButton ?? undefined,
	};
}

/** Translate the channel intent map into Telegram's `BotCommand[]`. We
 *  only register slash commands that have a `description` (the `default`
 *  pseudo-entry is excluded). Telegram caps descriptions at 256 chars
 *  and the command itself at 32 — we truncate defensively. */
/** Derive the persistent menu button (left of the input) from the
 *  webhook origin. Opens `<origin>/orchestration` as a Telegram Web App.
 *  Returns null if no webhook URL is configured (can't host a Web App
 *  without HTTPS) — falls back to the default commands menu. */
function buildMenuButton(config: TelegramChannelConfig): MenuButton | null {
	const webhookUrl = config.webhook.url;
	if (!webhookUrl) return null;
	let origin: string;
	try {
		origin = new URL(webhookUrl).origin;
	} catch {
		return null;
	}
	if (!origin.startsWith('https://')) return null;
	return {
		type: 'web_app',
		text: 'Orchestration',
		web_app: { url: `${origin}/orchestration` },
	};
}

function buildBotCommands(config: TelegramChannelConfig): BotCommand[] {
	const out: BotCommand[] = [];
	for (const [token, mapping] of Object.entries(config.intentMap)) {
		if (token === 'default') continue;
		if (!token.startsWith('/')) continue;
		const command = token.slice(1, 33).toLowerCase();
		if (!command) continue;
		const description = (mapping.description ?? mapping.route).slice(0, 256);
		out.push({ command, description });
	}
	return out;
}
