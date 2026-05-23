/**
 * Tool-using orchestrator (ADR-009) — public types.
 *
 * Phase 1 mapped tool calls back to v1 `OrchestratorDecision` action surface
 * so the inbound handler stayed unchanged. Phase 2 adds `V2Output` — when
 * tools actually execute side effects (proposal write, image generation,
 * web/vault search), decide-v2 returns the ready-to-send payload here so
 * the inbound handler short-circuits and doesn't re-dispatch.
 *
 * Phase 7 (after the A/B picks a winner) can drop the `decision` shim
 * entirely and consume `v2Output` directly.
 */

import type { OrchestratorDecision, DecideResult } from '../orchestrator/types.js';

/** Re-export for callers that don't want to know about the v1/v2 split. */
export type { OrchestratorDecision, DecideResult };

export interface DecideV2Options {
	signal?: AbortSignal;
	history?: { role: 'user' | 'assistant' | 'system'; content: string }[];
	conversationKey?: string;
	/** Sender phone number (for per-user image quota counters). */
	senderNumber?: string;
	/** ADR-025 — which chat channel this turn is on. Tools that need it
	 *  (e.g. `scheduleReminder`, which is WhatsApp-only in V1 because the
	 *  heartbeat reader is hardcoded to `'whatsapp'`) refuse gracefully
	 *  off-channel. Optional so legacy callers default to `undefined` →
	 *  channel-aware tools degrade rather than crash. */
	channel?: 'whatsapp' | 'telegram';
	/** ADR-025 — reminders config snapshot. Gates the `scheduleReminder`
	 *  tool: when undefined or `enabled: false`, the tool refuses with a
	 *  graceful error and the model relays it in plain language. */
	remindersConfig?: RemindersConfigSlice;
	/** ADR-025 — heartbeat config snapshot. Used by `scheduleReminder` to
	 *  surface a `cadenceNote` when `dueAt` falls outside active hours,
	 *  inside `muteUntil`, or when `heartbeat.enabled === false` (the row
	 *  is still inserted; the user is told it won't fire until they
	 *  toggle heartbeat back on). */
	heartbeatConfig?: HeartbeatConfigSlice;
	/** Image-generation config snapshot — gates whether `generateImage`
	 *  fires and how the daily cap is enforced. Optional so non-WhatsApp
	 *  callers (tests, debug routes) can omit it. */
	imgConfig?: ImgConfigSlice;
	/** YouTube fetch config snapshot (ADR-012) — gates whether `youtubeFetch`
	 *  fires the Gemini transcript tier and how the daily cap is enforced.
	 *  Tier A (oEmbed metadata) runs regardless. */
	youtubeConfig?: YoutubeConfigSlice;
	/** TikTok fetch config snapshot (ADR-024) — gates whether `tiktokFetch`
	 *  fires Tier B (whisper) / Tier C (Gemini) and enforces the daily cap +
	 *  duration cap. Tier A (yt-dlp metadata) runs regardless. */
	tiktokConfig?: TikTokConfigSlice;
	/** Account name from the WhatsApp config — scopes the image output dir. */
	account?: string;
	/** Timezone for the daily image-quota window (defaults Asia/Dubai). */
	timezone?: string;
	/** ADR-029 — fired during streaming as the orchestrator picks tools and
	 *  receives their results. Channel adapters wire this to
	 *  `presence.update()` to morph the placeholder bubble through stages
	 *  ("🟡 Running inbox-list-queued…" → "🟡 Inbox read — composing…").
	 *
	 *  Best-effort callback — exceptions are caught and logged, never
	 *  propagated. Decorative only: the orchestrator's correctness must
	 *  not depend on the callback succeeding. Most callsites pass nothing
	 *  (the orchestrator's existing return shape is unaffected). */
	onStreamEvent?: (event: OrchestratorStreamEvent) => void;
	/** ADR-030 — when set, slow tools (per the manifest's `latencyClass`)
	 *  short-circuit to background dispatch instead of awaiting inline.
	 *  Channel handlers populate this with the presence bubble's
	 *  messageId and a channel-agnostic `deliver` adapter so the
	 *  background worker can edit the same bubble when the work
	 *  completes. v2 (2026-05-13) supports WhatsApp + Telegram. */
	slowDispatch?: {
		jid: string;
		channel: 'whatsapp' | 'telegram';
		progressMessageId?: string;
		deliver?: import('../orchestrator/skill-worker.js').SkillDeliveryAdapter;
	};
}

/** ADR-029 — stream events surfaced from the AI SDK's `fullStream` after
 *  filtering to user-meaningful transitions. `tool-call-delta`,
 *  `text-delta`, and other high-volume events are dropped at the source
 *  (we'd blow Baileys' edit budget rendering them). */
export type OrchestratorStreamEvent =
	| {
			kind: 'tool-call-start';
			/** Tool name as registered in `buildOrchestratorTools()`. The
			 *  channel adapter looks this up in TOOL_PROGRESS to render the
			 *  user-friendly placeholder text. */
			toolName: string;
	  }
	| {
			kind: 'tool-result';
			toolName: string;
			/** `false` when the tool's `execute()` threw or returned an
			 *  `*-error` ToolResult variant. The channel adapter renders a
			 *  cautious "tool errored — composing…" placeholder so the user
			 *  knows the orchestrator is still trying. */
			ok: boolean;
	  };

