/**
 * Zod schemas for Soul Hub settings (`~/.soul-hub/settings.json`).
 *
 * The Zod schema is the source of truth — `SoulHubConfig` type is derived via
 * `z.infer<typeof ConfigSchema>`. Settings are validated on load and on POST.
 *
 * Defaults here MUST match the live behaviour of Soul Hub:
 *   - server.port: 2400 (PM2 prod)
 *   - proxy.blockedPorts: [2400] (block self-proxy)
 *   - orchestration.depInstaller: 'auto' | 'npm' | 'pnpm'
 *   - paths.* defaults match installer expectations (~/dev, ~/vault, …)
 */

import { z } from 'zod';
import { RoutesSchema } from './routes/route.schema.js';

export const TerminalSchema = z.object({
	fontSize: z.number().int().min(8).max(24).default(13),
	cols: z.number().int().min(40).max(400).default(120),
	rows: z.number().int().min(10).max(120).default(40),
	cursorBlink: z.boolean().default(true),
});

export const InterfaceSchema = z.object({
	defaultPanel: z.enum(['code', 'closed']).default('code'),
	panelWidth: z.number().int().min(180).max(800).default(260),
});

export const PathsSchema = z.object({
	devDir: z.string().default('~/dev'),
	vaultDir: z.string().default('~/vault'),
	// Empty → derived at runtime as <repo>/catalog (see buildResolved in
	// config.ts). The catalog ships inside the repo, so its location follows
	// wherever the repo lives — never a hardcoded author path. Set explicitly
	// to override.
	catalogDir: z.string().default(''),
	claudeBinary: z.string().default('~/.local/bin/claude'),
});

/** ADR-008 (oss-hardening) — feature visibility flags. Modules that ship in the
 *  codebase but are not yet surfaced in a given distribution. Default `true`
 *  so the operator's own instance is unchanged; the public export seeds these
 *  `false` in `settings.example.json` to hide not-yet-released surfaces (Naseej,
 *  Workspaces) and the decommissioning Playbook engine until they are ready.
 *  When `false`: the nav entry + homepage tile are hidden and the route is
 *  redirected home (server-side, so deep-links don't bypass it). */
// ADR-008 — not-yet-released modules default OFF so a fresh/public install
// hides them safely WITHOUT depending on settings.json seeding. The operator
// opts IN by setting these true in ~/.soul-hub/settings.json.
export const FeaturesSchema = z.object({
	naseej: z.boolean().default(false),
	workspaces: z.boolean().default(false),
	playbook: z.boolean().default(false),
	// ADR-010 — public-distribution update-available banner + daily release
	// drift check. INVERTED default vs the others: the operator's private
	// command center develops features before they ship, so it wants this OFF
	// (default false). The public export seeds it true in release-export.sh.
	updateCheck: z.boolean().default(false),
	// ADR-016 — operator-only deploy-pending detector + one-click rebuild &
	// reload banner. Default ON for the operator's private instance (which
	// benefits from the guard); the public export seeds it OFF (public installs
	// don't use pm2 in the same way and have no local HEAD to track).
	localRedeploy: z.boolean().default(true),
});
export type FeaturesConfig = z.infer<typeof FeaturesSchema>;

export const ServerSchema = z.object({
	port: z.number().int().min(1).max(65535).default(2400),
});

export const ChannelActionSchema = z.enum(['send', 'prompt', 'listen']);

export const ChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	label: z.string().default(''),
	defaultFor: z.array(ChannelActionSchema).default([]),
});

/** WhatsApp-specific config — extends the generic ChannelConfig with the
 *  fields the Baileys adapter needs (auth dir, access policy, intent map). */
const E164 = z.string().regex(/^\+\d{6,15}$/, 'Expected E.164 phone number, e.g. "+9715xxxxxxxx"');

export const WhatsAppAccessSchema = z
	.object({
		dmPolicy: z.enum(['allowlist', 'open', 'disabled']).default('allowlist'),
		allowFrom: z.array(z.union([E164, z.literal('*')])).default([]),
		groupPolicy: z.enum(['allowlist', 'open', 'disabled']).default('allowlist'),
		groupAllowFrom: z.array(E164).default([]),
		groups: z
			.record(
				z.string(),
				z.object({ requireMention: z.boolean().default(true) }),
			)
			.default({}),
		mentionPatterns: z.array(z.string()).default([]),
	})
	.refine((d) => d.dmPolicy !== 'open' || d.allowFrom.includes('*'), {
		message: '`dmPolicy: "open"` requires `allowFrom` to include "*".',
	});

export const WhatsAppIntentMapSchema = z.record(
	z.string(),
	z.object({
		route: z.string(),
		description: z.string().optional(),
		/** Slice 1.5 — opt-in smart routing for free-form (non-slash) messages.
		 *  Only meaningful on the `default` entry; ignored on slash entries
		 *  (those always dispatch the explicit `/<command>` regardless).
		 *  When `false` (default), free-form messages always flow to the
		 *  `default.route` (`vault-chat`). When `true`, the dispatcher first
		 *  runs `routeFreeForm()` (regex → Gemini Flash with confidence
		 *  thresholds) and rewrites the route if the router is sure enough. */
		dynamic: z.boolean().optional(),
	}),
);

