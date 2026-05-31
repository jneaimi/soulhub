/** Web channel turn dispatcher — ADR-003.
 *
 *  Single entry point for a web chat turn. Mirrors the
 *  `dispatchOrchestrated` path in `channels/telegram/dispatch.ts` but
 *  replaces outbound messaging with Server-Sent Events:
 *
 *    1. Start a `PresenceSession` backed by the SSE `write` callback
 *       (`webPresenceAdapter` → `startPresence`).
 *    2. Open a `bubble` placeholder so the drawer shows "🟡 Thinking…"
 *       within ~100ms of the user pressing send.
 *    3. Call `decideV2` with `onStreamEvent` wired to `presence.update()`
 *       so the bubble morphs through tool stages in real time.
 *    4. Render the `V2Output` onto the SSE stream and save both turns to
 *       `chat_history`.
 *
 *  contextPayload injection: `scope.contextPayload` (ADR-002) is
 *  prepended as a `system` role history entry on every web turn. Since
 *  `chat_history` stores only `user`/`assistant` rows, it is never
 *  duplicated — it is freshly derived from the live scope on each call.
 *
 *  Writes stay propose-only: `dispatchAgent` follows the same
 *  propose-vs-dispatch rule as Telegram; `vaultSave` routes through the
 *  ADR-046 chokepoint without modification. No new write path is added.
 *
 *  Agent dispatch (v2Output.kind === 'dispatch'): forwarded as a
 *  `complete` SSE event for the drawer to render. A background worker
 *  for the web channel is deferred to a follow-up ADR; for V1 the
 *  browser shows "agent confirmed" and the user can check the runs page.
 *
 *  SSE event shapes emitted (union of presence + orchestrator events):
 *
 *    Presence (from webPresenceAdapter):
 *      { kind: 'bubble',        messageId, text }
 *      { kind: 'bubble-update', messageId, text }
 *
 *    Orchestrator stream (passed through from onStreamEvent):
 *      { kind: 'tool-call-start', toolName }
 *      { kind: 'tool-result',     toolName, ok }
 *
 *    Terminal (exactly one per turn):
 *      { kind: 'complete', output: V2Output, usage: WindowUsage }
 *      { kind: 'error',    message: string  }
 */

import { decideV2 } from '../../orchestrator-v2/index.js';
import { loadHistory, saveTurn, snapshotWindowUsage } from '../../vault-chat/history.js';
import { startPresence } from '../_shared/presence.js';
import { webPresenceAdapter } from './presence-adapter.js';
import { isFocusQuery } from '../_shared/placeholder.js';
import {
	progressTextForTool,
	composingTextForTool,
} from '../_shared/tool-progress-text.js';
import type { V2Output } from '../../orchestrator-v2/types.js';

export interface WebTurnOpts {
	/** Raw message text from the browser. */
	message: string;
	/** Conversation key derived from scope — `web:project:<slug>` or
	 *  `web:global`. Scopes history so project turns are isolated from
	 *  each other and from the global scope. */
	conversationKey: string;
	/** ADR-002 `ScopeDescriptor.contextPayload` — injected as a `system`
	 *  history entry so the orchestrator knows which project/area the user
	 *  is viewing. Built fresh every turn; not stored in `chat_history`. */
	contextPayload: string;
	/** SSE write callback. Queues a JSON-serialised event on the browser
	 *  stream. The callback is synchronous (enqueue) and must not throw;
	 *  errors from a closed/cancelled stream are swallowed inside the
	 *  presence adapter. */
	write: (event: object) => void;
	/** Optional abort signal — the SSE route wires the request's signal
	 *  here so a browser navigation or tab close cancels the LLM call. */
	signal?: AbortSignal;
	/** ADR-011 — current scope kind forwarded to decideV2 so
	 *  `describeCurrentPage` can look up the correct catalog entry. */
	scopeKind?: string;
	/** ADR-011 — scope-specific params (e.g. `{ slug: 'naseej' }`). */
	scopeParams?: Record<string, string>;
}

/**
 * Derive the plain-text reply to save in `chat_history` from a V2Output.
 * Mirrors what the Telegram dispatcher saves.  Image turns store the
 * prompt slug; dispatch turns store the ack text.
 */
function assistantTextForOutput(out: V2Output): string {
	switch (out.kind) {
		case 'text':
		case 'error':
			return out.text;
		case 'proposal':
			return out.text;
		case 'image':
			return `[image] ${out.imagePrompt.slice(0, 120)}`;
		case 'dispatch':
			return `[dispatching ${out.agentId}]`;
		case 'slow-dispatched':
			return out.ack;
		// ADR-011 — navigate directive: save the confirm message as the
		// assistant turn so the conversation history shows what happened.
		case 'navigate':
			return `[navigate] ${out.url} — ${out.message}`;
	}
}

/**
 * Run one web chat turn end-to-end and drain all output onto the SSE stream.
 *
 * The function returns when the terminal `complete` or `error` event has been
 * emitted. The caller is responsible for closing the SSE stream afterward.
 */