/** Subset of `cfg.img` that the orchestrator needs. Decoupled from the
 *  full settings shape so tests can construct it without loading config. */
export interface ImgConfigSlice {
	enabled: boolean;
	maxPerDay: number;
	systemPromptPath: string;
	model?: string;
}

/** Subset of `cfg.youtube` (ADR-012) that the orchestrator needs.
 *  Mirrors `ImgConfigSlice`. */
export interface YoutubeConfigSlice {
	enabled: boolean;
	maxPerDay: number;
	model?: string;
}

/** Subset of `cfg.tiktok` (ADR-024) that the orchestrator needs.
 *  Mirrors `YoutubeConfigSlice` with an extra `maxDurationSec` cap because
 *  TikTok now allows 30-min clips that would blow whisper's turn budget. */
export interface TikTokConfigSlice {
	enabled: boolean;
	maxPerDay: number;
	maxDurationSec: number;
	model?: string;
}

/** Subset of `cfg.reminders` (ADR-025) that the orchestrator needs. */
export interface RemindersConfigSlice {
	enabled: boolean;
}

/** Subset of `cfg.heartbeat` (ADR-025) that the `scheduleReminder` tool
 *  needs to compose its confirmation message. Mirrors the runtime
 *  `cadenceNote` decision: outside-active-hours → defer to start of next
 *  active window; muteUntil in future → defer past mute; heartbeat
 *  disabled → row stored but won't fire. */
export interface HeartbeatConfigSlice {
	enabled: boolean;
	activeHours: {
		start: string; // "HH:MM"
		end: string;
		timezone: string;
	};
	muteUntil: string | null; // ISO datetime or null
}

/** What a v2 tool actually produced — used by the inbound handler to
 *  decide what to send back over WhatsApp. Only set when at least one
 *  tool with a side effect ran. */
export type V2Output =
	| {
			kind: 'text';
			/** Final assistant text to send. Either the LLM's wrap-up message
			 *  or, when the LLM didn't speak, the last tool's formatted text
			 *  (web-search citation, vault-chat answer, raw `reply` text). */
			text: string;
			/** ADR-014 — when the LLM's reply was composed from a youtubeFetch
			 *  result with a summary, surface the structured fields so a
			 *  channel adapter can render follow-up action buttons (Save /
			 *  Full transcript / Skip). Channel adapters that don't support
			 *  inline buttons (e.g. WhatsApp via Baileys) ignore this field. */
			youtubeContext?: {
				videoUrl: string;
				title: string;
				summary: string;
			};
	  }
	| {
			kind: 'image';
			/** Absolute path to the generated PNG (already written to disk). */
			attachPath: string;
			/** Optional caption — currently always `undefined` from `dispatchImg`
			 *  but reserved for future IMG.md prompt revisions. */
			caption?: string;
			/** Original image prompt — saved into `chat_history` so future
			 *  history can show "[image] <prompt>". */
			imagePrompt: string;
			/** Final assistant text from the LLM (if any) — sent as a separate
			 *  text turn before the image when present. Most of the time the
			 *  IMG.md prompt suppresses any text and this is empty. */
			text?: string;
	  }
	| {
			kind: 'proposal';
			/** Pre-formatted proposal message ("Confirm I should run *X*…"). */
			text: string;
	  }
	| {
			kind: 'dispatch';
			/** Confirmed agent dispatch — the inbound handler runs the same
			 *  capacity-check + worker-ack + `runInBackground` path as the v1
			 *  `action: dispatch` branch. The orchestrator tool only signals
			 *  the intent because the dispatch needs `envelope.chatJid`,
			 *  `worker`, and conversation `ctx` that live one layer up. */
			agentId: string;
			task: string;
	  }
	| {
			kind: 'error';
			/** User-facing error text from a failed tool execution. */
			text: string;
	  }
	/** ADR-030 — a slow tool dispatched in the background. The presence
	 *  bubble should morph to `ack`; the LLM's final reply is suppressed
	 *  this turn because the background skill-worker will edit the same
	 *  bubble with the full result when complete. */
	| {
			kind: 'slow-dispatched';
			toolName: string;
			ack: string;
	  };

/** Per-call telemetry surfaced to the inbound handler for analytics. */
export interface DecideV2Telemetry {
	/** OpenRouter model id (e.g. `z-ai/glm-4.6`). */
	model: string;
	/** ADR-009 Phase 5 — A/B branch label (`glm-4.6` / `sonnet-4.6` /
	 *  `minimax-m2` / `deepseek-v4-flash` / `deepseek-v4-pro` /
	 *  `fixed-override`). */
	modelBranch: string;
	stepsUsed: number;
	toolCalls: { name: string; argSummary: string }[];
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	durationMs: number;
	/** ADR-033 Layer 1 — 12-char SHA1 prefix of the composed persona bundle
	 *  (soul + identity + user-profile + boundaries). Stamped on every turn
	 *  so the audit dashboard can stratify routing decisions by persona
	 *  version (§Engines play 1) and detect voice drift after operator
	 *  edits to `operations/soul.md` (§Engines play 4). Undefined when the
	 *  kill switch is off or all four files are empty. */
	personaBundleHash?: string;
}
