/** Telegram PresenceAdapter — ADR-028 Phase 1.
 *
 *  Telegram has direct send/edit/typing primitives via the Bot API
 *  (no worker indirection like WhatsApp). The send and edit calls
 *  return the standard `{ok, messageIds}` shape from `outbound.ts`;
 *  we adapt those to the presence layer's `{ok, messageId}` contract.
 *
 *  Edit semantics are clean on Telegram — `editMessageText` is an
 *  official Bot API endpoint, no rate-limit fragility. The presence
 *  layer's edit-disable-on-first-failure rule still applies (mostly
 *  protects against unexpected Bot API errors).
 *
 *  Typing tick uses `sendChatAction('typing')` — auto-clears after
 *  ~5s server-side per Telegram docs, so the 4s re-fire keeps it alive.
 */

import type { PresenceAdapter } from '../_shared/presence.js';
import { sendText, editText, sendTypingIndicator } from './outbound.js';
import type { TelegramDeliveryConfig } from './types.js';

export function telegramPresenceAdapter(
	chatJid: string | number,
	delivery: TelegramDeliveryConfig,
): PresenceAdapter {
	return {
		channel: 'telegram',

		send: async (text) => {
			try {
				const result = await sendText(chatJid, text, delivery);
				return {
					ok: result.ok,
					messageId:
						result.messageIds.length > 0
							? String(result.messageIds[0])
							: undefined,
					error: result.error,
				};
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		edit: async (messageId, text) => {
			try {
				const result = await editText(chatJid, Number(messageId), text);
				return { ok: result.ok, error: result.error };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		typingTick: async () => {
			try {
				await sendTypingIndicator(chatJid);
			} catch {
				/* swallow — decorative only */
			}
		},
	};
}