export const WhatsAppDeliverySchema = z.object({
	textChunkLimit: z.number().int().min(500).max(60_000).default(4000),
	chunkMode: z.enum(['newline', 'hard']).default('newline'),
	sendReadReceipts: z.boolean().default(true),
	ackEmoji: z.string().default('👀'),
	/** Print the QR pairing code to stdout as ASCII when one appears.
	 *  Useful when the Settings UI isn't reachable (headless first-run).
	 *  The PNG data URL is always exposed via /api/channels/whatsapp/status
	 *  regardless of this flag. */
	printTerminalQr: z.boolean().default(true),
	/** Drop inbound media that exceeds this size — protects the disk and
	 *  the transcription budget from runaway uploads. WhatsApp's own cap
	 *  is ~16MB for audio/voice, ~100MB for video. */
	maxMediaSizeMB: z.number().int().min(1).max(200).default(16),
	/** Auto-transcribe inbound voice notes and feed the transcript to the
	 *  routes layer as if it were typed text. Disable to keep voice notes
	 *  ignored or to handle them with a manual command. */
	transcribeVoiceNotes: z.boolean().default(true),
	/** Provider:model used for voice transcription. Must currently be a
	 *  Gemini reference — Gemini is the only multimodal provider wired
	 *  in this channel today. */
	transcribeProvider: z
		.string()
		.regex(/^gemini:.+$/)
		.default('gemini:gemini-2.5-flash'),
});

export const WhatsAppAccountSchema = z.object({
	authDir: z.string().default('~/.soul-hub/data/whatsapp/personal'),
});

/** Crash-isolation runtime: when `enabled`, Baileys lives in a separate
 *  PM2 app (`soul-hub-whatsapp`) and the main SvelteKit server proxies
 *  control + outbound calls to it via HTTP. Inbound messages flow back
 *  via a callback to `${mainAppUrl}/api/channels/whatsapp/_inbound`. */
export const WhatsAppWorkerSchema = z.object({
	enabled: z.boolean().default(false),
	url: z.string().url().default('http://127.0.0.1:2401'),
	mainAppUrl: z.string().url().default('http://127.0.0.1:2400'),
	/** Optional shared secret. When set, the main app and the worker
	 *  reject calls without a matching `Authorization: Bearer <token>`
	 *  header. Recommended for any host that exposes 2401 beyond
	 *  loopback; ignored on default loopback-only setups. */
	bearerToken: z.string().optional(),
});
export type WhatsAppWorkerConfig = z.infer<typeof WhatsAppWorkerSchema>;

/** ADR-001 P3 — the heartbeat's delivery binding. A *pointer into the channel-
 *  adapter registry* (`getHeartbeatChannel(channel)`), not WhatsApp-specific
 *  code, so it lives in the neutral top-level `heartbeat` config. Change
 *  `channel` to move the heartbeat between any channel that has registered a
 *  HeartbeatChannel adapter (today: `whatsapp`). `target` is the recipient in
 *  that channel's address format (E.164 for WhatsApp, chat-id for Telegram). */
export const HeartbeatDeliverySchema = z.object({
	channel: z.string().min(1).default('whatsapp'),
	target: z.string().min(1).optional(),
});

/** ADR-001 P3 — top-level, channel-neutral heartbeat config. Lifted off
 *  `channels.whatsapp.heartbeat` (the engine reads it via an injected provider,
 *  not from here directly). Holds the operational knobs (cadence, active-hours,
 *  cap, model, prompt) plus the `delivery` binding; the per-channel `target` now
 *  lives in `delivery.target`. A one-version read-shim in `config.ts` backfills
 *  this from the legacy `channels.whatsapp.heartbeat` location until the
 *  settings.json migration drops it. */
export const HeartbeatSchema = z.object({
	enabled: z.boolean().default(false),
	delivery: HeartbeatDeliverySchema.prefault({}),
	soulPath: z.string().default('operations/soul.md'),
	checklistPath: z.string().default('operations/whatsapp/HEARTBEAT.md'),
	activeHours: z
		.object({
			start: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
			end: z.string().regex(/^\d{2}:\d{2}$/).default('23:00'),
			timezone: z.string().default('Asia/Dubai'),
		})
		.prefault({}),
	maxPerDay: z.number().int().min(1).max(20).default(3),
	muteUntil: z.string().datetime().nullable().default(null),
	ackMaxChars: z.number().int().min(50).max(2000).default(300),
	model: z
		.string()
		.regex(/^(gemini|claude-cli|openrouter|anthropic):.+$/, 'Expected "<provider>:<model>"')
		.default('gemini:gemini-2.5-flash'),
	basePrompt: z
		.string()
		.default(
			'Read HEARTBEAT.md (workspace context). Follow it strictly. ' +
				'If a task block is included below, run it. Do not infer or repeat old tasks. ' +
				'If nothing genuinely needs attention, reply HEARTBEAT_OK.',
		),
});

/** Inferred commitments — Slice 5. After every meaningful WhatsApp exchange,
 *  a hidden Flash extraction pass spots conversation-bound follow-ups
 *  ("interview tomorrow" → check in afterward). Off by default. Stored
 *  scoped to (channel, target) so a commitment from one chat can't leak
 *  to another. See `~/vault/projects/soul-hub-brain/index.md → Slice 5`. */
export const WhatsAppCommitmentsSchema = z.object({
	enabled: z.boolean().default(false),
	/** Provider:model ref for the extraction call. Should be cheap — runs
	 *  on every meaningful exchange. Flash is the default. */
	extractionModel: z
		.string()
		.regex(/^(gemini|claude-cli|openrouter|anthropic):.+$/, 'Expected "<provider>:<model>"')
		.default('gemini:gemini-2.5-flash'),
	/** Below this score the extracted commitment is dropped without
	 *  storage. 0.8 is conservative — false positives are worse than
	 *  false negatives because users see the noise. */
	confidenceThreshold: z.number().min(0).max(1).default(0.8),
	/** Earliest the extracted commitment becomes due. Clamps to at least
	 *  one heartbeat interval after creation so we don't echo it back
	 *  in the very next tick. */
	dueDelayHours: z.number().min(0).max(168).default(1),
	/** Cap on commitments included in a single heartbeat tick — controls
	 *  prompt bloat. Each row only surfaces once (status flips to
	 *  `surfaced` after delivery), so the global noise ceiling is
	 *  governed by `heartbeat.maxPerDay`, which counts all deliveries
	 *  regardless of source. This knob just keeps any one tick brief. */
	maxPerDay: z.number().int().min(1).max(20).default(5),
});

