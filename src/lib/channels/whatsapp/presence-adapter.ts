/** WhatsApp PresenceAdapter — ADR-028 Phase 1.
 *
 *  Worker-mode adapter that routes send/edit/typing through the HTTP
 *  control plane (`workerSend` POSTs to the soul-hub-whatsapp PM2
 *  process's /send endpoint). Editing is supported by Baileys via the
 *  same /send endpoint with an `editId` field — the underlying call is
 *  the unofficial WhatsApp message-edit endpoint, which is fragile in
 *  high-frequency use. v0 keeps a single bubble per turn so the edit
 *  load is bounded; ADR-029 will add progressive updates and explicitly
 *  caps the per-turn edit budget.
 *
 *  Typing tick: emitted via `/typing` if/when the worker exposes it.
 *  For now `sendPresenceUpdate('composing')` lives inside the worker
 *  process; the SvelteKit server has no direct Baileys socket. Until
 *  the worker exposes a typing endpoint, this adapter no-ops typingTick.
 *  The pre-existing `startTypingLoop` in `whatsapp/dispatch.ts` covers
 *  the in-process path; for worker-mode we accept that Layer A is best-
 *  effort and Layer B carries the visible weight.
 *
 *  Failure semantics: every operation catches its own errors. The
 *  presence layer above only sees structured `{ok, error}` returns;
 *  thrown errors are caught and reported as `{ok: false}` so the
 *  session's edit-disable logic kicks in cleanly. */

import type { PresenceAdapter } from '../_shared/presence.js';
import { workerSend } from './worker-client.js';
import type { WhatsAppWorkerConfig } from '../../config.schema.js';

export function whatsappPresenceAdapter(
	worker: WhatsAppWorkerConfig,
	chatJid: string,
): PresenceAdapter {
	return {
		channel: 'whatsapp',

		send: async (text) => {
			try {
				const result = await workerSend(worker, { to: chatJid, text });
				return {
					ok: result.ok,
					messageId: result.messageId,
					error: result.error,
				};
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		edit: async (messageId, text) => {
			try {
				const result = await workerSend(worker, {
					to: chatJid,
					text,
					editId: messageId,
				});
				return { ok: result.ok, error: result.error };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		typingTick: async () => {
			// Worker-mode typing is best-effort and currently no-op until the
			// worker exposes a /typing endpoint. The 👀 reaction ack on
			// inbound + the route-derived bubble cover the visible-feedback
			// gap on their own. Tracked as a follow-up under ADR-028.
		},
	};
}
