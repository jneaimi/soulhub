/** Unified channel presence layer — ADR-028 Phase 1.
 *
 *  Channel-agnostic state machine that wraps the slow operations on a chat
 *  turn (router LLM, orchestrator-v2, fallback dispatchVaultChat) with:
 *
 *    Layer A — native typing indicator, re-fired every 4s until stop()
 *    Layer B — a single in-place bubble: send placeholder → edit-to-final
 *
 *  Both channels (WhatsApp + Telegram) inject a channel-specific
 *  `PresenceAdapter` that exposes the three primitives — send, edit,
 *  typingTick — and the shared session machinery here handles bubble
 *  state, dedup, the typing loop, and the edit-failure fallback contract.
 *
 *  Why this exists: ADR-022's Layer B was implemented on the legacy
 *  `dispatchVaultChat` fallback in both channels but never migrated when
 *  orchestrator-v2 became the primary path. Every modern slow query
 *  (inbox tools, vault-chat via orchestrator, web-search) ran 30-90s with
 *  no bubble. This module is the single integration point that closes the
 *  gap for both channels in one move.
 *
 *  Failure contract: `finalize()` returns `false` when the edit didn't
 *  land (no bubble was sent, channel doesn't support edits, rate-limit).
 *  Callers MUST handle the false return by falling back to a fresh send
 *  of the same text — losing the bubble morph is acceptable, losing the
 *  final reply is not. */

import { placeholderTextForRoute, type PlaceholderOpts } from './placeholder.js';