/** ADR-025 — user-explicit reminders set via the `scheduleReminder`
 *  orchestrator tool. Reminders ride the same `commitments` table as
 *  extractor-inferred follow-ups but are surfaced under a different
 *  prompt section and capped independently — the user's explicit ask
 *  shouldn't be crowded out by a noisy extractor queue.
 *
 *  `maxPerDay` is a per-tick slice cap (matching the `commitments`
 *  semantics), not a true daily cap. Global daily volume is governed by
 *  `heartbeat.maxPerDay`, which counts every delivered tick regardless
 *  of source. */
export const WhatsAppRemindersSchema = z.object({
	enabled: z.boolean().default(true),
	maxPerDay: z.number().int().min(1).max(50).default(10),
});

/** Layer 3 Stage 3a — real-time anomaly push.
 *
 *  Heartbeat tick reads new transactional + personal rows from inbox.db,
 *  applies the gate (anomalyHint OR amount-threshold OR CRM sender OR
 *  category=personal), and fires a separate WhatsApp message per
 *  qualifying row — bypasses the LLM heartbeat composition for
 *  determinism + auditability.
 *
 *  Per ADR §D4.1: heartbeat is the right rail for this (time-sensitive,
 *  30-min cadence, active-hours-aware, mute-respecting). The daily
 *  digest (S3b) ships separately as a scheduler task. */
export const WhatsAppInboxAnomalySchema = z.object({
	/** OFF by default. Operator enables once they've eyeballed the
	 *  extracted_data for a few days and tuned thresholds. */
	enabled: z.boolean().default(false),
	/** Absolute amount above which a transactional row is pushed
	 *  regardless of anomalyHint. Currency-typed via `thresholdCurrency`. */
	thresholdAmount: z.number().min(0).default(1000),
	/** Currency for `thresholdAmount`. Rows in other currencies skip the
	 *  threshold branch (anomalyHint and CRM-sender branches still apply). */
	thresholdCurrency: z.string().default('AED'),
	/** How far back the candidate query looks on each tick — tolerates a
	 *  few missed ticks without re-pushing already-handled rows (the
	 *  agent_actions exclusion clause is the real deduplication). */
	lookbackHours: z.number().int().min(1).max(48).default(6),
	/** Max anomalies pushed per tick. Runaway protection — prevents a
	 *  classification flood from spamming WhatsApp. */
	perTickCap: z.number().int().min(1).max(20).default(5),
});

/** ADR 2026-05-11-inbox-agent-workflows-layer-3 §D5 — Stage 4 auto-route.
 *
 *  Worker periodically picks queued messages and, when their category +
 *  cached `extracted_data` match an enabled per-category rule, saves them
 *  to the vault and marks them processed. ALL rules default OFF — the
 *  operator opts in per-category after eyeballing the extracted-data
 *  stream from S2.
 *
 *  Kill switches: `INBOX_AUTO_ROUTE_DISABLED=1` (worker-specific) and
 *  `INBOX_AGENT_DISABLED=1` (all Layer 3) override the schema even if
 *  the operator enabled rules in settings.json. */
const InboxAutoRouteAmountRuleSchema = z.object({
	enabled: z.boolean().default(false),
	/** Inclusive minimum amount required to route. `0` means "any amount". */
	minAmount: z.number().min(0).default(0),
	/** ISO currency code (e.g. "AED"). Rows in other currencies are skipped. */
	currency: z.string().default('AED'),
});

const InboxAutoRouteAnomalyRuleSchema = z.object({
	enabled: z.boolean().default(false),
	/** When true, only routes rows where the extractor flagged
	 *  `anomalyHint=true`. False routes all matching rows. */
	anomalyOnly: z.boolean().default(true),
});

const InboxAutoRouteSimpleRuleSchema = z.object({
	enabled: z.boolean().default(false),
});

/** Auto-delete rule: when matched, the message is marked processed in
 *  inbox.db WITHOUT writing a vault note. For categories that are useless
 *  shortly after arrival (e.g., OTPs expire in minutes — saving them to
 *  the vault is just noise that needs curating later). */
const InboxAutoRouteDeleteRuleSchema = z.object({
	enabled: z.boolean().default(false),
});

export const InboxAutoRouteSchema = z.object({
	/** Master switch. OFF by default — operator opts in. */
	enabled: z.boolean().default(false),
	/** Worker tick cadence. 60s is fast enough for "feels live" without
	 *  hammering SQLite or vault writes. */
	intervalMs: z.number().int().min(10_000).max(3_600_000).default(60_000),
	/** How far back the worker looks for queued rows on each tick. The
	 *  agent_actions exclusion clause is the real dedup — this is a
	 *  safety net to skip ancient rows on cold-start. Cap is 30 days
	 *  (720h) — large enough for a one-shot backfill of the existing
	 *  queued backlog when an operator first enables auto-route. */
	lookbackHours: z.number().int().min(1).max(720).default(24),
	/** Max routes per tick. Prevents a category-mass-relabel from
	 *  flooding the vault. */
	perTickCap: z.number().int().min(1).max(50).default(10),
	/** Per-account `retention_days` controls overall queued-row lifetime,
	 *  but it's set conservatively (30/90d) to preserve personal mail. For
	 *  messages that the worker SKIPPED every tick (no rule fired), 30 days
	 *  of churn is wasteful. After this many days a queued+no-route row
	 *  gets pruned aggressively. Personal messages keep the original
	 *  per-account retention. */
	queuedNoMatchPruneDays: z.number().int().min(1).max(90).default(7),
	receipts: InboxAutoRouteAmountRuleSchema.prefault({ minAmount: 50 }),
	payments: InboxAutoRouteAmountRuleSchema.prefault({ minAmount: 200 }),
	refunds: InboxAutoRouteAmountRuleSchema.prefault({ minAmount: 0 }),
	subscriptionRenewals: InboxAutoRouteAmountRuleSchema.prefault({ minAmount: 0 }),
	statements: InboxAutoRouteSimpleRuleSchema.prefault({}),
	alerts: InboxAutoRouteAnomalyRuleSchema.prefault({}),
	shipping: InboxAutoRouteSimpleRuleSchema.prefault({}),
	serviceAlerts: InboxAutoRouteAnomalyRuleSchema.prefault({}),
	/** OTPs are short-lived by design — saving them to the vault is noise.
	 *  When enabled, the worker marks them processed without a vault write
	 *  so they exit the queue cleanly. */
	otps: InboxAutoRouteDeleteRuleSchema.prefault({}),
});

