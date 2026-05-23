/**
 * Background dispatch worker for slow orchestrator-v2 tools (ADR-030).
 *
 * Sibling to `runInBackground` (agent dispatch). The shape is similar
 * but the unit-of-work is a tool's `execute()` closure + a formatter
 * that turns the structured result into chat-ready prose — there's no
 * `dispatchAgent`/PTY/agent_runs row involved.
 *
 * Flow per turn:
 *   1. The channel handler has already sent a presence bubble (e.g.
 *      "🟡 Fetching YouTube video…") and captured its `messageId`.
 *   2. The slow tool's execute() called `runSkillInBackground` and
 *      returned `kind: 'slow-dispatched'` immediately — the LLM step
 *      sees this and the channel handler skips its final reply send.
 *   3. This worker awaits `executeFn()`, formats the structured result
 *      via `formatFn`, and edits the bubble's `progressMessageId`
 *      in place via the channel-agnostic `deliver` adapter. If the
 *      body exceeds the edit cap, the bubble gets a short status line
 *      and the full body lands as a follow-up.
 *
 * Cancellation: registers in `active-runs` keyed by a synthetic runId
 * (`skill:<toolName>:<rand>`), so `cancelByJid(jid)` reaches it.
 *
 * v2 scope (2026-05-13): WhatsApp + Telegram. Both channels build a
 * `SkillDeliveryAdapter` from their respective transport — the worker
 * is channel-agnostic and only cares about `send`/`edit`.
 */

import { saveTurn } from '$lib/vault-chat/history.js';
import { setActive, clearActive } from './active-runs.js';

/** Minimal transport contract the skill worker needs: send a fresh
 *  message, or edit a previously-sent one in place. Subset of
 *  `PresenceAdapter` (no typingTick) so callers can plug in either the
 *  presence adapter directly or a lighter-weight closure. */
export interface SkillDeliveryAdapter {
	channel: 'whatsapp' | 'telegram';
	send: (text: string) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
	edit: (messageId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface RunSkillInBackgroundArgs {
	jid: string;
	toolName: string;
	/** Channel-agnostic delivery transport. Both WhatsApp and Telegram
	 *  callsites build this from their presence adapter. */
	deliver: SkillDeliveryAdapter;
	/** Channel-side bubble id from the presence layer — edited in place
	 *  with the formatted result. Omit to send a fresh message instead. */
	progressMessageId?: string;
	conversationKey?: string;
	/** Runs the actual tool work. Resolves to the tool's structured
	 *  result; rejects on failure. The closure should capture all args
	 *  it needs — `runSkillInBackground` is opaque to tool internals. */
	executeFn: () => Promise<unknown>;
	/** Turns the structured result into chat-ready text. Called only on
	 *  success — error/timeout paths emit their own message. */
	formatFn: (result: unknown) => string;
	/** Caller-provided cap. Defaults to 120s — youtubeFetch summary
	 *  observed at 20-60s, transcript up to 90s with retries. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_EDIT_BODY_CHARS = 1800;

/** Fire-and-forget. Caller does NOT await. Errors are caught and
 *  surfaced to the chat — never thrown back to the caller's loop. */
export function runSkillInBackground(args: RunSkillInBackgroundArgs): void {
	const {
		jid,
		toolName,
		deliver,
		progressMessageId,
		conversationKey,
		executeFn,
		formatFn,
		timeoutMs,
	} = args;

	const controller = new AbortController();
	const startedAt = Date.now();
	const runId = `skill:${toolName}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	setActive({ runId, agentId: `skill:${toolName}`, jid, startedAt, abortController: controller });

	const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);

	void (async () => {
		try {
			const result = await executeFn();
			if (controller.signal.aborted) {
				await deliverText(deliver, progressMessageId, `🚫 *${toolName}* — cancelled.`);
				return;
			}
			const body = formatFn(result);
			const finalText = body.length > MAX_EDIT_BODY_CHARS
				? body.slice(0, MAX_EDIT_BODY_CHARS - 16) + '\n…(truncated)'
				: body;
			await deliverText(deliver, progressMessageId, finalText);

			if (conversationKey) {
				try {
					saveTurn(conversationKey, 'assistant', finalText);
				} catch (err) {
					console.warn(
						`[skill-worker] chat_history save failed for ${toolName}: ${(err as Error).message}`,
					);
				}
			}
		} catch (err) {
			const aborted = controller.signal.aborted;
			const message = aborted
				? `🚫 *${toolName}* — cancelled or timed out.`
				: `⚠️ *${toolName}* — ${(err as Error).message}`;
			await deliverText(deliver, progressMessageId, message);
		} finally {
			clearTimeout(timeoutHandle);
			clearActive(runId);
		}
	})();
}

async function deliverText(
	deliver: SkillDeliveryAdapter,
	editId: string | undefined,
	text: string,
): Promise<void> {
	try {
		if (editId) {
			const result = await deliver.edit(editId, text);
			if (!result.ok) {
				console.warn(
					`[skill-worker/${deliver.channel}] edit failed (${result.error ?? 'unknown'}); falling back to fresh send`,
				);
				await deliver.send(text);
			}
		} else {
			await deliver.send(text);
		}
	} catch (err) {
		console.error(
			`[skill-worker/${deliver.channel}] settle send failed editId=${editId ?? 'none'}: ${(err as Error).message}`,
		);
	}
}