export async function dispatchWebTurn(opts: WebTurnOpts): Promise<void> {
	const { message, conversationKey, contextPayload, write, signal, scopeKind, scopeParams } = opts;
	const turnNow = Date.now();

	// Prepend contextPayload as a `system` history entry so the orchestrator
	// sees the current project/area on every turn. `chat_history` only stores
	// `user`/`assistant` rows, so this is always freshly injected — never
	// duplicated in the stored history.
	const rawHistory = loadHistory(conversationKey);
	const history: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
		{ role: 'system', content: contextPayload },
		...rawHistory.map((m) => ({
			role: m.role as 'user' | 'assistant',
			content: m.content,
		})),
	];

	// ADR-028 Phase 1 — start presence session before the slow LLM call so
	// the drawer sees a bubble within ~100ms of the user pressing send.
	// `noTyping: true` because SSE streams have no native typing indicator.
	const presenceAdapter = webPresenceAdapter(write);
	const presence = startPresence(presenceAdapter, { noTyping: true });

	try {
		// Initial placeholder bubble: "🟡 Thinking…" morphs as tools fire.
		// ADR-015 S1 — capture the assigned bubble id so fallback writes can
		// target the real message instead of the hardcoded sentinel '1'.
		const assignedBubbleId = await presence.bubble('vault-chat', { isFocusQuery: isFocusQuery(message) });

		// Invoke decideV2 — wired to presence so the bubble morphs through
		// tool-call stages (ADR-029 streaming). `onStreamEvent` also forwards
		// the raw tool-lifecycle events to the browser for the drawer's
		// progress ring.
		let orch: Awaited<ReturnType<typeof decideV2>>;
		try {
			orch = await decideV2(message, {
				history,
				conversationKey,
				channel: 'web',
				// Default timezone; ADR-003 Phase 2 can surface this via the
				// settings page once per-user prefs are shipped.
				timezone: 'Asia/Dubai',
				signal,
				// ADR-011 — forward scope context so describeCurrentPage can
				// look up the catalog entry for the operator's current page.
				scopeKind,
				scopeParams,
				// ADR-029 — stream tool lifecycle events to both the presence
				// bubble (morphs the spinner text) and the browser (for the
				// drawer's live progress ring).
				onStreamEvent: (event) => {
					// Forward to browser first (non-blocking; write is sync).
					write(event);
					// Then morph the presence bubble text.
					if (event.kind === 'tool-call-start') {
						void presence.update(progressTextForTool(event.toolName));
					} else if (event.kind === 'tool-result') {
						const bubbleText = event.ok
							? composingTextForTool(event.toolName)
							: `🟡 ${event.toolName} hit an error — composing…`;
						void presence.update(bubbleText);
					}
				},
			});
		} catch (err) {
			const errMsg = (err as Error).message;
			console.warn(`[web/channel] decideV2 threw: ${errMsg}`);
			const errorText = 'Something went wrong — please try again.';
			// Try to morph the bubble into the error; fall back to raw event.
			const finalized = await presence.finalizeError(errorText);
			// ADR-015 S1 — use the real bubble id; omit the key entirely when
			// no bubble was sent (undefined) so the client falls back to its
			// tracked bubbleId rather than matching a stale/phantom id.
			if (!finalized) write({ kind: 'bubble-update', ...(assignedBubbleId && { messageId: assignedBubbleId }), text: errorText });
			write({ kind: 'error', message: errorText });
			return;
		}

		if (!orch.fellThrough && orch.v2Output) {
			const out = orch.v2Output;
			saveTurn(conversationKey, 'user', message, turnNow);

			// Derive the text to morph the bubble with. Image does not have a
			// direct text reply. Dispatch (ADR-007) gets a CTA label so the
			// bubble resolves from spinner → actionable card offer.
			// Navigate (ADR-011) shows the confirm message before goto() fires.
			const bubbleText: string | null =
				out.kind === 'text' || out.kind === 'proposal' || out.kind === 'error'
					? out.text
					: out.kind === 'dispatch'
						? '🚀 Heavy build — ready to dispatch to the Workbench'
						: out.kind === 'navigate'
							? out.message
							: null;

			if (bubbleText) {
				// Attempt to edit the bubble in place (standard path). Fall back
				// to a raw `bubble-update` event — the drawer handles both.
				const finalized = await presence.finalize(bubbleText);
				if (!finalized) write({ kind: 'bubble-update', ...(assignedBubbleId && { messageId: assignedBubbleId }), text: bubbleText });
			}

			// Persist the turn in chat_history for context on the next turn.
			saveTurn(
				conversationKey,
				'assistant',
				assistantTextForOutput(out),
				turnNow + 1,
			);

			// ADR-011 — emit the navigate event BEFORE `complete` so the drawer
			// calls goto() before the stream ends. The route change may cancel the
			// stream, but both events are already enqueued server-side.
			if (out.kind === 'navigate') {
				write({ kind: 'navigate', url: out.url });
			}

			// ADR-018 S1 — post-turn window snapshot; computed after both turns are
			// saved so the gauge reflects what the NEXT turn will see.
			const usage = snapshotWindowUsage(conversationKey);

			// Terminal event — the browser renders the full structured output
			// (drawer builds buttons for proposals, image previews, etc.).
			write({ kind: 'complete', output: out, usage });
			return;
		}

		// Orchestrator abstained or fell through — surface the decision's
		// clarify reply so the user isn't left with a blank bubble.
		const fallbackText =
			orch.decision?.reply ||
			"I'm not sure what you want me to do — can you rephrase?";

		saveTurn(conversationKey, 'user', message, turnNow);
		const finalized = await presence.finalize(fallbackText);
		if (!finalized) write({ kind: 'bubble-update', ...(assignedBubbleId && { messageId: assignedBubbleId }), text: fallbackText });
		saveTurn(conversationKey, 'assistant', fallbackText, turnNow + 1);
		// ADR-018 S1 — window snapshot for the gauge (fallback path).
		const fallbackUsage = snapshotWindowUsage(conversationKey);
		write({ kind: 'complete', output: { kind: 'text', text: fallbackText }, usage: fallbackUsage });
	} finally {
		presence.stop();
	}
}
