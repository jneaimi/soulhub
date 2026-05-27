/** SSE-backed PresenceAdapter for the web channel — ADR-003.
 *
 *  Maps the three `PresenceAdapter` primitives onto Server-Sent Events so
 *  `startPresence` from `_shared/presence.ts` drives the browser drawer's
 *  loading states without any code changes to the shared module.
 *
 *  SSE event shapes emitted by this adapter:
 *
 *    { kind: 'bubble',        messageId: string, text: string }
 *         ← send(): initial placeholder bubble — drawer shows the spinner text
 *
 *    { kind: 'bubble-update', messageId: string, text: string }
 *         ← edit(): placeholder morphs through tool stages and into the final reply
 *
 *  `typingTick` is intentionally a no-op: a browser SSE stream is not a
 *  messaging channel with a "typing…" indicator, so firing it would add
 *  spurious events. The bubble lifecycle is sufficient presence signal for
 *  the drawer (ADR-004).
 *
 *  The `write` callback must not throw; errors from a closed stream are
 *  caught inside `send`/`edit` and returned as `{ok:false}` so the
 *  `PresenceSession` falls back correctly per the edit-failure contract. */

import type { PresenceAdapter } from '../_shared/presence.js';

/** Factory — accepts a `write` callback that queues SSE events on the stream.
 *  Typically provided by `ReadableStreamDefaultController.enqueue()` wrapped
 *  in a JSON encoder. Swallow any errors from a closed stream internally. */
export function webPresenceAdapter(
	write: (event: object) => void,
): PresenceAdapter {
	/** Monotonically increasing per-session bubble id counter. */
	let nextId = 1;

	return {
		channel: 'web',

		send: async (text) => {
			const messageId = String(nextId++);
			try {
				write({ kind: 'bubble', messageId, text });
				return { ok: true, messageId };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		edit: async (messageId, text) => {
			try {
				write({ kind: 'bubble-update', messageId, text });
				return { ok: true };
			} catch (err) {
				return { ok: false, error: (err as Error).message };
			}
		},

		/** No-op — SSE streams have no native "typing" indicator. */
		typingTick: async () => {
			// Intentionally empty. See module-level doc for rationale.
		},
	};
}