export type InboxAutoRouteConfig = z.infer<typeof InboxAutoRouteSchema>;

export const InboxSchema = z.object({
	autoRoute: InboxAutoRouteSchema.prefault({}),
});

/** ADR-023 §Phase 2 + §Phase 3 — runtime pattern engine kill switches.
 *
 *  `enabled` (P2) — gates the lookup against operator-approved
 *  `intent_patterns` rows. The analyst (P1.5) keeps writing proposals
 *  regardless; this flag only governs whether `routeFreeForm` consults
 *  the approved table during routing.
 *
 *  `historyFallback` (P3) — gates an additional history-derived lookup
 *  that fires when P2 misses: queries the user's own recent `intent_log`
 *  rows for the same normalized signature and short-circuits if recent
 *  rows agree strongly on a route. Independent of `enabled` so the
 *  operator can opt in to one without the other.
 *
 *  Both default OFF — a fresh install never short-circuits the LLM
 *  router until the operator opts in. */
export const IntentPatternEngineSchema = z.object({
	enabled: z.boolean().default(false),
	historyFallback: z.boolean().default(false),
	historyMinVotes: z.number().int().min(2).max(50).default(5),
	historyMinAgreement: z.number().min(0.5).max(1).default(0.9),
	historyWindowDays: z.number().int().min(1).max(180).default(30),
});

export const IntentSchema = z.object({
	patternEngine: IntentPatternEngineSchema.prefault({}),
});

export type IntentConfig = z.infer<typeof IntentSchema>;

/** ADR-033 Layer 1 — persona bundle wired into the orchestrator system
 *  prompt at chat time. Vault-loaded, hot-reloaded via `reindexed` events
 *  (see `persona/loader.ts`). Flipping `enabled: false` reverts the chat
 *  voice to the pre-ADR-033 routing-rules-only prompt in one config edit. */
export const ChatPersonaSchema = z.object({
	enabled: z.boolean().default(true),
	soulPath: z.string().default('operations/soul.md'),
	userProfilePath: z.string().default('operations/user-profile.md'),
	boundariesPath: z.string().default('operations/boundaries.md'),
	identityPath: z.string().default('operations/identity.md'),
});

export const ChatSchema = z.object({
	persona: ChatPersonaSchema.prefault({}),
});

export type ChatConfig = z.infer<typeof ChatSchema>;

/** `/img` configuration — image generation + editing via Gemini Nano
 *  Banana. One slash command, no flags, system prompt sourced from a
 *  vault-watched markdown file (per ADR-002). */
export const WhatsAppImgSchema = z.object({
	enabled: z.boolean().default(true),
	/** Per-target soft cap. Hit cap → reply with budget message, no API
	 *  call. Hard ceiling on the schema (50) prevents a runaway from
	 *  costing more than ~$2/day at the GA model. */
	maxPerDay: z.number().int().min(1).max(50).default(20),
	/** Default Gemini image model. Settings UI exposes a dropdown for
	 *  swapping to the preview tiers (`gemini-3.1-flash-image-preview`,
	 *  `gemini-3-pro-image-preview`) once the user wants the cost bump. */
	model: z.string().default('gemini-2.5-flash-image'),
	/** Path to the system-prompt markdown file (vault-relative). Hot-
	 *  reloaded via the vault watcher. Edit in Obsidian. */
	systemPromptPath: z.string().default('operations/whatsapp/IMG.md'),
});

/** ADR-012 — `youtubeFetch` tool config. Tier A (oEmbed metadata) always
 *  runs and is free. Tier B (Gemini multimodal) is the only reliable
 *  transcript path from server IPs — capped per-target so share-spam
 *  can't burn the budget. */
export const WhatsAppYoutubeSchema = z.object({
	enabled: z.boolean().default(true),
	/** Per-target soft cap. Hit cap → tool returns metadata-only with a
	 *  `note: transcript-quota-exceeded` hint, no Gemini call. Ceiling
	 *  caps a runaway at ~$1/day on Flash. */
	maxPerDay: z.number().int().min(1).max(50).default(5),
	/** Default Gemini model for video understanding. Flash is the cost-
	 *  effective default; swap to `gemini-2.5-pro` for richer summaries. */
	model: z.string().default('gemini-2.5-flash'),
});

/** ADR-024 — `tiktokFetch` tool config. Tier A (yt-dlp metadata) always
 *  runs and is free. Tier B (whisper.cpp local STT) is free if the host
 *  has the deps installed. Tier C (Gemini multimodal) is paid — capped
 *  per-target so share-spam can't burn the budget. The runtime capability
 *  probe in src/lib/tiktok/whisper.ts disables the tool entirely when
 *  yt-dlp/ffmpeg/whisper-cli are missing, so a fresh install without
 *  TikTok deps is safe by default. */
export const WhatsAppTiktokSchema = z.object({
	enabled: z.boolean().default(true),
	/** Per-target soft cap on Tier C (Gemini summary) calls. Tier B (local
	 *  whisper) is free and uncounted. Hit cap → tool returns metadata +
	 *  transcript with a `note: summary-quota-exceeded` hint. */
	maxPerDay: z.number().int().min(1).max(50).default(5),
	/** Hard cap on clip duration (seconds) before Tier B/C are skipped.
	 *  TikTok now allows 30-min clips; transcribing a full 30-min clip with
	 *  ggml-base on M-series ≈ 3.5 min wall-clock — too slow for a chat
	 *  turn. 600s = 10 min covers ~99% of clips in practice. */
	maxDurationSec: z.number().int().min(30).max(1800).default(600),
	/** Default Gemini model for video understanding. Flash is the cost-
	 *  effective default; swap to `gemini-2.5-pro` for richer summaries. */
	model: z.string().default('gemini-2.5-flash'),
});