export interface PresenceAdapter {
	/** Channel name — used in logs and intent_log. */
	channel: 'whatsapp' | 'telegram';
	/** Send a fresh text message. Returns the message id for later edit
	 *  if the channel can edit; returns no id (or an ok=false) when the
	 *  send itself fails. */
	send: (text: string) => Promise<{ ok: boolean; messageId?: string; error?: string }>;
	/** Edit an existing message in place. Returns ok=false if the channel
	 *  doesn't support edits, the message has expired, or rate-limit hit. */
	edit: (messageId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
	/** Fire the channel's native typing indicator once. Idempotent;
	 *  swallow failures (presence is decorative). */
	typingTick: () => Promise<void>;
}

export interface PresenceSession {
	/** Send the route-specific placeholder bubble. No-op + returns the
	 *  existing id if already sent in this session. Returns `undefined`
	 *  when send fails (caller proceeds without a bubble; finalize will
	 *  fall back to a fresh send). */
	bubble: (route: string, opts?: PlaceholderOpts) => Promise<string | undefined>;
	/** ADR-029 — replace the bubble with transitional placeholder text
	 *  (e.g. "🟡 Reading your inbox…" while a tool runs). Idempotent vs.
	 *  the current bubble text, rate-budgeted, and degrades silently:
	 *
	 *    - returns `false` when no bubble exists, when the per-session
	 *      edit budget is exhausted, or when a prior `update` already
	 *      failed (updates-disabled latch)
	 *    - returns `false` BUT does NOT set the global `editsDisabled`
	 *      flag — finalize/morph still attempt their edit afterward
	 *    - lastText dedup prevents redundant Baileys edit traffic when
	 *      two events resolve to the same placeholder string */
	update: (text: string) => Promise<boolean>;
	/** Replace the bubble's text with the final reply. Returns `true`
	 *  when the edit landed; `false` when no bubble exists OR the edit
	 *  failed. Callers MUST handle false by sending `text` fresh. */
	finalize: (text: string) => Promise<boolean>;
	/** Same as `finalize` but semantically tagged as error path — logs
	 *  go to warn instead of debug. Behaviorally identical. */
	finalizeError: (text: string) => Promise<boolean>;
	/** Replace the bubble with a "moving on" message (e.g. when the
	 *  orchestrator returns a sub-action like image/dispatch that produces
	 *  its own follow-up). Same edit semantics as `finalize` but doesn't
	 *  imply "this turn is done". */
	morph: (text: string) => Promise<boolean>;
	/** Stop the typing loop. Idempotent. Call in `finally`. */
	stop: () => void;
	/** Lightweight introspection for tests / observability. ADR-029
	 *  adds `editCount`/`editBudget` so tests can assert budget caps. */
	state: () => {
		bubbleId: string | undefined;
		lastText: string | undefined;
		editCount: number;
		editBudget: number;
		updatesDisabled: boolean;
	};
}

export interface PresenceOptions {
	/** Typing-tick interval. ADR-022 picked 4s based on Telegram's auto-
	 *  clearing behavior; same value works for WhatsApp. */
	typingIntervalMs?: number;
	/** Suppress the typing loop (rare — primarily for tests). */
	noTyping?: boolean;
	/** ADR-029 — per-session edit budget. Counts the initial `bubble`
	 *  send AND every subsequent `update`/`morph`/`finalize` edit
	 *  attempt. Once exhausted, `update` becomes a silent no-op (still
	 *  returning false) while `finalize`/`morph` continue to attempt
	 *  (losing the final reply is the bigger sin than busting budget by
	 *  one). Default 5 — sized for Baileys' unofficial edit endpoint,
	 *  the more fragile of the two channels. Telegram callers can pass
	 *  8 since its official editMessageText has more headroom. */
	editBudget?: number;
}

const DEFAULT_TYPING_INTERVAL_MS = 4000;
const DEFAULT_EDIT_BUDGET = 5;

export function startPresence(
	adapter: PresenceAdapter,
	opts: PresenceOptions = {},
): PresenceSession {
	const interval = opts.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;
	const editBudget = opts.editBudget ?? DEFAULT_EDIT_BUDGET;

	let bubbleId: string | undefined;
	let lastText: string | undefined;
	let editsDisabled = false;
	/** ADR-029 — set when an `update()` edit fails. Further `update`
	 *  calls return false silently; `finalize`/`morph` keep going. */
	let updatesDisabled = false;
	/** Counts the initial `bubble` send + every edit attempt that
	 *  actually went on the wire (dedup hits don't count). */
	let editCount = 0;
	let stopped = false;

	// Fire Layer A immediately + schedule re-fire.
	const fireTyping = () => {
		if (stopped) return;
		adapter.typingTick().catch(() => {/* decorative — swallow */});
	};
	let typingTimer: ReturnType<typeof setInterval> | null = null;
	if (!opts.noTyping) {
		fireTyping();
		typingTimer = setInterval(fireTyping, interval);
	}

	const stop = () => {
		if (stopped) return;
		stopped = true;
		if (typingTimer) {
			clearInterval(typingTimer);
			typingTimer = null;
		}
	};

	const bubble = async (
		route: string,
		o?: PlaceholderOpts,
	): Promise<string | undefined> => {
		if (bubbleId) return bubbleId; // already sent this turn
		const text = placeholderTextForRoute(route, o);
		try {
			const result = await adapter.send(text);
			if (result.ok && result.messageId) {
				bubbleId = result.messageId;
				lastText = text;
				editCount += 1; // ADR-029 — the initial send counts toward budget
				return bubbleId;
			}
			console.warn(
				`[presence/${adapter.channel}] bubble send returned no messageId (ok=${result.ok} error=${result.error ?? 'none'}); proceeding without bubble`,
			);
		} catch (err) {
			console.warn(
				`[presence/${adapter.channel}] bubble send threw (${(err as Error).message}); proceeding without bubble`,
			);
		}
		return undefined;
	};

	const editTo = async (
		text: string,
		role: 'finalize' | 'finalizeError' | 'morph' | 'update',
	): Promise<boolean> => {
		if (!bubbleId) return false;
		if (editsDisabled) return false;
		// ADR-029 — updates have their own latch (updatesDisabled) so a
		// failed mid-turn update doesn't kill the final answer. Budget
		// is also update-only — finalize/morph always get a shot, even
		// if we busted budget on the way there.
		if (role === 'update') {
			if (updatesDisabled) return false;
			if (editCount >= editBudget) {
				// Silent no-op — caller gets `false` but no log spam.
				// (One INFO log per budget breach would help debugging;
				// suppressing for now since the path is hit per-tool-call.)
				return false;
			}
		}
		if (text === lastText) return true; // no-op dedup
		try {
			const result = await adapter.edit(bubbleId, text);
			if (result.ok) {
				lastText = text;
				editCount += 1;
				return true;
			}
			// Edit failed on the wire. Updates use the soft latch; the
			// answer-bearing edits (finalize/morph) use the hard latch
			// so callers know to fall back to a fresh send.
			if (role === 'update') {
				updatesDisabled = true;
				console.log(
					`[presence/${adapter.channel}] update edit failed (${result.error ?? 'unknown'}); updates disabled for rest of session, finalize still attempts`,
				);
			} else {
				editsDisabled = true;
				const logFn = role === 'finalizeError' ? console.warn : console.log;
				logFn(
					`[presence/${adapter.channel}] edit failed during ${role} (${result.error ?? 'unknown'}); edits disabled for rest of session`,
				);
			}
			return false;
		} catch (err) {
			if (role === 'update') {
				updatesDisabled = true;
				console.log(
					`[presence/${adapter.channel}] update edit threw (${(err as Error).message}); updates disabled, finalize still attempts`,
				);
			} else {
				editsDisabled = true;
				console.warn(
					`[presence/${adapter.channel}] edit threw during ${role} (${(err as Error).message}); edits disabled for rest of session`,
				);
			}
			return false;
		}
	};

	return {
		bubble,
		update: (text) => editTo(text, 'update'),
		finalize: (text) => editTo(text, 'finalize'),
		finalizeError: (text) => editTo(text, 'finalizeError'),
		morph: (text) => editTo(text, 'morph'),
		stop,
		state: () => ({ bubbleId, lastText, editCount, editBudget, updatesDisabled }),
	};
}
