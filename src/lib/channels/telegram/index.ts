/** Public surface for the Telegram channel module.
 *
 *  Mirrors `channels/whatsapp/index.ts` so the registry can wire both
 *  channels with the same shape: `import { adapter, bootstrap }`.
 *  Bootstrap caches the bot identity so the inbound mention detector
 *  works on the very first message after a restart. */

import { refreshBotIdentity } from './connection.js';
import { readChannelConfig } from './adapter.js';

export { adapter, meta, isConfigured, send, test } from './adapter.js';
export { setupTelegram, getBotIdentity } from './connection.js';
export { handleWebhook } from './webhook-handler.js';
export type { TelegramChannelConfig } from './types.js';
export type { SetupResult } from './connection.js';

/** Idempotent bootstrap. When the channel is enabled and a token is
 *  present, refresh the bot identity in the background so inbound
 *  mention detection works without an extra API call per message.
 *  Failures are swallowed — the dispatcher will surface them on the
 *  first inbound update if anything is genuinely broken. */
export function bootstrap(): void {
	const cfg = readChannelConfig();
	if (!cfg?.enabled) return;
	if (!process.env.TELEGRAM_BOT_TOKEN) return;
	void refreshBotIdentity().catch((err) => {
		console.warn(`[telegram] bootstrap getMe failed: ${(err as Error).message}`);
	});
}