/** Telegram-specific config — extends the generic ChannelConfig with the
 *  fields the Bot API adapter needs (allowlist, intent map, webhook).
 *  Telegram chat IDs are integers (positive for DMs, negative for groups);
 *  we store them as numeric strings for JSON-friendliness. */
const TG_USER_ID = z.string().regex(/^\d+$/, 'Expected a positive integer Telegram user_id');
const TG_CHAT_ID = z.string().regex(/^-?\d+$/, 'Expected a Telegram chat_id (positive int for DM, negative for group)');

export const TelegramAccessSchema = z
	.object({
		dmPolicy: z.enum(['allowlist', 'open', 'disabled']).default('allowlist'),
		/** Telegram numeric user_ids that may DM the bot. `'*'` opens DMs. */
		allowFrom: z.array(z.union([TG_USER_ID, z.literal('*')])).default([]),
		groupPolicy: z.enum(['allowlist', 'open', 'disabled']).default('allowlist'),
		/** Group chat_ids (negative integers, `-100xxx` for supergroups). */
		groupAllowFrom: z.array(TG_CHAT_ID).default([]),
		groups: z
			.record(
				z.string(),
				z.object({ requireMention: z.boolean().default(true) }),
			)
			.default({}),
	})
	.refine((d) => d.dmPolicy !== 'open' || d.allowFrom.includes('*'), {
		message: '`dmPolicy: "open"` requires `allowFrom` to include "*".',
	});

export const TelegramIntentMapSchema = z.record(
	z.string(),
	z.object({
		route: z.string(),
		description: z.string().optional(),
		dynamic: z.boolean().optional(),
	}),
);

export const TelegramDeliverySchema = z.object({
	textChunkLimit: z.number().int().min(500).max(4096).default(4000),
	chunkMode: z.enum(['newline', 'hard']).default('newline'),
	/** Telegram has no inbound-ack reaction primitive that doesn't pollute the
	 *  group; leave empty by default. Set to a string (e.g. 👀) to send a
	 *  `setMessageReaction` ack on every accepted inbound message. */
	ackEmoji: z.string().default(''),
	/** Drop inbound media that exceeds this size. Telegram's Bot API caps
	 *  download at 20MB; default 20 matches that. */
	maxMediaSizeMB: z.number().int().min(1).max(50).default(20),
	transcribeVoiceNotes: z.boolean().default(true),
	transcribeProvider: z
		.string()
		.regex(/^gemini:.+$/)
		.default('gemini:gemini-2.5-flash'),
	/** Outbound parse_mode for sendMessage. Markdown is the legacy mode and
	 *  forgiving about lone `*`/`_`; switch to MarkdownV2 if you need full
	 *  inline-formatting fidelity at the cost of stricter escaping. */
	parseMode: z.enum(['Markdown', 'MarkdownV2', 'HTML', 'none']).default('Markdown'),
});

export const TelegramWebhookSchema = z.object({
	/** Public URL Telegram pushes updates to — typically your Cloudflare
	 *  tunnel host + `/api/channels/telegram/_webhook`. Required to use
	 *  webhook delivery; if absent, the bot is a one-way speaker. */
	url: z.string().url().optional(),
	/** Optional shared secret. When set, we register it via `setWebhook`
	 *  and reject any inbound POST whose `X-Telegram-Bot-Api-Secret-Token`
	 *  header doesn't match. Strongly recommended. */
	secretToken: z.string().min(1).max(256).optional(),
});

export const TelegramChannelSchema = ChannelConfigSchema.extend({
	access: TelegramAccessSchema.prefault({}),
	delivery: TelegramDeliverySchema.prefault({}),
	webhook: TelegramWebhookSchema.prefault({}),
	intentMap: TelegramIntentMapSchema.default({
		'/save': { route: 'vault-save-note', description: 'Capture a note (text/image/voice/video) into the vault inbox.' },
		'/find': { route: 'vault-find', description: 'Search the vault — top 5 matches.' },
		'/recent': { route: 'vault-recent', description: 'List the 5 most-recently-touched notes.' },
		'/img': { route: 'img', description: 'Generate an image (no attachment) or edit one (attach the source).' },
		default: { route: 'vault-chat', dynamic: false },
	}),
});

export const WhatsAppChannelSchema = ChannelConfigSchema.extend({
	account: z.string().default('personal'),
	accounts: z
		.record(z.string(), WhatsAppAccountSchema)
		.default({ personal: { authDir: '~/.soul-hub/data/whatsapp/personal' } }),
	access: WhatsAppAccessSchema.prefault({}),
	delivery: WhatsAppDeliverySchema.prefault({}),
	worker: WhatsAppWorkerSchema.prefault({}),
	commitments: WhatsAppCommitmentsSchema.prefault({}),
	reminders: WhatsAppRemindersSchema.prefault({}),
	inboxAnomaly: WhatsAppInboxAnomalySchema.prefault({}),
	img: WhatsAppImgSchema.prefault({}),
	youtube: WhatsAppYoutubeSchema.prefault({}),
	tiktok: WhatsAppTiktokSchema.prefault({}),
	intentMap: WhatsAppIntentMapSchema.default({
		'/save': { route: 'vault-save-note', description: 'Capture a note (text/image/voice/video) into the vault inbox.' },
		'/find': { route: 'vault-find', description: 'Search the vault — top 5 matches.' },
		'/recent': { route: 'vault-recent', description: 'List the 5 most-recently-touched notes.' },
		'/img': { route: 'img', description: 'Generate an image (no attachment) or edit one (attach the source).' },
		default: { route: 'vault-chat', dynamic: false },
	}),
});

