/** Channel-agnostic "is typing…" helper. Per ADR-022 Layer A.
 *
 *  Wraps a slow promise and re-fires the channel's native typing indicator
 *  every 4s for the duration. The native indicator auto-clears in ~5-10s
 *  (both WhatsApp and Telegram), which is why we re-fire — a 4s cadence
 *  keeps it visible without flooding the channel.
 *
 *  The `sendIndicator` callback is channel-specific; callers wire it to:
 *    - WhatsApp: () => sendTypingIndicator(sock, jid)
 *    - Telegram: () => sendTypingIndicator(chatId)
 *
 *  Failures from `sendIndicator` are swallowed — typing UX is decorative
 *  and must never break the actual reply path. */

const REFIRE_INTERVAL_MS = 4000;

/** Start a typing-indicator re-fire loop. Returns a `stop()` function that
 *  the caller MUST call before sending the response (otherwise the
 *  indicator keeps firing for ~4-10s past delivery, which looks broken).
 *
 *  Use this when the dispatch flow has many branches and `keepTypingUntil`'s
 *  wrap-pattern is awkward. */
export function startTypingLoop(sendIndicator: () => Promise<unknown>): () => void {
	void sendIndicator().catch(() => {});
	const interval = setInterval(() => {
		void sendIndicator().catch(() => {});
	}, REFIRE_INTERVAL_MS);
	interval.unref?.();
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(interval);
	};
}

/** Wrap a promise in a typing-indicator loop. The loop stops on resolve
 *  OR reject. Cleaner than `startTypingLoop` when the caller has a single
 *  clean promise to await. */
export async function keepTypingUntil<T>(
	sendIndicator: () => Promise<unknown>,
	work: Promise<T>,
): Promise<T> {
	const stop = startTypingLoop(sendIndicator);
	try {
		return await work;
	} finally {
		stop();
	}
}
