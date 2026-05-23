/** Webhook entry point — translates a raw Telegram `Update` JSON into a
 *  dispatcher call. Verifies the optional `X-Telegram-Bot-Api-Secret-
 *  Token` header before doing any other work; an invalid token gets a
 *  401 with no body so attackers can't probe the configuration.
 *
 *  Returns `{ ok: true }` synchronously and dispatches the inbound flow
 *  in the background so Telegram doesn't time us out (it expects a
 *  response in <60s; we don't want vault-chat latency to feed back into
 *  webhook reliability). */

import { buildEnvelope } from './inbound.js';
import { dispatchInbound } from './dispatch.js';
import { handleCallbackQuery } from './callback.js';
import { getBotIdentity } from './connection.js';
import type { TelegramChannelConfig, TgUpdate } from './types.js';

export interface WebhookResult {
	ok: boolean;
	httpStatus: number;
	error?: string;
}

export async function handleWebhook(
	update: TgUpdate,
	headerSecret: string | null,
	config: TelegramChannelConfig,
	account = 'personal',
): Promise<WebhookResult> {
	if (config.webhook.secretToken) {
		if (headerSecret !== config.webhook.secretToken) {
			// Don't echo why; protect the secret from probing.
			return { ok: false, httpStatus: 401, error: 'unauthorized' };
		}
	}

	if (!config.enabled) {
		// Pretend success so Telegram doesn't queue retries against a
		// disabled bot; the user toggling it back on shouldn't see a flood.
		return { ok: true, httpStatus: 200 };
	}

	if (update.callback_query) {
		// Run in background so Telegram gets a fast 200.
		void handleCallbackQuery(update.callback_query, config, account).catch((err) => {
			console.warn(`[telegram] callback_query failed: ${(err as Error).message}`);
		});
		return { ok: true, httpStatus: 200 };
	}

	const identity = getBotIdentity();
	const envelope = buildEnvelope(update, identity?.username, identity?.id);
	if (!envelope) return { ok: true, httpStatus: 200 };

	void dispatchInbound(envelope, config, account).catch((err) => {
		console.warn(`[telegram] dispatchInbound failed: ${(err as Error).message}`);
	});

	return { ok: true, httpStatus: 200 };
}