export const OrchestrationSchema = z.object({
	maxWorkers: z.number().int().min(1).max(16).default(4),
	maxIterationsPerWorker: z.number().int().min(1).default(8),
	worktreeDir: z.string().default('.worktrees'),
	depInstaller: z.enum(['pnpm', 'npm', 'auto']).default('auto'),
});

export const ProxySchema = z.object({
	enabled: z.boolean().default(true),
	allowedPortRange: z.tuple([z.number().int(), z.number().int()]).default([1024, 9999]),
	blockedPorts: z.array(z.number().int()).default([2400]),
});

/** A single scheduled task declared in settings.json.
 *
 *  `type` resolves at runtime to a registered task handler (see
 *  `src/lib/scheduler/task-types.ts`). Tasks whose type isn't yet
 *  registered are skipped with a warning instead of failing the load —
 *  this keeps the scheduler tolerant of incremental rollout (e.g. a
 *  user upgrading Soul Hub between phases). */
export const SchedulerTaskSchema = z.object({
	id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-_]*$/, 'lowercase kebab/snake; letters, digits, - or _'),
	type: z.string().min(1),
	cron: z.string().min(1),
	timezone: z.string().optional(),
	enabled: z.boolean().default(true),
	noOverlap: z.boolean().default(true),
	description: z.string().optional(),
	/** Catchup-on-boot policy. `run` (default) re-fires the task once if it
	 *  missed its scheduled fire while the process was down. `skip` excludes
	 *  it from catchup entirely — correct for *measurement* tasks (falsifiers,
	 *  liveness probes) where re-running a stale measurement on every restart
	 *  adds no value and only spams the hygiene page. Delivery tasks (digests,
	 *  backups) should stay `run`. See ADR 2026-05-22-graceful-shutdown-fix P2. */
	catchupPolicy: z.enum(['run', 'skip']).optional(),
	/** Task-handler-specific config — opaque to the scheduler. The
	 *  factory for `type` is responsible for parsing this. */
	params: z.record(z.string(), z.unknown()).default({}),
});

/** Core system tasks every install gets for free — health monitoring + vault
 *  self-healing. Defined in CODE (not just settings.example.json) so they exist
 *  even when settings.json predates them or omits a scheduler block. Merged into
 *  the user's tasks by id in `applyAdditiveSchemaDefaults` (config.ts): a
 *  settings entry with the same id WINS, so the operator can retune or disable
 *  any of them. All three degrade gracefully when no notification channel is
 *  configured (they simply don't send). No timezone → scheduler-local time. */
export const CORE_SCHEDULER_TASKS: z.infer<typeof SchedulerTaskSchema>[] = [
	{
		id: 'heartbeat',
		type: 'heartbeat',
		cron: '*/30 * * * *',
		enabled: true,
		noOverlap: true,
		description: 'System heartbeat — health checks, agent follow-ups, scheduled commitments.',
		params: {},
	},
	{
		id: 'vault-hygiene',
		type: 'vault-hygiene',
		cron: '*/30 * * * *',
		enabled: true,
		noOverlap: true,
		description: 'Vault hygiene self-healing — orphans, stale inbox, governance (ADR-010).',
		params: {},
	},
	{
		id: 'hygiene-digest-daily',
		type: 'hygiene-digest',
		cron: '0 8 * * *',
		enabled: true,
		noOverlap: true,
		description: 'Once-daily batched vault-health digest (silent on clean days).',
		params: {},
	},
	{
		// ADR-012 Fix 1 — code-default so every install gets the daily vault git
		// safety-net snapshot even when settings.json predates it (the seed-only
		// path in bootstrap.sh is skipped when settings.json already exists). The
		// `<REPO_ROOT>` cwd placeholder is resolved to process.cwd() at merge time
		// in applyAdditiveSchemaDefaults (settings.json gets it substituted at
		// seed time instead). Safe on any machine: vault-backup-daily.sh commits
		// locally and pushes only if an origin remote exists (soft-fails otherwise).
		id: 'vault-backup-daily',
		type: 'shell-script',
		cron: '0 23 * * *',
		enabled: true,
		noOverlap: true,
		description: 'Daily vault git snapshot (+ push if origin set) — safety net under event-driven commits (ADR-019).',
		params: {
			command: ['bash', 'scripts/vault-backup-daily.sh'],
			cwd: '<REPO_ROOT>',
			timeoutMs: 60000,
		},
	},
	{
		// ADR-010 — daily public-release drift check. Fetches GitHub
		// /releases/latest, writes the cache the version endpoint + AppHeader
		// banner read. Gated by the `updateCheck` feature flag: the merge in
		// applyAdditiveSchemaDefaults skips this core task unless the flag is
		// true, so the operator's private instance (flag default false) never
		// reconciles it (ADR-010 F1).
		id: 'update-check',
		type: 'update-check',
		cron: '0 */6 * * *',
		enabled: true,
		noOverlap: true,
		description: 'Check every 6h for a newer published GitHub Release (ADR-010) — drives the update-available banner.',
		params: {},
	},
];

export const SchedulerSchema = z.object({
	enabled: z.boolean().default(true),
	/** When the process boots, any `started` row whose age exceeds this
	 *  is closed out as `error: 'process-crashed'` so overlap protection
	 *  doesn't stay jammed after a crash. Default 30 min covers every
	 *  expected task; raise it if a long migration runs as a task. */
	staleRunMaxRuntimeMs: z.number().int().min(60_000).default(30 * 60 * 1000),
	tasks: z.array(SchedulerTaskSchema).default(CORE_SCHEDULER_TASKS),
});

/** Operator-notification routing. `operatorChannels` is the set of channels
 *  `notifyOperator()` fans a proactive operator message out to (digests,
 *  anomaly alerts, audit nudges). Telegram-only by default. WhatsApp is only
 *  *deliverable* when the WhatsApp worker is up and `heartbeat.delivery.target`
 *  (the operator's number) is set — the Settings UI gates the toggle on that,
 *  and `notifyOperator` no-ops WhatsApp if the target is missing. */
export const NotificationsSchema = z.object({
	operatorChannels: z.array(z.enum(['telegram', 'whatsapp'])).min(1).default(['telegram']),
});

export const ConfigSchema = z.object({
	terminal: TerminalSchema.prefault({}),
	interface: InterfaceSchema.prefault({}),
	paths: PathsSchema.prefault({}),
	/** ADR-008 — feature visibility flags (default all-on; public export seeds off). */
	features: FeaturesSchema.prefault({}),
	server: ServerSchema.prefault({}),
	/** Optional public base URL (e.g. https://soul-hub.example.com) used to
	 *  build external dashboard links in Telegram nudges. Undefined on
	 *  loopback-only setups — links are then omitted. */
	host: z.string().optional(),
	/** ADR 2026-05-11-inbox-agent-workflows-layer-3 — top-level inbox
	 *  config. v1 hosts only the Layer 3 Stage 4 auto-route block. Future
	 *  cycles can hang the L2 filter knobs here too (today they're env-
	 *  driven) without disrupting the channel namespaces. */
	inbox: InboxSchema.prefault({}),
	/** ADR-023 §Phase 2 — runtime pattern engine kill switch. See
	 *  IntentSchema. Top-level (not channel-scoped) because the underlying
	 *  intent_patterns table is shared across WhatsApp and (future)
	 *  Telegram orchestrator-v2 wiring. */
	intent: IntentSchema.prefault({}),
	/** ADR-033 Layer 1 — chat-time persona (soul / identity / user-profile
	 *  / boundaries) wired into the orchestrator system prompt. Top-level
	 *  because the persona is shared across all chat channels (WhatsApp
	 *  today, Telegram in scope). See ChatSchema. */
	chat: ChatSchema.prefault({}),
	/** ADR-001 P3 — top-level, channel-neutral heartbeat config (the proactive
	 *  ambient-agent loop). Lifted off `channels.whatsapp.heartbeat`; the engine
	 *  reads it through an injected provider. Top-level because the heartbeat is
	 *  an orchestration primitive, not a WhatsApp feature — its delivery channel
	 *  is itself configurable (`heartbeat.delivery.channel`). See HeartbeatSchema. */
	heartbeat: HeartbeatSchema.prefault({}),
	/** Operator-notification routing (which channels proactive operator
	 *  messages fan out to). Top-level + channel-neutral. See NotificationsSchema. */
	notifications: NotificationsSchema.prefault({}),
	// Channels store base fields strictly + allow per-channel extensions to
	// flow through; each adapter Zod-validates its own slice on read (e.g.
	// WhatsAppChannelSchema for the `whatsapp` entry).
	channels: z.record(z.string(), ChannelConfigSchema.passthrough()).prefault({
		telegram: {
			enabled: false,
			label: 'Telegram',
			defaultFor: ['send'],
			access: {
				dmPolicy: 'allowlist',
				allowFrom: [],
				groupPolicy: 'allowlist',
				groupAllowFrom: [],
				groups: {},
			},
			delivery: {
				textChunkLimit: 4000,
				chunkMode: 'newline',
				ackEmoji: '',
				maxMediaSizeMB: 20,
				transcribeVoiceNotes: true,
				transcribeProvider: 'gemini:gemini-2.5-flash',
				parseMode: 'Markdown',
			},
			webhook: {},
			intentMap: {
				'/save': { route: 'vault-save-note', description: 'Capture a note (text/image/voice/video) into the vault inbox.' },
				'/find': { route: 'vault-find', description: 'Search the vault — top 5 matches.' },
				'/recent': { route: 'vault-recent', description: 'List the 5 most-recently-touched notes.' },
				'/img': { route: 'img', description: 'Generate an image (no attachment) or edit one (attach the source).' },
				default: { route: 'vault-chat', dynamic: false },
			},
		},
		whatsapp: {
			enabled: false,
			label: 'WhatsApp',
			defaultFor: [],
			account: 'personal',
			accounts: { personal: { authDir: '~/.soul-hub/data/whatsapp/personal' } },
			access: {
				dmPolicy: 'allowlist',
				allowFrom: [],
				groupPolicy: 'allowlist',
				groupAllowFrom: [],
				groups: {},
				mentionPatterns: [],
			},
			delivery: {
				textChunkLimit: 4000,
				chunkMode: 'newline',
				sendReadReceipts: true,
				ackEmoji: '👀',
				printTerminalQr: true,
				maxMediaSizeMB: 16,
				transcribeVoiceNotes: true,
				transcribeProvider: 'gemini:gemini-2.5-flash',
			},
			worker: {
				enabled: false,
				url: 'http://127.0.0.1:2401',
				mainAppUrl: 'http://127.0.0.1:2400',
			},
			heartbeat: {
				enabled: false,
				every: '30m',
				soulPath: 'operations/soul.md',
				checklistPath: 'operations/whatsapp/HEARTBEAT.md',
				activeHours: { start: '08:00', end: '23:00', timezone: 'Asia/Dubai' },
				maxPerDay: 3,
				muteUntil: null,
				ackMaxChars: 300,
				isolatedSession: true,
				model: 'gemini:gemini-2.5-flash',
			},
			commitments: {
				enabled: false,
				extractionModel: 'gemini:gemini-2.5-flash',
				confidenceThreshold: 0.8,
				dueDelayHours: 1,
				maxPerDay: 5,
			},
			reminders: {
				enabled: true,
				maxPerDay: 10,
			},
			img: {
				enabled: true,
				maxPerDay: 20,
				model: 'gemini-2.5-flash-image',
				systemPromptPath: 'operations/whatsapp/IMG.md',
			},
			intentMap: {
				'/save': { route: 'vault-save-note', description: 'Capture a note (text/image/voice/video) into the vault inbox.' },
				'/find': { route: 'vault-find', description: 'Search the vault — top 5 matches.' },
				'/recent': { route: 'vault-recent', description: 'List the 5 most-recently-touched notes.' },
				'/img': { route: 'img', description: 'Generate an image (no attachment) or edit one (attach the source).' },
				default: { route: 'vault-chat', dynamic: false },
			},
		},
	}),
	orchestration: OrchestrationSchema.prefault({}),
	proxy: ProxySchema.prefault({}),
	scheduler: SchedulerSchema.prefault({}),
	routes: RoutesSchema.prefault({
		'vault-chat': {
			description: 'Free-form chat against the vault — primary intent for WhatsApp DMs.',
			default: 'openrouter:z-ai/glm-4.6',
			failover: ['gemini:gemini-flash-latest'],
			timeoutMs: 12000,
			retries: 1,
			onError: ['timeout', '5xx', 'rate_limit', 'network'],
		},
		'vault-save-note': {
			description: 'Multimodal extraction for `/save` — Gemini Flash directly (cheap + supports image/video/document).',
			default: 'gemini:gemini-2.5-flash',
			failover: ['openrouter:google/gemini-2.5-flash'],
			timeoutMs: 12000,
			retries: 1,
			onError: ['timeout', '5xx', 'rate_limit', 'network'],
		},
		'vault-find': {
			description: 'Lexical vault search for `/find` — no LLM call; route registered for telemetry symmetry.',
			default: 'gemini:gemini-2.5-flash',
			failover: [],
			timeoutMs: 4000,
			retries: 0,
			onError: ['timeout', '5xx', 'rate_limit', 'network'],
		},
		'vault-recent': {
			description: 'Recency listing for `/recent` — no LLM call; route registered for telemetry symmetry.',
			default: 'gemini:gemini-2.5-flash',
			failover: [],
			timeoutMs: 4000,
			retries: 0,
			onError: ['timeout', '5xx', 'rate_limit', 'network'],
		},
		img: {
			description: 'Image generation + editing via Gemini Nano Banana — direct call (no failover; routes layer is text-only).',
			default: 'gemini:gemini-2.5-flash-image',
			failover: [],
			timeoutMs: 30000,
			retries: 0,
			onError: ['timeout', '5xx', 'rate_limit', 'network'],
		},
	}),
});

/** Raw inference. `channels` is a `z.record(...).passthrough()`, so its value
 *  type is the generic `ChannelConfig` plus an `unknown` catchall — which means
 *  `channels.telegram.delivery`, `channels.whatsapp.access`, etc. all resolve to
 *  the catchall (`{}`) at the type level even though every adapter relies on the
 *  precise per-channel shape. */
type RawSoulHubConfig = z.infer<typeof ConfigSchema>;

/** Public config type. Runtime is unchanged — this is a pure compile-time view.
 *  The two well-known channel keys are typed against their dedicated schemas so
 *  consumers read real field types instead of the record's `{}` catchall.
 *
 *  This is deliberately optimistic about nesting: the runtime `channels` schema
 *  is a loose passthrough record, so a hand-edited settings.json could omit a
 *  nested block (e.g. `telegram.delivery`). That's tolerated because (a) the
 *  `.prefault` default materialises both channels fully when `channels` is
 *  absent, (b) each adapter re-validates its own slice through these schemas on
 *  read, and (c) every direct top-level consumer already optional-chains + guards
 *  (`channels?.telegram?.delivery` → `if (!delivery) return`). The non-optional
 *  keys match an assumption the codebase already makes (see config.ts, which
 *  dereferences `channels.whatsapp.intentMap` directly). Extra channel keys keep
 *  flowing through the record's index signature. */
export type SoulHubConfig = Omit<RawSoulHubConfig, 'channels'> & {
	channels: RawSoulHubConfig['channels'] & {
		telegram: z.infer<typeof TelegramChannelSchema>;
		whatsapp: z.infer<typeof WhatsAppChannelSchema>;
	};
};

/** Nested channel blocks that DIRECT top-level consumers (notify-operator, the
 *  scheduler digest/anomaly/audit handlers, the vault escalators) dereference
 *  WITHOUT going through an adapter's `readChannelConfig` re-validation. Telegram
 *  is the active operator-notification channel; if `access`/`delivery` drop out
 *  of settings.json the loose runtime record no longer carries them, the precise
 *  `SoulHubConfig` typing silently lies, and every consumer falls through its
 *  `if (!delivery) return` guard — so operator Telegram alerts go dark with no
 *  error. WhatsApp blocks are intentionally NOT asserted: its adapter re-parses
 *  its slice on read, so a missing top-level block is backfilled there.
 *
 *  Backs the `channel-config-precise-shape` governance contract. */
export const PRECISE_CHANNEL_BLOCKS = {
	telegram: ['access', 'delivery'],
} as const;

/** Per-channel blocks the loose runtime config is missing vs what the precise
 *  `SoulHubConfig` typing assumes. Empty arrays = the typing is sound for the
 *  live config. Pure; shared by the config loader (runtime warn) and the
 *  `channel-config-precise-shape` falsifier script. */
export function findMissingChannelBlocks(
	channels: Record<string, unknown> | undefined,
): Record<keyof typeof PRECISE_CHANNEL_BLOCKS, string[]> {
	const ch = (key: string) => channels?.[key] as Record<string, unknown> | undefined;
	const missing = (key: keyof typeof PRECISE_CHANNEL_BLOCKS) => {
		const entry = ch(key);
		if (!entry) return [...PRECISE_CHANNEL_BLOCKS[key]];
		return PRECISE_CHANNEL_BLOCKS[key].filter((b) => entry[b] == null);
	};
	return { telegram: missing('telegram') };
}
