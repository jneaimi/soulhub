/**
 * Tool factory for the v2 orchestrator (ADR-009).
 *
 * Phase 2 wires real handlers behind the tool stubs:
 *   - reply           — returns text as-is
 *   - webSearch       — `dispatchWebSearch` + `formatWebSearchForChat`
 *   - vaultSearch     — `dispatchVaultChat`
 *   - generateImage   — `dispatchImg` (with quota check + count + lastImage cache)
 *   - dispatchAgent   — confirmed=false → `setPending`; confirmed=true → Phase 3
 *   - invokeSkill     — Phase 4
 *
 * Tools execute side effects and return rich result objects so the LLM
 * can chain (e.g. `webSearch → dispatchAgent`). decide-v2 walks tool
 * results to build the `V2Output` for the inbound handler.
 *
 * Tool descriptions carry the routing logic — keep them tight; the
 * model reads these to decide. Anything in the system prompt is
 * advisory; tool descriptions are load-bearing.
 */

import { tool } from 'ai';
import { z } from 'zod';

import { withToolCache } from './cache.js';
import { dispatchWebSearch, formatWebSearchForChat } from '../../web-search/index.js';
import { dispatchVaultChat } from '../../vault-chat/index.js';
import { dispatchImg, rememberLastImage } from '../../img/index.js';
import { fetchYoutube } from '../../youtube/index.js';
import { formatYoutubeForChat } from '../../youtube/format-for-chat.js';
import { runSkillInBackground } from '../../orchestrator/skill-worker.js';
import { fetchTikTok, probeCapabilities as probeTikTokCapabilities } from '../../tiktok/index.js';
import { formatTiktokForChat } from '../../tiktok/format-for-chat.js';
import { dispatchVaultSave } from '../../vault-save/index.js';
import { fetchPage } from '../../fetch-page/index.js';
import { recordToolCall, assertManifestParity } from './registry.js';
import { withLatencyTracking } from './latency-tracker.js';
import { setPending, formatProposal } from '../../orchestrator/pending-proposals.js';
import {
	listMessages,
	markMessageProcessed,
	correctClassification,
	getMessage,
	getAccount,
	fetchImapBody,
	getExtractedData,
	setExtractedData,
	recordAgentAction,
	countConfirmedMarkProcessed,
	extractTransactional,
	inputFromMessage,
	composeDrillDown,
	type FilterCategory,
	type TransactionalExtract,
} from '../../inbox/index.js';
import { applyRecommendation } from '../../inbox/apply-recommendation.js';
import {
	addContact,
	getContact,
	searchContacts,
	findContactByEmail,
	findContactByPhone,
	updateContactStage,
	setNextFollowup,
	addContactEmail,
	addContactPhone,
	addInteraction,
	listFollowups,
	findWebsiteLeads,
	syncContactToVault,
	attachNote,
	CONTACT_STAGES,
	CONTACT_NOTE_KINDS,
	type Contact,
	type ContactStage,
	type ContactNoteKind,
	type InteractionChannel,
	type InteractionDirection,
} from '../../crm/index.js';
import { getVaultEngine } from '../../vault/index.js';
import { applyShipSlice, ShipSliceRequestSchema } from '../../projects/ship-slice.js';
import { applyProposeAdr } from '../../projects/propose-adr.js';
import { applyProposeSlice } from '../../projects/propose-slice.js';
import {
	applyProposeAdrEdit,
	PROPOSAL_SECTIONS,
} from '../../projects/suggest-adr-edit.js';
import { checkProposeRate } from '../../projects/propose-rate-limit.js';
import {
	getImgCount,
	incrementImgCount,
	getYoutubeCount,
	incrementYoutubeCount,
	getTiktokCount,
	incrementTiktokCount,
	ymdInTimezone,
	insertCommitment,
} from '../../channels/whatsapp/heartbeat-state.js';
import { runSkill } from '../../skills/index.js';
import type { ChatSkillEntry } from '../../skills/index.js';
import type {
	ImgConfigSlice,
	YoutubeConfigSlice,
	TikTokConfigSlice,
	RemindersConfigSlice,
	HeartbeatConfigSlice,
} from '../types.js';

export interface ToolDeps {
	conversationKey?: string;
	senderNumber?: string;
	dispatchableAgentIds: readonly string[];
	/** Chat-invokable skills from the registry. The `invokeSkill` tool
	 *  description and `skillName` enum are built from these — empty list
	 *  means the tool registers with a permissive `z.string()` and the
	 *  description warns the model not to invoke it. */
	chatSkills: readonly ChatSkillEntry[];
	imgConfig?: ImgConfigSlice;
	/** ADR-012 — YouTube fetch config. When undefined or `enabled: false`,
	 *  `youtubeFetch` still runs Tier A (oEmbed metadata) but skips the
	 *  Gemini transcript tier and surfaces a `note: 'transcript-disabled'`
	 *  hint in the result. */
	youtubeConfig?: YoutubeConfigSlice;
	/** ADR-024 — TikTok fetch config. When undefined or `enabled: false`,
	 *  the `tiktokFetch` tool is dropped from the registry entirely (the
	 *  capability probe in src/lib/tiktok/whisper.ts also drops it when
	 *  yt-dlp/ffmpeg/whisper-cli are missing on the host). */
	tiktokConfig?: TikTokConfigSlice;
	account?: string;
	timezone?: string;
	/** ADR-025 — chat channel for this turn. `scheduleReminder` reads this
	 *  to refuse off-channel (Telegram has no heartbeat reader for
	 *  commitments). ADR-003 adds 'web'. Undefined → tool degrades to
	 *  graceful refusal. */
	channel?: 'whatsapp' | 'telegram' | 'web';
	/** ADR-025 — reminders config snapshot. Gates `scheduleReminder`. */
	remindersConfig?: RemindersConfigSlice;
	/** ADR-025 — heartbeat config snapshot. `scheduleReminder` uses this to
	 *  compose its confirmation `cadenceNote` (outside active hours / muted
	 *  / heartbeat disabled). */
	heartbeatConfig?: HeartbeatConfigSlice;
	/** ADR-009 Phase 5 — A/B branch label that decided this turn. Forwarded
	 *  to `setPending` so the proposal_history audit row can be grouped by
	 *  branch in analytics. Undefined when v2 isn't running an A/B (e.g.
	 *  `ORCHESTRATOR_V2_MODEL` legacy override). */
	modelBranch?: string;
	/** ADR-030 — slow-skill dispatch hook. When set, slow tools (per the
	 *  manifest's `latencyClass`) short-circuit their execute() to a
	 *  background worker that edits the presence bubble when complete.
	 *  When undefined, slow tools fall back to inline execution — useful
	 *  for UI test harnesses, REPL invocations, and the Telegram path
	 *  until v2 wires it. WhatsApp inbound handler is the primary
	 *  populator. */
	slowDispatch?: SlowDispatchDeps;
}

/** ADR-030 — runtime deps the slow-tool background worker needs to deliver
 *  a result back to the chat. v2 supports both channels via a
 *  `SkillDeliveryAdapter`; channel handlers build the adapter from their
 *  respective send/edit primitives. Channel handlers that can't satisfy
 *  this contract leave it undefined and slow tools degrade to inline
 *  execution (REPL, UI test routes). */
export interface SlowDispatchDeps {
	jid: string;
	channel: 'whatsapp' | 'telegram';
	/** The presence bubble's message id — slow worker edits this in place
	 *  with the final formatted result. Undefined → worker sends a fresh
	 *  message instead. */
	progressMessageId?: string;
	/** Channel-agnostic transport. WhatsApp + Telegram each build this
	 *  from their presence adapter (send + edit). */
	deliver?: import('../../orchestrator/skill-worker.js').SkillDeliveryAdapter;
}

/** Tagged-union return type for all tool `execute()` bodies. decide-v2's
 *  result walker discriminates on `kind` to assemble the `V2Output`.
 *
 *  `reply` vs `verbatim`: both carry pre-formatted text, but `reply` is a
 *  fallback used only when the LLM's `finalText` is junk-short — the LLM
 *  is free to creatively reformat the result during composition. Use
 *  `verbatim` when the tool's structured output IS the answer and any
 *  LLM rewrite removes information (e.g. list-style outputs where row
 *  ids must survive intact). `verbatim` wins over `usefulFinal` in
 *  buildV2Output, bypassing LLM narration entirely. */
export type ToolResult =
	| { kind: 'reply'; text: string }
	| { kind: 'verbatim'; text: string }
	| { kind: 'web-search'; text: string; query: string }
	| { kind: 'web-search-error'; error: string; query: string }
	| { kind: 'vault-search'; text: string; query: string }
	| { kind: 'vault-search-error'; error: string; query: string }
	| { kind: 'image'; attachPath: string; caption?: string; prompt: string }
	| { kind: 'image-error'; error: string; prompt: string }
	| { kind: 'proposal'; text: string; agentId: string; task: string; label: string }
	| { kind: 'dispatch'; agentId: string; task: string }
	| { kind: 'dispatch-error'; error: string; agentId: string; task: string }
	| { kind: 'invoke-skill'; skillName: string; output: string; durationMs: number }
	| { kind: 'invoke-skill-error'; skillName: string; error: string; durationMs: number }
	| {
			kind: 'youtube';
			url: string;
			videoId: string;
			title: string;
			channel: string;
			thumbnailUrl: string;
			durationSec?: number;
			description?: string;
			summary?: string;
			transcript?: string;
			transcriptSource: 'gemini' | 'none';
			costUsd?: number;
			note?:
				| 'transcript-quota-exceeded'
				| 'transcript-disabled'
				| 'gemini-failed'
				| 'gemini-not-configured';
	  }
	| { kind: 'youtube-error'; url: string; error: string; tier: 'oembed' | 'gemini' | 'url' }
	| {
			kind: 'tiktok';
			url: string;
			videoId: string;
			author: string;
			authorHandle: string;
			caption: string;
			title?: string;
			durationSec: number;
			postedAt?: string;
			views?: number;
			likes?: number;
			comments?: number;
			reposts?: number;
			isPhotoPost: boolean;
			transcript?: string;
			transcriptLang?: string;
			transcriptSource: 'whisper-cpp' | 'gemini' | 'none';
			summary?: string;
			costUsd?: number;
			note?:
				| 'transcript-disabled'
				| 'summary-quota-exceeded'
				| 'whisper-failed'
				| 'whisper-not-installed'
				| 'gemini-failed'
				| 'gemini-not-configured'
				| 'duration-cap-exceeded'
				| 'photo-post-no-audio'
				| 'tiktok-rate-limited'
				| 'cache-hit';
	  }
	| { kind: 'tiktok-error'; url: string; error: string; tier: 'url' | 'metadata' | 'download' | 'whisper' | 'gemini' }
	| { kind: 'vault-save'; path: string; openUrl: string; title: string }
	| { kind: 'vault-save-error'; error: string; title: string }
	| {
			kind: 'reminder-scheduled';
			id: number;
			text: string;
			/** ISO datetime the row will fire at (post-deferral if outside
			 *  active hours / muted). */
			fireAt: string;
			/** Original `dueAt` the model emitted, if different from `fireAt`. */
			requestedAt: string;
			/** Optional human-readable note explaining why `fireAt !==
			 *  requestedAt` or warning that heartbeat is currently off. */
			cadenceNote?: string;
	  }
	| {
			kind: 'reminder-error';
			error:
				| 'reminders-not-supported-on-this-channel'
				| 'reminders-disabled'
				| 'no-target-configured'
				| 'invalid-due-at'
				| 'insert-failed';
			detail?: string;
	  }
	/** ADR-030 — slow tool was redirected to background dispatch.
	 *  The orchestrator should NOT compose a final reply this turn; the
	 *  background worker will edit the progress bubble + send follow-ups
	 *  when the tool completes. `ack` is the in-place edit text the
	 *  channel handler applies to the presence bubble. */
	| {
			kind: 'slow-dispatched';
			toolName: string;
			ack: string;
	  }
	/** project-phases ADR-003 — atomic ship-slice success. */
	| {
			kind: 'project-ship-slice';
			project: string;
			adrPath: string;
			sliceId: string;
			status: string;
			date: string;
			commit?: string;
			applied: boolean; // false when dry-run
			statusLineAdded: boolean;
			shipLogEntryAdded: boolean;
	  }
	| {
			kind: 'project-ship-slice-error';
			project: string;
			adr: string;
			sliceId: string;
			error: string;
			rollbackAttempted?: boolean;
			rollbackOk?: boolean;
	  }
	/** project-phases ADR-005 S1 — proposeAdr success. */
	| {
			kind: 'propose-adr';
			project: string;
			path: string;
			ordinal: string;
			adrSlug: string;
			title: string;
			falsifierDate: string;
			retriedAfterCollision?: boolean;
	  }
	| {
			kind: 'propose-adr-error';
			project: string;
			workingTitle?: string;
			error: string;
			statusHint?: number;
	  }
	/** project-phases ADR-005 S2 — proposeSlice success. */
	| {
			kind: 'propose-slice';
			project: string;
			adrPath: string;
			sliceId: string;
			newRow: string;
			alreadyPresent?: boolean;
	  }
	| {
			kind: 'propose-slice-error';
			project: string;
			adr: string;
			error: string;
			statusHint?: number;
	  }
	/** project-phases ADR-005 S3 — suggestAdrEdit success. */
	| {
			kind: 'suggest-adr-edit';
			project: string;
			path: string;
			filename: string;
			targetAdr: string;
			section: string;
	  }
	| {
			kind: 'suggest-adr-edit-error';
			project: string;
			adr: string;
			error: string;
			statusHint?: number;
	  };

/** Build the tool dictionary for an Agent. Returns a stable object so the
 *  AI SDK can produce its tool schema.
 *
 *  ADR-015 — checks manifest parity once per process. Warns (doesn't
 *  throw) when the live tool keys diverge from the static manifest, so
 *  the dev sees the drift in PM2 logs without breaking dispatch. */
export function buildOrchestratorTools(deps: ToolDeps) {
	const tools = buildOrchestratorToolsImpl(deps);
	assertManifestParity(Object.keys(tools));
	// ADR-030 v2 — wrap each tool's execute() so the rolling per-tool
	// latency buffer powers the `auto` suggestion on /orchestration/tools.
	return withLatencyTracking(tools);
}

function buildOrchestratorToolsImpl(deps: ToolDeps) {
	const agentIdEnum =
		deps.dispatchableAgentIds.length > 0
			? z.enum(deps.dispatchableAgentIds as [string, ...string[]])
			: z.string().describe('(no agents enabled — set chat_dispatchable on at least one)');
	const skillNames = deps.chatSkills.map((s) => s.name);
	const skillNameEnum =
		skillNames.length > 0
			? z.enum(skillNames as [string, ...string[]])
			: z.string().describe('(no skills enabled — none of these will work)');
	const skillToolDescription = buildInvokeSkillDescription(deps.chatSkills);

	// ADR-024 — TikTok capability gate. Drop the tool entirely (don't even
	// register it) when the host can't transcribe TikTok clips OR when the
	// settings flag is off. The LLM never sees a tool it can't successfully
	// call — no hallucination surface.
	const ttCaps = probeTikTokCapabilities();
	const tiktokAvailable =
		ttCaps.tierAReady && (deps.tiktokConfig?.enabled ?? true);

	return {
		reply: tool({
			description:
				'Reply to the user with a chat message. Use for greetings, conversation, quick known facts, follow-up summaries, or asking a clarification. NOT for unknown facts (use webSearch) or vault lookups (use vaultSearch).',
			inputSchema: z.object({
				text: z.string().min(1).max(2000).describe('The message text shown to the user'),
			}),
			execute: async ({ text }): Promise<ToolResult> => {
				logToolCall('reply', { textPreview: text.slice(0, 60) });
				return { kind: 'reply', text };
			},
		}),

		webSearch: tool({
			description:
				"Quick Gemini-grounded Google Search for current real-world facts (weather, news, today's score, single lookups). Returns chat-formatted answer with one source URL. When the user names a specific source (e.g. \"Khaleej Times\", \"The National\", \"Reuters\"), shape the query as `site:<domain> <topic>` — e.g. `site:khaleejtimes.com today's UAE headlines` — so grounding pulls from that source instead of a broad mix.",
			inputSchema: z.object({
				query: z.string().min(2).max(400).describe('The search query — natural language is fine'),
			}),
			execute: withToolCache('webSearch', async ({ query }): Promise<ToolResult> => {
				logToolCall('webSearch', { query });
				try {
					const r = await dispatchWebSearch(query);
					const text = formatWebSearchForChat(r);
					return { kind: 'web-search', text, query };
				} catch (err) {
					const error = (err as Error).message ?? String(err);
					return { kind: 'web-search-error', error, query };
				}
			}),
		}),

		vaultSearch: tool({
			description:
				'Recon the accumulated knowledge base (Soul Hub vault, ~/vault/ — prior research, decisions, CRM, learnings). CALL THIS FIRST (ADR-053 vault-recon) for any knowledge / entity / continuity question — a company, person, project, or topic, and "do we have research on X", "what did we save / decide about Y", "have we looked at Z", "find my notes on W" — so you build on prior work before hitting the web. A vault hit is CONTEXT to extend ("we already have a note on X from <date>"), NOT the authoritative answer for current-state facts; a tangential match is not relevant. Do NOT use for current events, news, headlines, weather, live scores, or any question about the outside world — those go to webSearch (a topic-adjacent note does not satisfy a current-events question). Do NOT use for inbox/email queries of ANY kind — "what\'s in my inbox", "what\'s queued", "any new emails", "new mail", "what came in today", "any bank alerts", "msg <N>", "what about msg N", "tell me about N", or any bare 4-6 digit id after a digest/anomaly push. ALL email queries route to `inbox-list-queued` (lists) or `inbox-drill-down` (single id), NEVER here. The vault has an unrelated `inbox/` folder for quick note captures — ignore that name collision; the word "inbox" without an explicit "note"/"vault" qualifier always means EMAIL. Vault returning a topic-adjacent note does not satisfy a news / current-events / inbox question.',
			inputSchema: z.object({
				query: z.string().min(2).max(400),
			}),
			execute: withToolCache(
				'vaultSearch',
				async ({ query }): Promise<ToolResult> => {
					logToolCall('vaultSearch', { query });
					try {
						const r = await dispatchVaultChat(query, deps.conversationKey);
						return { kind: 'vault-search', text: r.text || '(no reply)', query };
					} catch (err) {
						const error = (err as Error).message ?? String(err);
						return { kind: 'vault-search-error', error, query };
					}
				},
				{ scope: () => deps.conversationKey ?? '' },
			),
		}),

		generateImage: tool({
			description:
				'Generate a single text-to-image via Gemini Nano Banana. Use ONLY for "make me a picture of X" with NO text overlay, NO video, NO voiceover, NO carousel, NO Arabic text. If the user wants any of those, use dispatchAgent with agentId="media-generator".',
			inputSchema: z.object({
				prompt: z
					.string()
					.min(2)
					.max(1500)
					.describe('Clean visual description, no leading verb (e.g. "a person fishing in the UAE")'),
			}),
			execute: async ({ prompt }): Promise<ToolResult> => {
				logToolCall('generateImage', { promptPreview: prompt.slice(0, 60) });
				if (!deps.imgConfig) {
					return { kind: 'image-error', error: 'Image generation is not configured.', prompt };
				}
				if (!deps.imgConfig.enabled) {
					return {
						kind: 'image-error',
						error:
							'Image generation is disabled in settings. Toggle it on under WhatsApp → Image generation.',
						prompt,
					};
				}
				if (!deps.account) {
					return { kind: 'image-error', error: 'Image generation needs an account name.', prompt };
				}
				if (!deps.senderNumber || !deps.conversationKey) {
					return { kind: 'image-error', error: 'Image generation needs a sender context.', prompt };
				}
				const tz = deps.timezone ?? 'Asia/Dubai';
				const today = ymdInTimezone(tz);
				const count = getImgCount(deps.senderNumber, today);
				if (count >= deps.imgConfig.maxPerDay) {
					return {
						kind: 'image-error',
						error: `You've hit today's image budget (${deps.imgConfig.maxPerDay}/day) — resets midnight ${tz}.`,
						prompt,
					};
				}
				const result = await dispatchImg({
					prompt,
					conversationKey: deps.conversationKey,
					account: deps.account,
					systemPromptPath: deps.imgConfig.systemPromptPath,
					model: deps.imgConfig.model,
				});
				if (result.error) {
					return { kind: 'image-error', error: result.error, prompt };
				}
				incrementImgCount(deps.senderNumber, today);
				rememberLastImage(deps.conversationKey, {
					buffer: result.buffer,
					mimetype: result.mimetype,
					prompt: result.prompt,
				});
				return {
					kind: 'image',
					attachPath: result.path,
					caption: result.caption,
					prompt,
				};
			},
		}),

		dispatchAgent: tool({
			description:
				'Dispatch a heavy specialist agent (runs minutes). OMIT confirmed (or set false) to PROPOSE the dispatch — the user replies "yes" to run it. Set confirmed=true ONLY when the user explicitly confirmed a prior proposal OR used an unambiguous command verb ("research X for me", "draft Y about Z", "review this code", "audit Q").',
			inputSchema: z.object({
				agentId: agentIdEnum,
				// `min(5)` (was `min(20)`): too-tight rejected terse model
				// emissions like "weather image" and the user got a 1-char
				// reply instead of a proposal.
				task: z
					.string()
					.min(5)
					.max(800)
					.describe(
						'Self-contained instruction for the agent. Include all context the agent will need from the conversation.',
					),
				// `confirmed` is .optional() (NOT .default(false)): Zod 4
				// `toJSONSchema` adds defaulted fields to `required`, which
				// pushes the model to emit them — and GLM-4.6 then emits
				// `"false"` (string) which fails `z.boolean()`. Optional +
				// preprocess gives us: model can omit the field, and any
				// string-shaped boolean from the model still parses cleanly.
				confirmed: z
					.preprocess(
						(v) => {
							if (typeof v === 'string') {
								const lower = v.toLowerCase().trim();
								if (lower === 'true' || lower === 'yes' || lower === '1') return true;
								if (
									lower === 'false' ||
									lower === 'no' ||
									lower === '0' ||
									lower === ''
								)
									return false;
							}
							return v;
						},
						z.boolean().optional(),
					)
					.describe('Omit (default false) to propose. true = run now.'),
				proposalLabel: z
					.string()
					.max(80)
					.optional()
					.describe('Required when confirmed is false/omitted. One-line user-facing description of what the agent will do.'),
			}),
			execute: async (args): Promise<ToolResult> => {
				const confirmed = args.confirmed ?? false;
				logToolCall('dispatchAgent', {
					agentId: args.agentId,
					confirmed,
					taskPreview: args.task.slice(0, 60),
				});
				if (confirmed) {
					// Phase 3 — confirmed=true signals "run now". The actual
					// dispatch (capacity check + worker ack + `runInBackground`)
					// happens in the inbound handler's v2Output short-circuit
					// because it needs `envelope.chatJid`, `worker`, and `ctx`
					// that aren't available inside the orchestrator scope.
					return {
						kind: 'dispatch',
						agentId: args.agentId,
						task: args.task,
					};
				}
				// confirmed=false → write to pending_proposals + return formatted text.
				if (!deps.conversationKey) {
					return {
						kind: 'dispatch-error',
						error: 'conversationKey missing — cannot create proposal',
						agentId: args.agentId,
						task: args.task,
					};
				}
				const label = args.proposalLabel ?? `Run ${args.agentId}`;
				const proposal = setPending({
					conversationKey: deps.conversationKey,
					agentId: args.agentId,
					task: args.task,
					label,
					origin: 'natural',
					modelBranch: deps.modelBranch,
				});
				return {
					kind: 'proposal',
					text: formatProposal(proposal),
					agentId: args.agentId,
					task: args.task,
					label,
				};
			},
		}),

		youtubeFetch: tool({
			description:
				'Fetch a YouTube video — title, channel, duration, thumbnail, and (when needed) transcript or summary. ' +
				'Use whenever the user shares a YouTube URL (youtube.com, youtu.be, share.google/...) — ' +
				'whether they want to save it, review it, summarize it, quote it, or ask a question about its content. ' +
				'Modes: "metadata" = title/channel/thumbnail only (instant, free, for save-shaped intents); ' +
				'"summary" = adds a 2-3 paragraph summary via Gemini (~10-25s, costs cents — for review/summarize/quote intents); ' +
				'"transcript" = adds the full transcript text (~25s, costs cents — for "what does he say about X" intents); ' +
				'"full" = metadata + summary + transcript in one call. ' +
				'After the tool returns, compose your reply from the structured fields. ' +
				'If the result has note="transcript-quota-exceeded" or note="gemini-failed", tell the user we have the title and thumbnail but couldn\'t analyze the video this turn.',
			inputSchema: z.object({
				url: z.string().min(1).describe('Full YouTube URL or share link'),
				mode: z
					.enum(['metadata', 'summary', 'transcript', 'full'])
					.describe(
						'metadata = instant + free; summary = +2-3 paragraph summary; transcript = +full transcript; full = both. Default to "summary" for review/summarize phrasing, "metadata" for save phrasing, "transcript" for quote/extract phrasing.',
					),
			}),
			execute: async ({ url, mode }): Promise<ToolResult> => {
				logToolCall('youtubeFetch', { url, mode });

				// ADR-030 — slow-dispatch path. When the caller wired
				// `deps.slowDispatch.deliver` AND the requested mode hits
				// Gemini (everything except `metadata`), fire the actual
				// fetch in a background worker that edits the channel's
				// presence bubble when it completes. Channel-agnostic since
				// v2 — both WhatsApp and Telegram wire `deliver`. The
				// inline path stays for metadata-only saves and callers
				// that didn't wire slow-dispatch (REPL, UI test routes).
				const isSlowCall = mode !== 'metadata';
				if (isSlowCall && deps.slowDispatch?.deliver) {
					const { jid, progressMessageId, deliver } = deps.slowDispatch;
					const conversationKey = deps.conversationKey;
					runSkillInBackground({
						jid,
						toolName: 'youtubeFetch',
						deliver,
						progressMessageId,
						conversationKey,
						executeFn: () => runYoutubeFetchInline({ url, mode, deps }),
						formatFn: formatYoutubeForChat,
					});
					return {
						kind: 'slow-dispatched',
						toolName: 'youtubeFetch',
						ack: `🟡 Fetching YouTube video — I'll send the summary here in ~30s. (If you wanted me to save it, ask again once the summary lands.)`,
					};
				}

				return runYoutubeFetchInline({ url, mode, deps });
			},
		}),

		...(tiktokAvailable
			? {
					tiktokFetch: tool({
						description:
							'Fetch a TikTok video — author, caption, engagement, duration, and (when needed) speech transcript or summary. ' +
							'Use whenever the user shares a TikTok URL (tiktok.com, vm.tiktok.com, vt.tiktok.com, tiktok.com/t/...) — ' +
							'whether they want to save it, review it, summarize it, quote it, translate it, or ask a question about its content. ' +
							'Modes: "metadata" = author/caption/engagement only (instant, free, for save-shaped intents); ' +
							'"transcript" = adds the full speech transcript via local whisper.cpp (~7-15s, free — for "what does this say" / quote / search intents); ' +
							'"summary" = adds a 2-3 paragraph summary via Gemini (~12-25s, costs cents — for review/summarize intents); ' +
							'"full" = metadata + transcript + summary in one combined call. ' +
							'CALL ONCE per video — pick the most-informative mode you need on the first call ("full" if uncertain). ' +
							'Do NOT re-call this tool with a different mode for the same URL on failure — escalating modes just punches TikTok\'s anti-bot harder. ' +
							'Successive calls within ~10 minutes are served from cache (note="cache-hit") so they\'re cheap, but still avoid repeating yourself. ' +
							'After the tool returns, compose your reply from the structured fields. ' +
							'If the result has note="summary-quota-exceeded" or note="gemini-failed", tell the user we have the transcript/metadata but couldn\'t summarize this turn. ' +
							'If note="tiktok-rate-limited", TikTok\'s anti-bot is currently blocking us. The result MAY have only the author handle (when caption is empty and durationSec is 0) — in that case say "TikTok is rate-limiting us right now — I can see this is from @<authorHandle> but couldn\'t pull the details. Try sharing the link again in a minute or two." If caption is populated, you have the metadata from a prior attempt — share what you have and tell the user the transcript/summary couldn\'t run this turn. Do NOT immediately re-call the tool. ' +
							'If note="photo-post-no-audio", the URL is a photo carousel with no spoken content — only the caption is meaningful. ' +
							'If note="duration-cap-exceeded", the clip is too long to transcribe; only the caption is available.',
						inputSchema: z.object({
							url: z.string().min(1).describe('Full TikTok URL or share link'),
							mode: z
								.enum(['metadata', 'transcript', 'summary', 'full'])
								.describe(
									'metadata = instant + free; transcript = +full transcript via local whisper; summary = +Gemini summary; full = both. Default to "transcript" for review/quote phrasing, "metadata" for save phrasing, "summary" only when the user asks for a summary or analysis.',
								),
						}),
						execute: async ({ url, mode }): Promise<ToolResult> => {
							logToolCall('tiktokFetch', { url, mode });

							// ADR-030 v2 — slow-dispatch path. Mirrors youtubeFetch.
							// `metadata` is instant (no whisper, no Gemini) so
							// it stays inline; `transcript` / `summary` / `full`
							// run 7-25s of compute and get dispatched in a
							// background worker that edits the presence bubble
							// when complete. Channel-agnostic — both channels
							// wire `deliver`.
							const isSlowCall = mode !== 'metadata';
							if (isSlowCall && deps.slowDispatch?.deliver) {
								const { jid, progressMessageId, deliver } = deps.slowDispatch;
								const conversationKey = deps.conversationKey;
								runSkillInBackground({
									jid,
									toolName: 'tiktokFetch',
									deliver,
									progressMessageId,
									conversationKey,
									executeFn: () => runTiktokFetchInline({ url, mode, deps }),
									formatFn: formatTiktokForChat,
								});
								return {
									kind: 'slow-dispatched',
									toolName: 'tiktokFetch',
									ack: `🟡 Fetching that TikTok — I'll send the result here in ~30s. (If you wanted me to save it, ask again once the summary lands.)`,
								};
							}

							return runTiktokFetchInline({ url, mode, deps });
						},
					}),
				}
			: {}),

		fetchPage: tool({
			description:
				'Fetch the readable text of a web page (curl + Readability). ' +
				'STRICT ROUTING: ONLY fetch URLs the USER pasted in their CURRENT message. ' +
				'NEVER fetch URLs that appeared in YOUR own prior assistant turns — those are references the user can open themselves; if the user asks about them, the question is about the underlying CONTENT, not the page, so use `vaultSearch` (for vault-note `/vault?note=...` links) or restate from history (for other prior links). ' +
				'NEVER fetch this instance\'s own vault-note UI links (the `/vault?note=...` routes) at all — they are not fetchable web pages; the content is in the vault, so use `vaultSearch` with relevant topic words instead. ' +
				'Use `youtubeFetch` for YouTube URLs and `tiktokFetch` for TikTok URLs FIRST — those return richer structured data. ' +
				'Use this for any OTHER URL the user pasted: blog posts, documentation, Google Docs share links, static transcript pages, news articles, etc. ' +
				'Returns title + extracted plain text (capped at 12k chars). ' +
				'Honest failures via `failureClass`: ' +
				'`js-required` (page is JavaScript-hydrated — tell the user to paste the text), ' +
				'`auth-required` (sign-in needed), `bot-blocked` (Cloudflare/etc), ' +
				'`unsupported-mime` (PDF/image/video — not extractable today), ' +
				'`unsafe-url` (private/internal hosts blocked). ' +
				'Chains naturally into `vaultSave` for saving the extracted text and `crm-attach-note` (when shipped) for linking to a contact.',
			inputSchema: z.object({
				url: z.string().url(),
				maxChars: z.number().int().positive().max(50_000).optional(),
				timeoutMs: z.number().int().positive().max(30_000).optional(),
			}),
			execute: async ({ url, maxChars, timeoutMs }): Promise<ToolResult> => {
				logToolCall('fetchPage', { url, maxChars, timeoutMs });

				// Defensive guard: vault-note links (`soul-hub.jneaimi.com/vault?...`)
				// are UI routes for the Soul Hub web app, not fetchable web pages.
				// The model often produces these in prior replies and then tries
				// to fetch them on the next turn (anaphora misinterpretation —
				// "what about those notes" → fetch the links it just emitted).
				// Surface an ERROR-prefixed reply (mirrors the tool-provenance
				// hardening from mid-May 2026) so the model retries with vaultSearch
				// instead of relaying a confusing "private host blocked" message
				// for what's really a vault query.
				let isVaultUiLink = false;
				try {
					const u = new URL(url);
					isVaultUiLink = u.pathname === '/vault' && u.searchParams.has('note');
				} catch {
					isVaultUiLink = false;
				}
				if (isVaultUiLink) {
					return {
						kind: 'reply',
						text:
							"ERROR: fetchPage cannot read this Soul Hub instance's own vault-note UI links (the /vault?note=… routes) — those are UI routes, not fetchable pages. " +
							"Use `vaultSearch` with topic words from the user's question instead. " +
							'Do NOT report a fetch failure to the user; retry with vaultSearch now.',
					};
				}

				const result = await fetchPage(url, { maxChars, timeoutMs });

				// Failure branches: each produces an honest user-facing reply.
				// The text body stays empty so the model doesn't try to summarize nothing.
				if (result.failureClass) {
					const honestMessage = buildFetchPageFailureMessage(result);
					return { kind: 'reply', text: honestMessage };
				}

				const header = result.title
					? `# ${result.title}${result.byline ? ` — ${result.byline}` : ''}\n(${result.finalUrl})\n\n`
					: `(${result.finalUrl})\n\n`;
				return { kind: 'reply', text: `${header}${result.text}` };
			},
		}),

		vaultSave: tool({
			description:
				"Save composed content to the user's Soul Hub vault (standalone markdown store at ~/vault/) as a markdown note. " +
				"Use ONLY when the user explicitly asks to save / capture / remember / add to notes / write down / store. " +
				"NEVER call this for discussion-only requests. " +
				"For multi-step flows (e.g. user asks to save a YouTube video), call the upstream tool first (youtubeFetch with mode=summary), then synthesize a clean note body, THEN call vaultSave with the synthesized title + body. " +
				"CALL ONCE per save intent — do NOT call vaultSave twice in the same turn even with a different title or richer content. Pick the best title and the fullest body on the first call. A second call wastes tokens and produces a duplicate row. " +
				"Always writes to the inbox zone — the user curates from there. After it returns, include the openUrl in your reply so the user can open the note.",
			inputSchema: z.object({
				title: z
					.string()
					.min(2)
					.max(120)
					.describe(
						'Short specific title (≤ 12 words). Used for the filename slug and as the H1.',
					),
				content: z
					.string()
					.min(1)
					.max(50_000)
					.describe(
						'Markdown body of the note. Pre-synthesized — include any context (summary, key points, source link) the user will want when reading later. Do not include the title as an H1; the vault renderer adds it.',
					),
				type: z
					.enum(['draft', 'reference', 'learning', 'idea'])
					.describe(
						'Note type. "draft" for general captures, "reference" for material to revisit, "learning" for things learned, "idea" for sparks/concepts. Default to "draft" when unsure.',
					),
				tags: z
					.array(z.string().min(1).max(40))
					.max(8)
					.describe(
						'Up to 8 short kebab-case tags (no leading "#"). Pick from the content topic, source, and intent.',
					),
				sourceUrl: z
					.string()
					.url()
					.optional()
					.describe(
						'When the saved content was derived from a URL (YouTube, article), pass it here so the note can back-link.',
					),
			}),
			execute: async ({ title, content, type, tags, sourceUrl }): Promise<ToolResult> => {
				logToolCall('vaultSave', {
					title: title.slice(0, 60),
					type,
					tagCount: tags.length,
					hasSource: !!sourceUrl,
					contentChars: content.length,
				});
				const outcome = await dispatchVaultSave({
					title,
					content,
					type,
					tags,
					sourceUrl,
				});
				if (!outcome.ok) {
					return { kind: 'vault-save-error', error: outcome.error, title: outcome.title };
				}
				return {
					kind: 'vault-save',
					path: outcome.path,
					openUrl: outcome.openUrl,
					title: outcome.title,
				};
			},
		}),

		invokeSkill: tool({
			description: skillToolDescription,
			inputSchema: z.object({
				skillName: skillNameEnum,
				args: z
					.string()
					.max(2000)
					.describe(
						'Skill arguments — natural-language string is fine for prompt-injection skills (arabic, draft, think); JSON-shaped object as a string for script skills (when seeded). The skill validates against its own schema.',
					),
			}),
			execute: async ({ skillName, args }): Promise<ToolResult> => {
				logToolCall('invokeSkill', { skillName, argsPreview: args.slice(0, 60) });
				// Args arrive as a string. Try JSON parse first; fall back to
				// the raw string so prompt-injection skills can take free-form
				// natural language without forcing the model to JSON-encode.
				let parsedArgs: unknown = args;
				if (args.trim().startsWith('{') || args.trim().startsWith('[')) {
					try {
						parsedArgs = JSON.parse(args);
					} catch {
						// Keep as string — runSkill will hand to the runner which
						// formats appropriately for prompt-injection.
					}
				}
				const result = await runSkill(skillName, parsedArgs);
				if (result.ok) {
					return {
						kind: 'invoke-skill',
						skillName,
						output: result.output,
						durationMs: result.durationMs,
					};
				}
				return {
					kind: 'invoke-skill-error',
					skillName,
					error: result.error,
					durationMs: result.durationMs,
				};
			},
		}),

		projectShipSlice: tool({
			description:
				'Mark a project ADR slice (S<N>, CP<N>, Phase <N>, PASS <N>, Stage <N>) as shipped/accepted/parked/superseded/rejected. ' +
				'Atomically updates the ADR Status section + the project index Ship log via the ADR-046 chokepoint. Use after a commit closes a slice — pass the project slug, ADR slug (or bare ordinal like "007"), slice label, status, and commit short-SHA. ' +
				'STRICT ROUTING: only fires when the user explicitly asks to "mark/ship/close/record" a slice or ADR phase. NEVER fires for vague "what shipped" / "what\'s open" queries (those use the read API directly). NEVER fires on commit messages alone — needs the user to ask. ' +
				'Mode dry_run: true returns the preview without writing; use this to verify the slice label resolves correctly before applying. ' +
				'PROVENANCE — DO NOT INVENT ARGS: `commit` MUST be a REAL git short-SHA from a prior shell output or commit summary the user pasted; NEVER fabricate. `slice_id` MUST match the operator\'s exact label convention for that ADR — check the ADR\'s Implementation plan table if unsure. The tool returns 422 if the marker is already present (idempotent), 400 if the ADR can\'t be resolved.',
			inputSchema: z.object({
				slug: z
					.string()
					.min(1)
					.describe(
						'Project slug — the folder name under projects/. Examples: "naseej", "project-phases", "soul-hub-whatsapp".',
					),
				adr: z
					.string()
					.min(1)
					.describe(
						'ADR identifier — full slug ("adr-007-peer-brief-naseej-port"), partial slug ("adr-003"), or full vault path. Resolution falls back to a project-index wikilink lookup when the partial form doesn\'t exist on disk.',
					),
				slice_id: z
					.string()
					.regex(/^(S|CP|Phase|PASS|Pass|Stage)\s*\d+(?:\.\d+)?$/)
					.describe(
						'Slice label as it appears in the ADR. Examples: "S1", "S3", "CP4.2", "Phase 1", "Stage 2".',
					),
				status: z
					.enum(['shipped', 'accepted', 'parked', 'superseded', 'rejected'])
					.describe(
						'New slice status. Use "shipped" after a commit closes the slice. "accepted" for proposal-acceptance without code. "parked"/"superseded"/"rejected" for terminal non-shipped states.',
					),
				commit: z
					.string()
					.regex(/^[a-f0-9]{7,40}$/)
					.optional()
					.describe(
						'Git short-SHA (7-40 hex chars). Strongly recommended for "shipped" status — it\'s how operators jump from the ADR to the commit.',
					),
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe('YYYY-MM-DD. Defaults to today.'),
				notes: z
					.string()
					.min(1)
					.max(300)
					.optional()
					.describe(
						'One-line ship summary. Appears in both the ADR marker line and the ship log entry.',
					),
				dry_run: z
					.boolean()
					.optional()
					.describe(
						'When true, returns the preview without writing. Use to verify the slice label resolves correctly before applying.',
					),
			}),
			execute: async (args): Promise<ToolResult> => {
				logToolCall('projectShipSlice', {
					slug: args.slug,
					adr: args.adr.slice(0, 40),
					slice_id: args.slice_id,
					status: args.status,
					dry_run: args.dry_run ?? false,
				});
				const engine = getVaultEngine();
				if (!engine) {
					return {
						kind: 'project-ship-slice-error',
						project: args.slug,
						adr: args.adr,
						sliceId: args.slice_id,
						error: 'Vault engine not initialized',
					};
				}
				const parsed = ShipSliceRequestSchema.safeParse({
					adr: args.adr,
					slice_id: args.slice_id,
					status: args.status,
					commit: args.commit,
					date: args.date,
					notes: args.notes,
				});
				if (!parsed.success) {
					return {
						kind: 'project-ship-slice-error',
						project: args.slug,
						adr: args.adr,
						sliceId: args.slice_id,
						error: `invalid args: ${parsed.error.issues
							.map((i) => `${i.path.join('.')}: ${i.message}`)
							.join('; ')}`,
					};
				}
				const result = await applyShipSlice(engine, args.slug, parsed.data, {
					dryRun: args.dry_run ?? false,
				});
				if (!result.success) {
					return {
						kind: 'project-ship-slice-error',
						project: args.slug,
						adr: args.adr,
						sliceId: args.slice_id,
						error: result.error ?? 'unknown error',
						rollbackAttempted: result.rollback_attempted,
						rollbackOk: result.rollback_ok,
					};
				}
				return {
					kind: 'project-ship-slice',
					project: args.slug,
					adrPath: result.preview.adr_path,
					sliceId: args.slice_id,
					status: args.status,
					date: result.preview.resolved_date,
					commit: args.commit,
					applied: result.applied,
					statusLineAdded: result.preview.status_changed,
					shipLogEntryAdded: result.preview.ship_log_changed,
				};
			},
		}),

		proposeAdr: tool({
			description:
				'Draft a NEW ADR (architecture decision record) note in a project, with status `proposed`. Picks the next-available `adr-NNN-<slug>` ordinal and writes via the ADR-046 chokepoint with `actor: proposeAdr` (audit log shows this distinct from `projectShipSlice` closures). ' +
				'STRICT ROUTING: only fires when the user explicitly asks to "draft / propose / write a new ADR" for a specific project. NEVER fires for vague "we should write something about X" — needs a concrete project slug + working title. NEVER mutates an existing ADR (that\'s the operator\'s job via the AdrDrawer). ' +
				'PROVENANCE — DO NOT INVENT ARGS: pull `problem_statement` and `falsifier_conditions` from the user\'s own words in the conversation, never fabricate. If the user hasn\'t articulated a problem statement or at least one falsifier, ASK before calling. ' +
				'FALSIFIER STRING FORMAT — do NOT include the `F<N>` prefix in your `falsifier_conditions` strings. The tool automatically renders `**F1** ...`, `**F2** ...`, etc. — write only the falsifier text itself. Example bad: `"F1 — At least one X event occurs"`. Example good: `"At least one X event occurs"`. The tool will defensively strip any leading `F<N>` prefix you accidentally include, but cleaner input avoids the strip path entirely. ' +
				'The new ADR lands as `status: proposed`; the operator confirms via the existing AdrDrawer Accept button (no new acceptance UI). The tool returns 404 if `projects/<slug>/index.md` is missing, 409 on two consecutive ordinal collisions (rare race with manual hand-creation).',
			inputSchema: z.object({
				slug: z
					.string()
					.min(1)
					.regex(/^[a-z0-9][a-z0-9-]+$/)
					.describe(
						'Project slug — the kebab-case folder name under projects/. Examples: "naseej", "project-phases", "soul-hub-whatsapp".',
					),
				working_title: z
					.string()
					.min(3)
					.max(120)
					.describe(
						'Human-readable ADR title — kebab-slugified for the filename (e.g. "AI propose-ADR + propose-slice asymmetry" -> adr-NNN-ai-propose-adr-and-propose-slice.md).',
					),
				tier: z
					.enum(['Tier 1', 'Tier 2', 'Tier 3'])
					.describe(
						'ADR size class per project-phases retro convention: Tier 1 (small extension, ~1-2h), Tier 2 (medium feature, ~1 day), Tier 3 (major feature, ~1.5+ days). Pick based on the decision_sketch scope.',
					),
				problem_statement: z
					.string()
					.min(20)
					.max(2000)
					.describe(
						'One-paragraph Context section body. Pull from the user\'s own articulation of the problem — never fabricate.',
					),
				decision_sketch: z
					.array(z.string().min(5).max(500))
					.min(3)
					.max(8)
					.describe(
						'3-5 bullets sketching the decision approach. Each bullet becomes a list item in the "Decision (sketch)" section.',
					),
				falsifier_conditions: z
					.array(z.string().min(10).max(500))
					.min(1)
					.max(10)
					.describe(
						'≥1 falsifier conditions — each becomes F1/F2/... in the Falsifiers section, with a default 3-month deadline.',
					),
				parent_adrs: z
					.array(z.string().regex(/^\[\[[^\]\n]+\]\]$/))
					.max(10)
					.optional()
					.describe(
						'Optional wikilink array — auto-attached as `relates_to` in frontmatter + listed under Related. Operator can promote to `blocked_by` via the AdrDrawer after acceptance.',
					),
			}),
			execute: async (args): Promise<ToolResult> => {
				logToolCall('proposeAdr', {
					slug: args.slug,
					working_title: args.working_title.slice(0, 60),
					tier: args.tier,
				});
				// ADR-005 S4 — per-actor tool-level rate limit (5/hr).
				const rate = checkProposeRate('proposeAdr');
				if (!rate.allowed) {
					return {
						kind: 'propose-adr-error',
						project: args.slug,
						workingTitle: args.working_title,
						error: `Rate limit exceeded for proposeAdr — max ${rate.ceiling} proposals/hour. Resets at ${rate.resetAt}.`,
						statusHint: 429,
					};
				}
				const engine = getVaultEngine();
				if (!engine) {
					return {
						kind: 'propose-adr-error',
						project: args.slug,
						workingTitle: args.working_title,
						error: 'Vault engine not initialized',
					};
				}
				const result = await applyProposeAdr(engine, args);
				if (!result.success) {
					return {
						kind: 'propose-adr-error',
						project: args.slug,
						workingTitle: args.working_title,
						error: result.error,
						statusHint: result.status_hint,
					};
				}
				return {
					kind: 'propose-adr',
					project: args.slug,
					path: result.path,
					ordinal: result.ordinal,
					adrSlug: result.adr_slug,
					title: result.preview.title,
					falsifierDate: result.preview.falsifier_date,
					...(result.retried_after_collision && { retriedAfterCollision: true }),
				};
			},
		}),

		proposeSlice: tool({
			description:
				'Add a NEW slice row to an EXISTING ADR\'s `## Implementation plan` table. Writes via the ADR-046 chokepoint with `actor: proposeSlice` (distinct from `proposeAdr` and `projectShipSlice` in the audit log). ' +
				'STRICT ROUTING: only fires when the user explicitly asks to "add / propose a slice / phase / stage" to a specific ADR. NEVER fires on vague "we should plan more work on X". NEVER touches the ADR\'s Status section, Decision section, frontmatter status, or closure markers — that is `projectShipSlice`. NEVER creates a new ADR — that is `proposeAdr`. ' +
				'PROVENANCE — DO NOT INVENT ARGS: `scope` and `estimate` MUST be derived from the user\'s own articulation in the conversation, not fabricated. If the user has not described scope or estimate, ASK before calling. ' +
				'If `slice_id` is omitted the tool computes the next-available ordinal in the table\'s dominant family (defaults to `S<N>`). Pass `family` to force a specific family (e.g. `Phase` for naseej-style projects). Returns 404 if the project is missing, 400 if the ADR cannot be resolved, 422 if the ADR has no `## Implementation plan` table. Idempotent: if the slice_id is already in the table, returns `alreadyPresent: true` without writing.',
			inputSchema: z.object({
				slug: z
					.string()
					.min(1)
					.regex(/^[a-z0-9][a-z0-9-]+$/)
					.describe(
						'Project slug — the kebab-case folder name under projects/. Examples: "naseej", "project-phases".',
					),
				adr: z
					.string()
					.min(1)
					.describe(
						'ADR identifier — bare ordinal ("007"), bare slug ("adr-007-foo"), or full path ("projects/X/adr-007-foo.md"). Same resolution as projectShipSlice.',
					),
				slice_id: z
					.string()
					.regex(/^(S|CP|Phase|PASS|Pass|Stage)\s*\d+(?:\.\d+)?$/)
					.optional()
					.describe(
						'Optional explicit slice label like `S5`, `CP4.2`, `Phase 3`. If omitted, the tool picks the next-available ordinal in the table\'s dominant family.',
					),
				family: z
					.enum(['S', 'CP', 'Phase', 'PASS', 'Pass', 'Stage'])
					.optional()
					.describe(
						'Force a specific slice family when `slice_id` is omitted. Defaults to the table\'s dominant family (or `S` for empty tables).',
					),
				scope: z
					.string()
					.min(5)
					.max(800)
					.describe(
						'Scope cell — 1-3 sentences describing what the slice covers. Single-line, no newlines (markdown tables drop them).',
					),
				estimate: z
					.string()
					.min(1)
					.max(60)
					.describe('Estimate cell, e.g. "2-3 hours" or "30-45 min". Single-line.'),
			}),
			execute: async (args): Promise<ToolResult> => {
				logToolCall('proposeSlice', {
					slug: args.slug,
					adr: args.adr,
					slice_id: args.slice_id ?? '(auto)',
				});
				// ADR-005 S4 — per-actor tool-level rate limit (5/hr).
				const rate = checkProposeRate('proposeSlice');
				if (!rate.allowed) {
					return {
						kind: 'propose-slice-error',
						project: args.slug,
						adr: args.adr,
						error: `Rate limit exceeded for proposeSlice — max ${rate.ceiling} proposals/hour. Resets at ${rate.resetAt}.`,
						statusHint: 429,
					};
				}
				const engine = getVaultEngine();
				if (!engine) {
					return {
						kind: 'propose-slice-error',
						project: args.slug,
						adr: args.adr,
						error: 'Vault engine not initialized',
					};
				}
				const result = await applyProposeSlice(engine, args);
				if (!result.success) {
					return {
						kind: 'propose-slice-error',
						project: args.slug,
						adr: args.adr,
						error: result.error,
						statusHint: result.status_hint,
					};
				}
				return {
					kind: 'propose-slice',
					project: args.slug,
					adrPath: result.path,
					sliceId: result.slice_id,
					newRow: result.new_row,
					...(result.already_present && { alreadyPresent: true }),
				};
			},
		}),

		suggestAdrEdit: tool({
			description:
				'Suggest a structured edit to an EXISTING ADR\'s prose. Writes a NEW proposal note under `projects/<slug>/proposals/YYYY-MM-DD-NN-<short-slug>.md` (NEVER mutates the target ADR). Frontmatter records `target_adr`, `proposed_section`, `status: open`. Operator reviews via the project page proposals panel and decides to apply, edit, or reject. ' +
				'STRICT ROUTING: only fires when the user explicitly asks to "suggest / propose / draft an edit" to a specific ADR section. NEVER fires on vague "we could rewrite X". NEVER mutates the target ADR — that\'s the operator\'s job after review. NEVER creates a new ADR (that\'s `proposeAdr`). NEVER adds a slice row (that\'s `proposeSlice`). ' +
				'PROVENANCE — DO NOT INVENT ARGS: `proposed_text` MUST be derived from the user\'s own articulation in the conversation, not fabricated. `rationale` must explain WHY this edit is needed, not just restate the proposed text. If the user has not described both, ASK before calling. ' +
				'The proposal is just a note — the operator still has to apply it manually. Returns 404 if the project is missing, 400 if the ADR cannot be resolved.',
			inputSchema: z.object({
				slug: z
					.string()
					.min(1)
					.regex(/^[a-z0-9][a-z0-9-]+$/)
					.describe(
						'Project slug — the kebab-case folder name under projects/.',
					),
				adr: z
					.string()
					.min(1)
					.describe(
						'ADR identifier — bare ordinal ("007"), bare slug ("adr-007-foo"), or full path. Same resolution as projectShipSlice.',
					),
				section: z
					.enum(PROPOSAL_SECTIONS)
					.describe(
						'Target section in the ADR — one of Status, Context, Decision, Falsifiers, Implementation plan, Related.',
					),
				title: z
					.string()
					.min(3)
					.max(120)
					.describe(
						'Short title for the proposal — kebab-slugified into the filename (e.g. "F6 proposal-zone hygiene" -> 2026-05-17-01-f6-proposal-zone-hygiene.md).',
					),
				rationale: z
					.string()
					.min(20)
					.max(2000)
					.describe(
						'Why this edit is needed. 1-3 sentences. NOT a restatement of proposed_text — explain the gap or risk.',
					),
				proposed_text: z
					.string()
					.min(20)
					.max(8000)
					.describe(
						'The markdown chunk the operator can paste into the target section. Should be self-contained (e.g. a full bullet, paragraph, or table row).',
					),
			}),
			execute: async (args): Promise<ToolResult> => {
				logToolCall('suggestAdrEdit', {
					slug: args.slug,
					adr: args.adr,
					section: args.section,
					title: args.title.slice(0, 60),
				});
				// ADR-005 S4 — per-actor tool-level rate limit (5/hr).
				const rate = checkProposeRate('suggestAdrEdit');
				if (!rate.allowed) {
					return {
						kind: 'suggest-adr-edit-error',
						project: args.slug,
						adr: args.adr,
						error: `Rate limit exceeded for suggestAdrEdit — max ${rate.ceiling} proposals/hour. Resets at ${rate.resetAt}.`,
						statusHint: 429,
					};
				}
				const engine = getVaultEngine();
				if (!engine) {
					return {
						kind: 'suggest-adr-edit-error',
						project: args.slug,
						adr: args.adr,
						error: 'Vault engine not initialized',
					};
				}
				const result = await applyProposeAdrEdit(engine, args);
				if (!result.success) {
					return {
						kind: 'suggest-adr-edit-error',
						project: args.slug,
						adr: args.adr,
						error: result.error,
						statusHint: result.status_hint,
					};
				}
				return {
					kind: 'suggest-adr-edit',
					project: args.slug,
					path: result.path,
					filename: result.filename,
					targetAdr: result.target_adr,
					section: result.section,
				};
			},
		}),

		scheduleReminder: tool({
			description:
				'Schedule a one-time reminder for the user. ' +
				'Use ONLY when the user explicitly asks to be reminded ("remind me to X at Y", "ping me tomorrow about Z"). ' +
				'NEVER use for discussion ("do you remember when..."), vague intents ("I should probably do X someday"), or inferred follow-ups from the conversation. ' +
				'Emit `dueAt` as an ISO 8601 datetime WITH timezone offset — parse natural language ' +
				'("tomorrow 11am", "next Monday morning") relative to the user\'s timezone (Asia/Dubai unless context overrides). ' +
				'Reminders fire on the WhatsApp heartbeat (within ~30 min of the due time) and only inside the user\'s active hours. ' +
				'If the user names a time outside active hours (e.g. "remind me at 3 am"), the system defers to the start of the next active window — the tool result\'s `cadenceNote` tells you when it will actually fire so you can confirm honestly. ' +
				'Reminders are WhatsApp-only today (Telegram returns `reminders-not-supported-on-this-channel`). ' +
				'After the tool returns successfully, confirm to the user: "OK — I\'ll remind you about <text> on <date> around <time>" — include the cadenceNote when present.',
			inputSchema: z.object({
				text: z
					.string()
					.min(2)
					.max(200)
					.describe(
						'The reminder body the user will see, phrased as a third-person nudge ("Call your dad", "Check the PR feedback"). Keep it imperative and short.',
					),
				dueAt: z
					.string()
					.datetime({ offset: true })
					.describe(
						'ISO 8601 datetime WITH timezone offset, e.g. "2026-05-12T11:00:00+04:00". Parse from natural language relative to Asia/Dubai unless the user specifies a different timezone.',
					),
			}),
			execute: async ({ text, dueAt }): Promise<ToolResult> => {
				logToolCall('scheduleReminder', { text: text.slice(0, 60), dueAt });

				// Channel gate — V1 is WhatsApp-only. Telegram has no heartbeat
				// reader for commitments today.
				if (deps.channel && deps.channel !== 'whatsapp') {
					return {
						kind: 'reminder-error',
						error: 'reminders-not-supported-on-this-channel',
						detail: `channel=${deps.channel}`,
					};
				}

				// Reminders feature gate.
				if (!deps.remindersConfig?.enabled) {
					return { kind: 'reminder-error', error: 'reminders-disabled' };
				}

				// Need a target (E.164 phone) to scope the row to a conversation.
				const target = deps.senderNumber;
				if (!target) {
					return { kind: 'reminder-error', error: 'no-target-configured' };
				}

				// Parse + sanity-check dueAt. Zod already validated format; here
				// we reject past-dated reminders (model occasionally emits the
				// current year when it meant next year).
				const requestedTs = Date.parse(dueAt);
				if (Number.isNaN(requestedTs)) {
					return { kind: 'reminder-error', error: 'invalid-due-at', detail: dueAt };
				}
				if (requestedTs < Date.now()) {
					return {
						kind: 'reminder-error',
						error: 'invalid-due-at',
						detail: 'dueAt is in the past',
					};
				}

				// Compute effective fire time + cadenceNote — respect active
				// hours and muteUntil. Heartbeat-disabled gets a warning but
				// still inserts (the user can re-enable heartbeat later).
				const hb = deps.heartbeatConfig;
				let fireAtMs = requestedTs;
				const cadenceNoteParts: string[] = [];

				if (hb?.muteUntil) {
					const muteEnd = Date.parse(hb.muteUntil);
					if (!Number.isNaN(muteEnd) && muteEnd > fireAtMs) {
						fireAtMs = muteEnd;
						cadenceNoteParts.push(
							`heartbeat is muted until ${new Date(muteEnd).toISOString()} — reminder will fire just after`,
						);
					}
				}

				if (hb?.activeHours) {
					const deferred = deferToActiveWindow(fireAtMs, hb.activeHours);
					if (deferred !== fireAtMs) {
						const tz = hb.activeHours.timezone;
						const startLocal = formatInTz(deferred, tz);
						cadenceNoteParts.push(
							`requested time is outside active hours (${hb.activeHours.start}–${hb.activeHours.end} ${tz}); will fire at ${startLocal}`,
						);
						fireAtMs = deferred;
					}
				}

				if (hb && hb.enabled === false) {
					cadenceNoteParts.push(
						"heartbeat is currently OFF — this reminder is saved but won't fire until you re-enable it",
					);
				}

				let id: number;
				try {
					id = insertCommitment({
						channel: 'whatsapp',
						target,
						suggestedText: text,
						dueAfterTs: fireAtMs,
						sourceMsgId: null,
						confidence: 1.0,
						source: 'user-explicit',
					});
				} catch (err) {
					return {
						kind: 'reminder-error',
						error: 'insert-failed',
						detail: (err as Error).message,
					};
				}

				return {
					kind: 'reminder-scheduled',
					id,
					text,
					fireAt: new Date(fireAtMs).toISOString(),
					requestedAt: dueAt,
					cadenceNote: cadenceNoteParts.length > 0 ? cadenceNoteParts.join('; ') : undefined,
				};
			},
		}),

		'inbox-list-queued': tool({
			description:
				"STRICT ROUTING: any user mention of 'my inbox', 'queued', 'new emails', 'new mail', 'what came in', 'mail today', 'any bank alerts', 'show me my receipts', or similar list-style email queries routes HERE — these are EMAIL queries against the IMAP-synced messages table. NOT vaultSearch — that's for Soul Hub vault markdown notes; the vault has an unrelated `inbox/` folder for quick note captures and the name collision MUST be ignored. The word 'inbox' without an explicit 'note'/'vault' qualifier always means EMAIL. " +
				"List the user's queued inbox messages (post-Layer-2 filter, agent-relevant only). " +
				"Use when the user asks 'what's in my inbox', 'any new emails', 'show me bank alerts', 'what came in today'. " +
				"Filter by category for targeted queries: personal (human mail), transactional (bank/orders/receipts), notification (service alerts), unclassified (filter wasn't confident). " +
				"Returns newest first. " +
				"OUTPUT FORMAT: when rendering rows to the user, you MUST preserve the `(msg N)` annotation next to each row — those ids are how the user drills down with phrases like 'tell me about msg N' or 'what about N'. Dropping the ids breaks the follow-up loop. If you summarize or group rows by category, still include `(msg N)` on every row.",
			inputSchema: z.object({
				category: z
					.enum(['personal', 'transactional', 'notification', 'unclassified'])
					.optional()
					.describe('Optional category filter. Omit to see everything queued.'),
				since: z
					.string()
					.optional()
					.describe('Lower bound for date_received. Accepts ISO datetime ("2026-05-11T00:00:00Z") or the literal strings "today" / "yesterday" / "week".'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.describe('Max rows to return (default 20).'),
				accountId: z
					.string()
					.optional()
					.describe('Restrict to one inbox account (rare — usually omit).'),
			}),
			execute: withToolCache(
				'inbox-list-queued',
				async ({ category, since, limit, accountId }): Promise<ToolResult> => {
					logToolCall('inbox-list-queued', { category, since, limit, accountId });
					const sinceMs = parseSinceArg(since);
					const result = listMessages({
						status: 'queued',
						category,
						since: sinceMs,
						limit: limit,
						accountId,
					});
					if (result.messages.length === 0) {
						return { kind: 'reply', text: 'No queued messages match.' };
					}
					const lines = result.messages.map((m, i) => {
						const sender = m.fromName || m.fromAddress;
						const cat = m.category ?? '?';
						const when = formatRelativeDate(m.dateReceived);
						return `${i + 1}. [${cat}] ${sender} — ${m.subject}  · ${when}  (msg ${m.id})`;
					});
					const head =
						`📥 *${result.total} queued message${result.total === 1 ? '' : 's'}*` +
						(category ? ` in *${category}*` : '') +
						` — showing newest ${result.messages.length}:`;
					const footer = '\n\n(reply with `msg N` to drill down)';
					return { kind: 'verbatim', text: `${head}\n\n${lines.join('\n')}${footer}` };
				},
				{
					// 60s — orchestrator turns run 30-60s and the user often refires
					// the same query right after. 20s was too short: empirical
					// measurement 2026-05-12 showed two `what's queued in my inbox?`
					// turns landed 67s apart, missing each other's cache. New mail
					// arrives every few minutes in typical use, so 60s of staleness
					// is well below the freshness floor.
					ttlMs: 60_000,
					// GLM-4.6 picks tool args non-deterministically — sometimes it
					// passes `{ limit: 20 }`, sometimes `{}`. Fill the schema
					// default before hashing so both shapes share a cache slot.
					normalizeArgs: ({ category, since, limit, accountId }) => ({
						category,
						since,
						limit: limit ?? 20,
						accountId,
					}),
				},
			),
		}),

		'inbox-mark-processed': tool({
			description:
				"Mark an inbox message as processed (agent has handled it). The message transitions queued → processed; it stays cached for 365 days as audit trail but stops appearing in queued listings. " +
				"Use after summarizing, routing-to-vault, replying, or otherwise handling a message. " +
				"CONFIRMATION GATE (ADR-L3 §D7 Guardrail 1): until the operator has confirmed 50 successful mark-processed calls (audit trail in `agent_actions`), OMIT `confirmed` (or set false) to PROPOSE the action — the user replies 'yes' to confirm. After 50 confirmed calls the gate lifts and the tool executes directly. The operator can also force the gate back on via `INBOX_MARK_PROCESSED_CONFIRM=always`. Set `confirmed=true` ONLY when the user explicitly confirmed a prior proposal in this turn's history OR used an unambiguous command verb ('mark N as done', 'archive N', 'process N'). " +
				"PROVENANCE: `messageId` MUST be a REAL id returned by a prior `inbox-list-queued`, `inbox-read-body`, or `inbox-correct-classification` call in the SAME conversation. NEVER invent ids. If you don't have one from a prior tool result, call `inbox-list-queued` first to discover real ids. The tool returns an ERROR when the id doesn't exist — that error means you hallucinated; do NOT relay a fake 'success' to the user.",
			inputSchema: z.object({
				messageId: z.number().int().positive(),
				// Same Zod 4 + GLM string-boolean preprocess shape as dispatchAgent.
				confirmed: z
					.preprocess(
						(v) => {
							if (typeof v === 'string') {
								const lower = v.toLowerCase().trim();
								if (lower === 'true' || lower === 'yes' || lower === '1') return true;
								if (
									lower === 'false' ||
									lower === 'no' ||
									lower === '0' ||
									lower === ''
								)
									return false;
							}
							return v;
						},
						z.boolean().optional(),
					)
					.describe('Omit (default false) until the trust gate clears. true = mark now.'),
			}),
			execute: async ({ messageId, confirmed }): Promise<ToolResult> => {
				const isConfirmed = confirmed ?? false;
				logToolCall('inbox-mark-processed', { messageId, confirmed: isConfirmed });

				const forceConfirm =
					(process.env.INBOX_MARK_PROCESSED_CONFIRM ?? '').trim().toLowerCase() === 'always';
				const trainedCount = countConfirmedMarkProcessed();
				const requireProposal = forceConfirm || trainedCount < 50;

				// Verify the id is real BEFORE asking for confirmation — no point
				// proposing an action on a hallucinated id. Mirrors the existing
				// not-exist branch's hallucination message.
				const msg = getMessage(messageId);
				if (!msg) {
					return {
						kind: 'reply',
						text:
							`ERROR: messageId ${messageId} does not exist in the inbox — likely a hallucinated id. ` +
							`Call inbox-list-queued first and use a real id from the result. ` +
							`Do NOT report success to the user; tell them the id was wrong and ask which message they meant.`,
					};
				}

				if (requireProposal && !isConfirmed) {
					if (!deps.conversationKey) {
						// REPL / test caller — no conversation to attach a proposal to.
						// Fall through to direct execute; tests don't need the gate.
					} else {
						const subjectPreview = (msg.subject ?? '').slice(0, 40).trim();
						const label = subjectPreview
							? `Mark message ${messageId} ("${subjectPreview}") as processed`
							: `Mark message ${messageId} as processed`;
						const proposal = setPending({
							conversationKey: deps.conversationKey,
							agentId: 'inbox-mark-processed',
							task: String(messageId),
							label,
							origin: 'natural',
							modelBranch: deps.modelBranch,
						});
						return {
							kind: 'proposal',
							text: formatProposal(proposal),
							agentId: 'inbox-mark-processed',
							task: String(messageId),
							label,
						};
					}
				}

				const ok = markMessageProcessed(messageId);
				recordAgentAction({
					tool: 'inbox-mark-processed',
					messageId,
					actor: 'orchestrator',
					args: { messageId, confirmed: isConfirmed },
					result: { ok, source: isConfirmed ? 'confirmed-direct' : 'auto-trusted' },
					conversationKey: deps.conversationKey ?? null,
				});

				if (ok) {
					return { kind: 'reply', text: `Message ${messageId} marked processed.` };
				}
				return {
					kind: 'reply',
					text:
						`Message ${messageId} exists but is in state '${msg.processStatus}' (not 'queued'), so no change was made. ` +
						`This is usually fine — it just means the message was already handled, skipped, or never queued.`,
				};
			},
		}),

		'inbox-apply-recommendation': tool({
			description:
				"Apply the keeper's recommendation for a stuck-transactional inbox message — operator's accept/advise loop. " +
				"Use when the operator replies 'accept #N' / 'yes route N' / 'archive N' / 'advise: kind=X, zone=Y, tag=Z' after the keeper surfaced an inboxDecisions item. " +
				"Two action modes: 'route' (default) — patches extract.kind, routes to vault, marks processed. 'archive' — marks processed without saving (for junk/bounces). " +
				"Override fields (kind/zone/tags) let the operator correct the recommendation in-line — leave undefined to accept the system's suggested values. " +
				"PROVENANCE: `messageId` MUST be a real id from a prior keeper escalation, inboxDecisions report, or `inbox-list-queued` result. NEVER fabricate ids. Returns ERROR for non-existent ids — do NOT report fake success.",
			inputSchema: z.object({
				messageId: z.number().int().positive(),
				action: z.enum(['route', 'archive']).optional().describe("Default 'route'. Use 'archive' for junk/bounces that shouldn't land in the vault."),
				kind: z.string().optional().describe("Override the recommendation's kind (e.g., 'statement', 'payment', 'alert'). Empty = accept the system's recommendation."),
				zone: z.string().optional().describe("Override target zone (e.g., 'finance', 'security', 'inbox'). Empty = pickZone() decides from kind."),
				tags: z.array(z.string()).optional().describe("Additional tags to merge into composeNote's defaults. Operator can pin 'kyc', 'high-priority', etc."),
				reason: z.string().max(200).optional().describe("Audit note — what the operator said ('accepted recommendation' / 'advised: was=unknown, now=statement')."),
			}),
			execute: async ({ messageId, action, kind, zone, tags, reason }): Promise<ToolResult> => {
				logToolCall('inbox-apply-recommendation', { messageId, action: action ?? 'route', hasOverrides: !!(kind || zone || tags) });
				const result = await applyRecommendation({ messageId, action, kind, zone, tags, reason });
				if (!result.ok) {
					const msg = getMessage(messageId);
					if (!msg) {
						return {
							kind: 'reply',
							text:
								`ERROR: messageId ${messageId} does not exist in the inbox — likely a hallucinated id. ` +
								`Call inbox-list-queued first and use a real id. Do NOT report success.`,
						};
					}
					return {
						kind: 'reply',
						text: `ERROR: ${result.error ?? 'apply-recommendation failed'} for message ${messageId}.`,
					};
				}
				if (result.action === 'archive') {
					return { kind: 'reply', text: `Message ${messageId} archived (marked processed, no vault note).` };
				}
				if (result.vaultPath) {
					return {
						kind: 'reply',
						text: `Routed message ${messageId} → ${result.vaultPath}${result.openUrl ? ` (${result.openUrl})` : ''}`,
					};
				}
				return { kind: 'reply', text: `Message ${messageId} handled (${result.action}).` };
			},
		}),

		'inbox-correct-classification': tool({
			description:
				"Correct the Layer 2 classification of a message and update the cache so future similar messages get the new category. " +
				"Use when the user pushes back (\"that's not promotional, it's a receipt\") or when the agent notices a clear miscategorization. " +
				"Scope can be 'this' (this message only) or 'pattern' (this message + all matching siblings via the cache signature).",
			inputSchema: z.object({
				messageId: z.number().int().positive(),
				category: z.enum([
					'personal',
					'transactional',
					'notification',
					'promotional',
					'bulk',
					'unclassified',
				]),
				scope: z.enum(['this', 'pattern']).optional(),
				reason: z.string().max(200).optional(),
			}),
			execute: async ({ messageId, category, scope, reason }): Promise<ToolResult> => {
				logToolCall('inbox-correct-classification', { messageId, category, scope });
				const result = correctClassification(messageId, {
					category: category as FilterCategory,
					scope: scope ?? 'pattern',
					reason,
				});
				if (!result.ok) {
					return {
						kind: 'reply',
						text: `Could not update message ${messageId}: ${result.reason ?? 'unknown'}.`,
					};
				}
				const sib = result.siblingsUpdated;
				const tail =
					(scope ?? 'pattern') === 'pattern' && sib > 0
						? ` Re-classified ${sib} matching sibling${sib === 1 ? '' : 's'}.`
						: '';
				return {
					kind: 'reply',
					text: `Updated message ${messageId} to ${category}.${tail}`,
				};
			},
		}),

		'inbox-read-body': tool({
			description:
				"Fetch the full body text of a queued inbox message. " +
				"Use ONLY after inbox-list-queued returned a row whose preview is insufficient to answer the user's question. " +
				"Bodies are fetched live from IMAP each call — not cached server-side. " +
				"Avoid for routine 'what's in my inbox' queries; preview is usually enough. " +
				"Required for 'what did X say', 'what was the amount', 'extract the link from row N'.",
			inputSchema: z.object({
				messageId: z.number().int().positive(),
			}),
			execute: async ({ messageId }): Promise<ToolResult> => {
				logToolCall('inbox-read-body', { messageId });
				const msg = getMessage(messageId);
				if (!msg) {
					return { kind: 'reply', text: `Message ${messageId} not found.` };
				}
				const account = getAccount(msg.accountId);
				if (!account) {
					return { kind: 'reply', text: `Account for message ${messageId} not found.` };
				}
				try {
					const body = await fetchImapBody(account, msg);
					// Bodies can run 10KB+ but the LLM only needs the first ~8KB to
					// answer most "what does it say" questions. A future v2 may add
					// offset/length when this proves limiting.
					const text = (body.text || '').slice(0, 8000);
					if (!text) {
						return {
							kind: 'reply',
							text: `Message ${messageId} has no readable text body (likely HTML-only or attachment-only).`,
						};
					}
					return { kind: 'reply', text };
				} catch (err) {
					return {
						kind: 'reply',
						text: `Could not fetch body for message ${messageId}: ${(err as Error).message}`,
					};
				}
			},
		}),

		'inbox-extract-data': tool({
			description:
				"Extract structured transactional data (kind, amount, currency, merchant, date, cardLast4, referenceNumber, anomalyHint) from a queued message. Returns cached extraction if present; otherwise runs the extractor (subject + 500-char preview) and caches the result. " +
				"Use for 'how much was that charge', 'what merchant', 'is this transaction unusual', 'what was the OTP'. " +
				"Only operates on rows with category='transactional' — non-transactional rows return a note explaining the row's category and skip extraction. " +
				"PROVENANCE: `messageId` MUST be a real id from a prior `inbox-list-queued` / `inbox-read-body` result. NEVER fabricate ids.",
			inputSchema: z.object({
				messageId: z.number().int().positive(),
			}),
			execute: async ({ messageId }): Promise<ToolResult> => {
				logToolCall('inbox-extract-data', { messageId });
				const msg = getMessage(messageId);
				if (!msg) {
					const reply = `ERROR: Message ${messageId} not found. Likely a hallucinated id. Call inbox-list-queued first. Do NOT report success to the user.`;
					recordAgentAction({
						tool: 'inbox-extract-data',
						messageId,
						actor: 'orchestrator',
						args: { messageId },
						result: { ok: false, reason: 'not-found' },
					});
					return { kind: 'reply', text: reply };
				}

				if (msg.category !== 'transactional') {
					const reply = `Message ${messageId} is category '${msg.category ?? 'unclassified'}' — extraction is scoped to transactional rows only. No data extracted.`;
					recordAgentAction({
						tool: 'inbox-extract-data',
						messageId,
						actor: 'orchestrator',
						args: { messageId },
						result: { ok: false, reason: 'non-transactional', category: msg.category },
					});
					return { kind: 'reply', text: reply };
				}

				// Cache hit — return immediately, no LLM call, no new audit row
				// (the cached extraction already has its own audit history).
				const cached = getExtractedData<TransactionalExtract>(messageId);
				if (cached) {
					return {
						kind: 'reply',
						text: formatExtract(messageId, cached, /*fromCache*/ true),
					};
				}

				const result = await extractTransactional(inputFromMessage(msg));
				setExtractedData(messageId, result.extract);
				recordAgentAction({
					tool: 'inbox-extract-data',
					messageId,
					actor: 'orchestrator',
					args: { messageId },
					result: {
						ok: result.ok,
						kind: result.extract.kind,
						reason: result.reason,
						usedBodyFallback: result.usedBodyFallback,
					},
				});
				return {
					kind: 'reply',
					text: formatExtract(messageId, result.extract, /*fromCache*/ false),
				};
			},
		}),

		'inbox-drill-down': tool({
			description:
				"STRICT ROUTING: any user mention of 'msg <N>', 'message <N>', 'about <N>', or a bare 4-6 digit number that appears in the recent conversation context (digest / anomaly push / list-queued result) routes HERE. NOT vaultSearch — that's for vault notes, NOT inbox rows. NOT reply — drill-down composes the answer for you. " +
				"Returns everything cheap-to-fetch about a single inbox message: envelope (from/subject/when), cached extracted_data, agent-action history, and a 200-char body preview. Typical triggers: 'what about msg 33602', 'tell me about 33425', 'more on 33877', or just the bare number '33877' as a reply to a digest. " +
				"Does NOT fetch the full body — call `inbox-read-body` next if the user wants more after seeing the preview. " +
				"PROVENANCE: `messageId` MUST be a real id from a prior `inbox-list-queued`, `inbox-anomaly-push`, `inbox-digest`, or a number the user explicitly typed in their reply. NEVER fabricate.",
			inputSchema: z.object({
				messageId: z.number().int().positive(),
			}),
			execute: withToolCache(
				'inbox-drill-down',
				async ({ messageId }): Promise<ToolResult> => {
					logToolCall('inbox-drill-down', { messageId });
					const text = composeDrillDown(messageId);
					if (!text) {
						return {
							kind: 'reply',
							text: `ERROR: Message ${messageId} not found in inbox.db. Likely a hallucinated id. Do NOT report success to the user.`,
						};
					}
					return { kind: 'reply', text };
				},
				// 30s — a message's envelope/extracted_data/preview doesn't change
				// in the typical follow-up burst ("tell me about 33877" → "and the
				// merchant?" → "anomaly?"). On a true change (re-classification)
				// the cache simply ages out.
			),
		}),

		'crm-add-contact': tool({
			description:
				"Add a new CRM contact. Use when the user says 'add X as a new lead', 'remember Sarah from Acme', " +
				"'create a contact for Y'. Provide displayName plus any combination of company, role, source, stage " +
				"(default 'Lead'), and an emails array. After creating, the contact's vault note is generated " +
				"automatically in knowledge/crm/contacts/ with managed frontmatter.",
			inputSchema: z.object({
				displayName: z.string().min(1).max(120),
				company: z.string().max(120).optional(),
				role: z.string().max(120).optional(),
				source: z.enum(['Website', 'LinkedIn', 'Twitter', 'Email', 'Referral', 'Speaking']).optional(),
				stage: z.enum(CONTACT_STAGES as readonly [ContactStage, ...ContactStage[]]).optional(),
				notes: z.string().max(2000).optional(),
				emails: z
					.array(
						z.object({
							email: z.string().email(),
							label: z.string().max(40).optional(),
							isPrimary: z.boolean().optional(),
						}),
					)
					.optional(),
			}),
			execute: async (input): Promise<ToolResult> => {
				logToolCall('crm-add-contact', {
					displayName: input.displayName,
					company: input.company,
					emails: input.emails?.length ?? 0,
				});
				try {
					const created = addContact(input);
					const syncResult = await syncContactToVault(created.id);
					const vaultNote = syncResult.ok ? ` Vault note: ${syncResult.path}.` : '';
					const emailLine =
						created.emails.length > 0
							? ` Emails: ${created.emails.map((e) => e.email).join(', ')}.`
							: '';
					return {
						kind: 'reply',
						text: `Created ${created.id} (${created.displayName}, ${created.stage}).${emailLine}${vaultNote}`,
					};
				} catch (err) {
					return { kind: 'reply', text: `Could not add contact: ${(err as Error).message}` };
				}
			},
		}),

		'crm-find-contact': tool({
			description:
				"Search CRM contacts. Pass `email` for exact-email lookup (case-insensitive), `phone` for exact-phone lookup (as-typed — phones are stored unnormalized), or `query` for FTS5 over name, company, role, and notes. Returns the matches with stage and primary email. " +
				"Use for 'who is X', 'do I have a contact at Acme', 'find John's record', 'is sarah@acme.com in my CRM', 'who owns +971 50 123 4567'.",
			inputSchema: z
				.object({
					query: z.string().min(1).max(200).optional(),
					email: z.string().email().optional(),
					phone: z.string().min(3).max(40).optional(),
					limit: z.number().int().min(1).max(25).optional(),
				})
				.refine((v) => v.query || v.email || v.phone, {
					message: 'Provide one of `query`, `email`, or `phone`.',
				}),
			execute: async ({ query, email, phone, limit }): Promise<ToolResult> => {
				logToolCall('crm-find-contact', { query, email, phone, limit });
				const matches: Contact[] = [];
				if (email) {
					const m = findContactByEmail(email);
					if (m) matches.push(m.contact);
				}
				if (phone && matches.length === 0) {
					const m = findContactByPhone(phone);
					if (m) matches.push(m.contact);
				}
				if (query && matches.length === 0) {
					matches.push(...searchContacts(query, limit ?? 10));
				}
				if (matches.length === 0) {
					return { kind: 'reply', text: 'No CRM contacts match.' };
				}
				const lines = matches.map((c, i) => {
					const company = c.company ? ` · ${c.company}` : '';
					const role = c.role ? ` (${c.role})` : '';
					return `${i + 1}. ${c.displayName}${company}${role} — ${c.stage}  (id ${c.id})`;
				});
				return {
					kind: 'reply',
					text: `${matches.length} match${matches.length === 1 ? '' : 'es'}:\n${lines.join('\n')}`,
				};
			},
		}),

		'crm-log-interaction': tool({
			description:
				"Log an interaction with a CRM contact (channel: email/call/meeting/social/whatsapp/other). " +
				"Resolve the contact via `contactId` (CRM-YYYY-NNN) OR `email`. Provide a short `summary`. " +
				"Optionally set `messageId` to cross-reference an inbox message id from inbox-list-queued. " +
				"Use after 'I met with X', 'called Y', 'replied to Z's email'. " +
				"PROVENANCE: `contactId` MUST come from a prior `crm-find-contact` / `crm-add-contact` / `crm-update-stage` result. `email` MUST be either a known CRM contact's email (run `crm-find-contact` first if unsure) OR a real `from_address` from a prior `inbox-list-queued` row. NEVER fabricate emails or contact ids. `messageId` MUST be a real inbox id from a prior `inbox-list-queued` / `inbox-read-body` result.",
			inputSchema: z
				.object({
					contactId: z.string().regex(/^CRM-\d{4}-\w+$/).optional(),
					email: z.string().email().optional(),
					channel: z.enum(['email', 'call', 'meeting', 'social', 'whatsapp', 'other']),
					direction: z.enum(['inbound', 'outbound']).optional(),
					summary: z.string().min(1).max(500),
					messageId: z.number().int().positive().optional(),
				})
				.refine((v) => v.contactId || v.email, {
					message: 'Provide either `contactId` or `email`.',
				}),
			execute: async (input): Promise<ToolResult> => {
				logToolCall('crm-log-interaction', {
					contactId: input.contactId,
					email: input.email,
					channel: input.channel,
				});
				const contactId = resolveCrmContactId(input);
				if (!contactId) {
					return {
						kind: 'reply',
						text:
							`ERROR: No CRM contact for ${input.email ?? input.contactId ?? 'the provided id'}. ` +
							`Likely a hallucinated email/id. ` +
							`Call crm-find-contact first to look up the real value, or use crm-add-contact if this is a new lead. ` +
							`Do NOT report success to the user.`,
					};
				}
				try {
					const row = addInteraction({
						contactId,
						channel: input.channel as InteractionChannel,
						direction: input.direction as InteractionDirection | undefined,
						summary: input.summary,
						messageId: input.messageId ?? null,
					});
					return {
						kind: 'reply',
						text: `Logged ${row.channel} interaction with ${contactId} (#${row.id}).`,
					};
				} catch (err) {
					return { kind: 'reply', text: `Could not log interaction: ${(err as Error).message}` };
				}
			},
		}),

		'crm-update-stage': tool({
			description:
				"Move a CRM contact between pipeline stages: Lead → Contacted → In Conversation → Proposal → Won → Lost. " +
				"Resolve via `contactId` or `email`. Writes a stage_history row + refreshes the vault note frontmatter. " +
				"Use for 'move John to In Conversation', 'mark Acme as Won', 'lost the Carrefour deal'. " +
				"PROVENANCE: `contactId` / `email` MUST come from a prior `crm-find-contact` / `crm-add-contact` result, OR be one the user explicitly named. NEVER fabricate emails or contact ids.",
			inputSchema: z
				.object({
					contactId: z.string().regex(/^CRM-\d{4}-\w+$/).optional(),
					email: z.string().email().optional(),
					stage: z.enum(CONTACT_STAGES as readonly [ContactStage, ...ContactStage[]]),
					reason: z.string().max(200).optional(),
				})
				.refine((v) => v.contactId || v.email, {
					message: 'Provide either `contactId` or `email`.',
				}),
			execute: async (input): Promise<ToolResult> => {
				logToolCall('crm-update-stage', {
					contactId: input.contactId,
					email: input.email,
					stage: input.stage,
				});
				const contactId = resolveCrmContactId(input);
				if (!contactId) {
					return {
						kind: 'reply',
						text:
							`ERROR: No CRM contact for ${input.email ?? input.contactId ?? 'the provided id'}. ` +
							`Likely a hallucinated email/id. ` +
							`Call crm-find-contact first to look up the real value. ` +
							`Do NOT report success to the user.`,
					};
				}
				const changed = updateContactStage(contactId, input.stage as ContactStage, input.reason);
				if (!changed) {
					const current = getContact(contactId);
					return {
						kind: 'reply',
						text: current
							? `${contactId} is already at stage ${current.stage}.`
							: `Contact ${contactId} not found.`,
					};
				}
				const syncResult = await syncContactToVault(contactId);
				const vaultNote = syncResult.ok ? ` Vault note synced.` : '';
				return {
					kind: 'reply',
					text: `Updated ${contactId} to ${input.stage}.${vaultNote}`,
				};
			},
		}),

		'crm-set-followup': tool({
			description:
				"Schedule the next follow-up date for a CRM contact. Resolve via `contactId` or `email`. " +
				"Emit `dueAt` as ISO 8601 with timezone offset (parse natural language relative to Asia/Dubai). " +
				"By default also creates a WhatsApp reminder via the heartbeat commitments rail so the user is " +
				"pinged at the due time — set `createReminder=false` to skip the ping. " +
				"Use for 'follow up with X next Tuesday', 'set a reminder to ping Sarah in two weeks'. " +
				"PROVENANCE: `contactId` / `email` MUST come from a prior `crm-find-contact` / `crm-add-contact` result, OR be one the user explicitly named. NEVER fabricate emails or contact ids.",
			inputSchema: z
				.object({
					contactId: z.string().regex(/^CRM-\d{4}-\w+$/).optional(),
					email: z.string().email().optional(),
					dueAt: z.string().datetime({ offset: true }),
					context: z.string().max(120).optional(),
					createReminder: z.boolean().optional(),
				})
				.refine((v) => v.contactId || v.email, {
					message: 'Provide either `contactId` or `email`.',
				}),
			execute: async (input): Promise<ToolResult> => {
				logToolCall('crm-set-followup', {
					contactId: input.contactId,
					email: input.email,
					dueAt: input.dueAt,
				});
				const contactId = resolveCrmContactId(input);
				if (!contactId) {
					return {
						kind: 'reply',
						text:
							`ERROR: No CRM contact for ${input.email ?? input.contactId ?? 'the provided id'}. ` +
							`Likely a hallucinated email/id. ` +
							`Call crm-find-contact first to look up the real value. ` +
							`Do NOT report success to the user.`,
					};
				}
				const contact = getContact(contactId);
				if (!contact) {
					return {
						kind: 'reply',
						text: `ERROR: Contact ${contactId} not found. Do NOT report success to the user.`,
					};
				}
				const ts = Date.parse(input.dueAt);
				if (Number.isNaN(ts)) {
					return { kind: 'reply', text: `Invalid dueAt: ${input.dueAt}.` };
				}
				setNextFollowup(contactId, ts);

				// Optional heartbeat reminder. Mirrors scheduleReminder's gates but
				// quieter — if any gate fails we still record the follow-up date,
				// we just skip the chat-ping piece and tell the user.
				const wantsReminder = input.createReminder !== false;
				let reminderNote = '';
				if (wantsReminder) {
					const canReminder =
						deps.channel === 'whatsapp' &&
						deps.remindersConfig?.enabled &&
						!!deps.senderNumber &&
						ts > Date.now();
					if (canReminder) {
						const ctx = input.context ? ` about ${input.context}` : '';
						try {
							insertCommitment({
								channel: 'whatsapp',
								target: deps.senderNumber!,
								suggestedText: `Follow up with ${contact.displayName}${ctx}`,
								dueAfterTs: ts,
								sourceMsgId: null,
								confidence: 1.0,
								source: 'crm-followup',
							});
							reminderNote = ' WhatsApp reminder scheduled.';
						} catch (err) {
							reminderNote = ` (reminder skipped: ${(err as Error).message})`;
						}
					} else {
						reminderNote = ' (reminder skipped — heartbeat off or non-WhatsApp channel)';
					}
				}
				const when = new Date(ts).toISOString();
				return {
					kind: 'reply',
					text: `Set follow-up for ${contact.displayName} (${contactId}) at ${when}.${reminderNote}`,
				};
			},
		}),

		'crm-list-followups': tool({
			description:
				"List CRM contacts with overdue or upcoming follow-ups. Optional knobs: `overdueWindowDays` " +
				"(how far back to look for overdue rows) + `upcomingWindowDays` (default 3). Returns the lists " +
				"grouped — render them as two short sections in the reply. Use for 'what's overdue', " +
				"'who do I need to follow up with', 'my follow-ups this week'.",
			inputSchema: z.object({
				overdueWindowDays: z.number().int().min(0).max(365).optional(),
				upcomingWindowDays: z.number().int().min(0).max(60).optional(),
				limit: z.number().int().min(1).max(100).optional(),
			}),
			execute: async (opts): Promise<ToolResult> => {
				logToolCall('crm-list-followups', opts);
				const { overdue, upcoming } = listFollowups(opts);
				if (overdue.length === 0 && upcoming.length === 0) {
					return { kind: 'reply', text: 'No follow-ups in window.' };
				}
				const formatRow = (c: Contact): string => {
					const when = c.nextFollowupAt ? new Date(c.nextFollowupAt).toISOString().slice(0, 10) : '—';
					return `${c.displayName} (${c.stage}) — ${when}  (id ${c.id})`;
				};
				const sections: string[] = [];
				if (overdue.length > 0) {
					sections.push(`Overdue (${overdue.length}):\n${overdue.map(formatRow).join('\n')}`);
				}
				if (upcoming.length > 0) {
					sections.push(`Upcoming (${upcoming.length}):\n${upcoming.map(formatRow).join('\n')}`);
				}
				return { kind: 'reply', text: sections.join('\n\n') };
			},
		}),

		'crm-add-email': tool({
			description:
				"Add an additional email address to an existing CRM contact. Resolve via `contactId` or " +
				"`currentEmail` (one of the contact's existing addresses). Provide the `newEmail` and " +
				"optional `label` ('work' | 'personal' | other) and `isPrimary`. Emails are globally unique " +
				"across the CRM — reusing an email attached to another contact errors. " +
				"PROVENANCE: `contactId` / `currentEmail` MUST come from a prior `crm-find-contact` / `crm-add-contact` result. `newEmail` MUST come from the user explicitly (a message they typed) OR from a real `from_address` in `inbox-list-queued`. NEVER fabricate emails.",
			inputSchema: z
				.object({
					contactId: z.string().regex(/^CRM-\d{4}-\w+$/).optional(),
					currentEmail: z.string().email().optional(),
					newEmail: z.string().email(),
					label: z.string().max(40).optional(),
					isPrimary: z.boolean().optional(),
				})
				.refine((v) => v.contactId || v.currentEmail, {
					message: 'Provide either `contactId` or `currentEmail`.',
				}),
			execute: async (input): Promise<ToolResult> => {
				logToolCall('crm-add-email', {
					contactId: input.contactId,
					currentEmail: input.currentEmail,
					newEmail: input.newEmail,
				});
				const contactId = resolveCrmContactId({
					contactId: input.contactId,
					email: input.currentEmail,
				});
				if (!contactId) {
					return {
						kind: 'reply',
						text:
							`ERROR: No CRM contact for ${input.currentEmail ?? input.contactId ?? 'the provided id'}. ` +
							`Likely a hallucinated email/id. ` +
							`Call crm-find-contact first to look up the real value. ` +
							`Do NOT report success to the user.`,
					};
				}
				try {
					addContactEmail({
						contactId,
						email: input.newEmail,
						label: input.label,
						isPrimary: !!input.isPrimary,
					});
				} catch (err) {
					return {
						kind: 'reply',
						text: `Could not add email: ${(err as Error).message}`,
					};
				}
				const syncResult = await syncContactToVault(contactId);
				const vaultNote = syncResult.ok ? ' Vault note synced.' : '';
				return {
					kind: 'reply',
					text: `Added ${input.newEmail} to ${contactId}.${vaultNote}`,
				};
			},
		}),

		'crm-add-phone': tool({
			description:
				"Add a phone number to an existing CRM contact. Resolve via `contactId` or `email` (one of the contact's existing emails). Provide `phone` (any format — stored as-typed, no E.164 normalization) and optional `label` ('mobile' | 'home' | 'work' | other) and `isPrimary`. Phones are globally unique across the CRM — reusing a number attached to another contact errors. " +
				"PROVENANCE: `contactId` / `email` MUST come from a prior `crm-find-contact` / `crm-add-contact` result. `phone` MUST come from the user explicitly (a message they typed). NEVER fabricate phone numbers.",
			inputSchema: z
				.object({
					contactId: z.string().regex(/^CRM-\d{4}-\w+$/).optional(),
					email: z.string().email().optional(),
					phone: z.string().min(3).max(40),
					label: z.string().max(40).optional(),
					isPrimary: z.boolean().optional(),
				})
				.refine((v) => v.contactId || v.email, {
					message: 'Provide either `contactId` or `email`.',
				}),
			execute: async (input): Promise<ToolResult> => {
				logToolCall('crm-add-phone', {
					contactId: input.contactId,
					email: input.email,
					phone: input.phone,
				});
				const contactId = resolveCrmContactId({
					contactId: input.contactId,
					email: input.email,
				});
				if (!contactId) {
					return {
						kind: 'reply',
						text:
							`ERROR: No CRM contact for ${input.email ?? input.contactId ?? 'the provided id'}. ` +
							`Likely a hallucinated email/id. ` +
							`Call crm-find-contact first to look up the real value. ` +
							`Do NOT report success to the user.`,
					};
				}
				try {
					addContactPhone({
						contactId,
						phone: input.phone,
						label: input.label,
						isPrimary: !!input.isPrimary,
					});
				} catch (err) {
					return {
						kind: 'reply',
						text: `Could not add phone: ${(err as Error).message}`,
					};
				}
				const syncResult = await syncContactToVault(contactId);
				const vaultNote = syncResult.ok ? ' Vault note synced.' : '';
				return {
					kind: 'reply',
					text: `Added ${input.phone} to ${contactId}.${vaultNote}`,
				};
			},
		}),

		'crm-attach-note': tool({
			description:
				'Attach a vault note (transcript, document, reference) to a CRM contact. ' +
				'Resolve via `contactId` (CRM-YYYY-NNN) OR `email`. `vaultPath` is the ' +
				"vault-relative path of an EXISTING note (e.g., 'inbox/2026-05-11-acme-kickoff.md'). " +
				"Optional: `kind` (transcript / document / reference / other; default 'other'), " +
				'`label`, `sourceUrl`, `sourceMessageId`. ' +
				'Chains naturally after `vaultSave` when the saved content came from a URL fetch ' +
				'(via `fetchPage`) or an email link relevant to a CRM contact. ' +
				'Idempotent — re-attaching the same (contact, vaultPath) pair reports the prior ' +
				'attachment timestamp without inserting a duplicate. ' +
				"PROVENANCE — DO NOT INVENT ARGS: `vaultPath` MUST be the LITERAL `path` returned by a prior `vaultSave` call (NEVER guess based on title or date — vaultSave's output is the truth). `email` / `contactId` MUST come from a prior `crm-find-contact` / `crm-add-contact` result, OR be one the user explicitly named. `sourceMessageId` MUST be a real inbox id from a prior `inbox-list-queued` / `inbox-read-body` result. The tool errors loudly when args don't resolve — that error means you hallucinated; do NOT relay a fake 'success' to the user.",
			inputSchema: z
				.object({
					contactId: z.string().regex(/^CRM-\d{4}-\w+$/).optional(),
					email: z.string().email().optional(),
					vaultPath: z.string().min(1).max(500),
					kind: z.enum(CONTACT_NOTE_KINDS as readonly [ContactNoteKind, ...ContactNoteKind[]]).optional(),
					label: z.string().max(120).optional(),
					sourceUrl: z.string().url().optional(),
					sourceMessageId: z.number().int().positive().optional(),
				})
				.refine((v) => v.contactId || v.email, {
					message: 'Provide either `contactId` or `email`.',
				}),
			execute: async (input): Promise<ToolResult> => {
				logToolCall('crm-attach-note', {
					contactId: input.contactId,
					email: input.email,
					vaultPath: input.vaultPath,
					kind: input.kind,
				});

				// 1. Resolve contact.
				const contactId = resolveCrmContactId(input);
				if (!contactId) {
					return {
						kind: 'reply',
						text:
							`ERROR: No CRM contact for ${input.email ?? input.contactId ?? 'the provided id'}. ` +
							`Likely a hallucinated email/id. ` +
							`Call crm-find-contact first to look up the real value, or use crm-add-contact if this is a new lead. ` +
							`Do NOT report success to the user.`,
					};
				}
				const contact = getContact(contactId);
				if (!contact) {
					return {
						kind: 'reply',
						text: `ERROR: Contact ${contactId} not found. Do NOT report success to the user.`,
					};
				}

				// 2. Verify the vault note exists BEFORE inserting (per ADR D10.2
				// step 2 — guards against LLM-hallucinated paths).
				const vault = getVaultEngine();
				if (!vault) {
					return { kind: 'reply', text: 'ERROR: Vault engine not initialized.' };
				}
				const note = vault.getNote(input.vaultPath);
				if (!note) {
					return {
						kind: 'reply',
						text:
							`ERROR: No vault note at "${input.vaultPath}". Likely a hallucinated path. ` +
							`vaultSave returns the exact path — use that value verbatim from the prior tool call's result. ` +
							`Do NOT guess paths from titles or dates. ` +
							`If you haven't saved yet, call vaultSave first and read the \`path\` field from the result. ` +
							`Do NOT report success to the user.`,
					};
				}

				// 3. Idempotent attach.
				const result = attachNote({
					contactId,
					vaultPath: input.vaultPath,
					kind: input.kind,
					label: input.label,
					sourceUrl: input.sourceUrl,
					sourceMessageId: input.sourceMessageId,
				});

				// 4. Refresh the contact's frontmatter (`related_notes` array).
				const syncResult = await syncContactToVault(contactId);
				const vaultNote = syncResult.ok ? ' Vault note synced.' : '';

				const kind = result.row.kind;
				if (!result.inserted) {
					const when = new Date(result.row.attachedAt).toISOString();
					return {
						kind: 'reply',
						text: `Already attached to ${contact.displayName} (${contactId}) as ${kind} at ${when}.${vaultNote}`,
					};
				}
				return {
					kind: 'reply',
					text: `Attached ${input.vaultPath} to ${contact.displayName} (${contactId}) as ${kind}.${vaultNote}`,
				};
			},
		}),

		'crm-find-website-leads': tool({
			description:
				"Find inbox messages that look like website leads — subject contains a configurable tag " +
				"(default a configurable subject tag) AND the sender is NOT already a CRM contact. Returns a list " +
				"the user can convert into contacts via crm-add-contact. Use for 'any new website leads', " +
				"'check for inquiries from the site', 'who reached out from the site this week'.",
			inputSchema: z.object({
				subjectContains: z.string().max(80).optional(),
				limit: z.number().int().min(1).max(50).optional(),
			}),
			execute: async ({ subjectContains, limit }): Promise<ToolResult> => {
				logToolCall('crm-find-website-leads', { subjectContains, limit });
				const results = findWebsiteLeads({ subjectContains, limit });
				if (results.length === 0) {
					return { kind: 'reply', text: 'No fresh website leads.' };
				}
				const lines = results.map((r, i) => {
					const when = new Date(r.dateReceived).toISOString().slice(0, 10);
					const who = r.fromName ? `${r.fromName} <${r.fromAddress}>` : r.fromAddress;
					return `${i + 1}. ${who} — ${r.subject}  · ${when}  (id ${r.messageId})`;
				});
				return {
					kind: 'reply',
					text: `${results.length} website lead${results.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
				};
			},
		}),
	};
}

/**
 * Coerce a `since` arg into epoch-ms for inbox-list-queued. Accepts ISO
 * datetimes and a handful of natural-language tokens. Returns undefined
 * when the input is empty or unparseable — the caller treats that as "no
 * lower bound" rather than 400'ing.
 */
function parseSinceArg(since?: string): number | undefined {
	if (!since) return undefined;
	const lower = since.toLowerCase().trim();
	const now = Date.now();
	if (lower === 'today') {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}
	if (lower === 'yesterday') {
		return now - 24 * 60 * 60 * 1000;
	}
	if (lower === 'week' || lower === 'this week') {
		return now - 7 * 24 * 60 * 60 * 1000;
	}
	const parsed = Date.parse(since);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Lightweight "5h ago" / "2d ago" formatter for the listing UI. */
function formatRelativeDate(ms: number): string {
	const diff = Date.now() - ms;
	const min = Math.round(diff / 60_000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const d = Math.round(hr / 24);
	return `${d}d ago`;
}

/** Given a ts (ms) and an active-hours window, return the same ts if it
 *  falls inside the window today, or the next window-start ts otherwise.
 *  Pure helper for `scheduleReminder` — no DB access, no clock side effects. */
function deferToActiveWindow(
	tsMs: number,
	window: { start: string; end: string; timezone: string },
): number {
	const tz = window.timezone;
	const [startH, startM] = window.start.split(':').map(Number);
	const [endH, endM] = window.end.split(':').map(Number);
	const startMinutes = startH * 60 + startM;
	const endMinutes = endH * 60 + endM;

	const localMinutes = localMinutesAt(tsMs, tz);
	if (localMinutes >= startMinutes && localMinutes < endMinutes) {
		return tsMs;
	}

	// Outside window. Compute the next start-of-window in `tz`.
	const startLocalToday = tsAtLocalTime(tsMs, tz, startH, startM);
	if (startLocalToday > tsMs) {
		return startLocalToday;
	}
	// Window has already passed today — defer to tomorrow's start.
	return startLocalToday + 24 * 60 * 60 * 1000;
}

/** Minutes-since-local-midnight at `tsMs` in `tz`. */
function localMinutesAt(tsMs: number, tz: string): number {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	const parts = fmt.formatToParts(new Date(tsMs));
	const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
	const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
	return h * 60 + m;
}

/** Snap `tsMs` to local HH:MM in `tz`, returning the UTC ms. Coarse —
 *  ignores DST transitions on the exact transition day; acceptable for
 *  reminder deferral where ±1h on the rare DST-edge ticks is fine. */
function tsAtLocalTime(tsMs: number, tz: string, hh: number, mm: number): number {
	const ymd = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(tsMs));
	// Build a date string in the target tz, then resolve to UTC by computing
	// the tz offset at that local time via a probe Date.
	const iso = `${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
	const asUtc = Date.parse(`${iso}Z`);
	const probeLocal = localMinutesAt(asUtc, tz);
	const offsetMin = probeLocal - (hh * 60 + mm);
	return asUtc - offsetMin * 60 * 1000;
}

function formatInTz(tsMs: number, tz: string): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: tz,
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(tsMs));
}

function logToolCall(name: string, payload: Record<string, unknown>): void {
	const argPreview = JSON.stringify(payload);
	console.log(`[orchestrator-v2] tool:${name}`, argPreview);
	// ADR-015 — feed the in-memory ring buffer that powers /orchestrator/tools.
	recordToolCall(name, argPreview.slice(0, 240));
}

/** Compose an honest user-facing reply for a fetchPage failure. Each
 *  `failureClass` gets a tailored sentence so the LLM doesn't have to
 *  reason about the failure shape — it just relays the message. */
function buildFetchPageFailureMessage(result: import('../../fetch-page/index.js').FetchPageResult): string {
	const host = (() => { try { return new URL(result.finalUrl).hostname; } catch { return result.url; } })();
	switch (result.failureClass) {
		case 'js-required':
			return `This page (${host}) looks JavaScript-hydrated — I couldn't extract the text with a plain fetch. If you have the content directly (e.g., paste the transcript), I can work with that.`;
		case 'auth-required':
			return `This page (${host}) requires sign-in — I can only read public pages. Paste the content if you have access.`;
		case 'bot-blocked':
			return `${host} is blocking automated reads (looks like Cloudflare/bot protection). Paste the content if you can copy it from a browser.`;
		case 'unsupported-mime':
			return `That URL doesn't return HTML (likely a PDF, image, or video). I can't extract it today.`;
		case 'unsafe-url':
			return `I can't fetch that URL — it points at a private or internal host, which is blocked for safety.`;
		case 'timeout':
			return `${host} took too long to respond and I timed out. Try again or paste the content if you can.`;
		case 'too-many-redirects':
			return `${host} bounced through too many redirects. I gave up after 5 hops.`;
		case 'sanitizer-stripped':
			// This isn't a true failure — we already have text. The classifier
			// flagged it so future logs catch the trend; we still return the text.
			return result.text || `Fetched the page but the content looked like a prompt-injection payload — nothing usable.`;
		case 'empty-content':
		case 'fetch-error':
		default:
			return `Couldn't read ${host}: ${result.error ?? 'no extractable content'}.`;
	}
}

/** Resolve a CRM contact id from either an explicit id or an email lookup.
 *  Returns null when neither input matches an existing contact. Used by
 *  every mutation tool that lets the model identify a contact two ways
 *  (the LLM rarely knows the CRM id but often knows the email). */
function resolveCrmContactId(input: { contactId?: string; email?: string }): string | null {
	if (input.contactId) return input.contactId;
	if (input.email) {
		const match = findContactByEmail(input.email);
		return match?.contact.id ?? null;
	}
	return null;
}

/** Render a TransactionalExtract as a compact one-message reply. Empty
 *  fields are skipped; failure stubs (`kind:'unknown'`) surface the note. */
function formatExtract(
	messageId: number,
	extract: TransactionalExtract,
	fromCache: boolean,
): string {
	const tag = fromCache ? '(cached)' : '(extracted)';
	if (extract.kind === 'unknown') {
		const note = extract.note ? ` — ${extract.note}` : '';
		return `Message ${messageId}: extraction did not fit the transactional shape${note}. ${tag}`;
	}
	const parts: string[] = [`kind=${extract.kind}`];
	if (extract.amount !== undefined && extract.currency) {
		parts.push(`amount=${extract.amount} ${extract.currency}`);
	} else if (extract.amount !== undefined) {
		parts.push(`amount=${extract.amount}`);
	}
	if (extract.merchant) parts.push(`merchant="${extract.merchant}"`);
	if (extract.date) parts.push(`date=${extract.date}`);
	if (extract.cardLast4) parts.push(`card=••${extract.cardLast4}`);
	if (extract.referenceNumber) parts.push(`ref=${extract.referenceNumber}`);
	if (extract.anomalyHint) parts.push(`anomaly=true`);
	if (extract.note) parts.push(`note="${extract.note}"`);
	return `Message ${messageId} ${tag}: ${parts.join(', ')}.`;
}

/** ADR-030 — shared youtubeFetch execution. Both the inline path
 *  (metadata mode + REPL callers) and the slow-dispatch closure run
 *  through here; the only divergence is whether the closure runs in the
 *  AI SDK's tool-execute tick or in `runSkillInBackground`. */
async function runYoutubeFetchInline(args: {
	url: string;
	mode: 'metadata' | 'summary' | 'transcript' | 'full';
	deps: ToolDeps;
}): Promise<ToolResult> {
	const { url, mode, deps } = args;

	let transcriptQuotaExceeded = false;
	const willCallGemini =
		mode !== 'metadata' &&
		(deps.youtubeConfig?.enabled ?? false) &&
		!!deps.senderNumber;
	if (willCallGemini && deps.youtubeConfig && deps.senderNumber) {
		const tz = deps.timezone ?? 'Asia/Dubai';
		const today = ymdInTimezone(tz);
		const count = getYoutubeCount(deps.senderNumber, today);
		if (count >= deps.youtubeConfig.maxPerDay) {
			transcriptQuotaExceeded = true;
		}
	}

	const outcome = await fetchYoutube(url, {
		mode,
		youtubeConfig: deps.youtubeConfig,
		transcriptQuotaExceeded,
	});

	if (!outcome.ok) {
		return {
			kind: 'youtube-error',
			url: outcome.error.url,
			error: outcome.error.error,
			tier: outcome.error.tier,
		};
	}

	const r = outcome.result;
	if (
		r.transcriptSource === 'gemini' &&
		deps.senderNumber &&
		deps.youtubeConfig &&
		!transcriptQuotaExceeded
	) {
		const tz = deps.timezone ?? 'Asia/Dubai';
		incrementYoutubeCount(deps.senderNumber, ymdInTimezone(tz));
	}

	return {
		kind: 'youtube',
		url: r.url,
		videoId: r.videoId,
		title: r.metadata.title,
		channel: r.metadata.channel,
		thumbnailUrl: r.metadata.thumbnailUrl,
		durationSec: r.metadata.durationSec,
		description: r.metadata.description,
		summary: r.summary,
		transcript: r.transcript,
		transcriptSource: r.transcriptSource,
		costUsd: r.costUsd,
		note: r.note,
	};
}

/** ADR-030 v2 — inline executor for `tiktokFetch`. Shared by the slow-
 *  dispatch worker and the inline path (metadata mode, non-WhatsApp
 *  channels, REPL/UI test harness). Pure: just runs `fetchTikTok` and
 *  shapes the structured ToolResult. Quota bookkeeping (the
 *  `incrementTiktokCount` call when Gemini ran) is kept here so the slow
 *  path also charges the cap. */
async function runTiktokFetchInline(args: {
	url: string;
	mode: 'metadata' | 'transcript' | 'summary' | 'full';
	deps: ToolDeps;
}): Promise<ToolResult> {
	const { url, mode, deps } = args;

	let summaryQuotaExceeded = false;
	const willCallGemini =
		(mode === 'summary' || mode === 'full') &&
		(deps.tiktokConfig?.enabled ?? false) &&
		!!deps.senderNumber;
	if (willCallGemini && deps.tiktokConfig && deps.senderNumber) {
		const tz = deps.timezone ?? 'Asia/Dubai';
		const today = ymdInTimezone(tz);
		const count = getTiktokCount(deps.senderNumber, today);
		if (count >= deps.tiktokConfig.maxPerDay) {
			summaryQuotaExceeded = true;
		}
	}

	const outcome = await fetchTikTok(url, {
		mode,
		tiktokConfig: deps.tiktokConfig,
		summaryQuotaExceeded,
	});

	if (!outcome.ok) {
		return {
			kind: 'tiktok-error',
			url: outcome.error.url,
			error: outcome.error.error,
			tier: outcome.error.tier,
		};
	}

	const r = outcome.result;
	// Increment quota only when Gemini actually produced a summary.
	// transcriptSource='gemini' alone isn't enough — we want to charge
	// against the cap when Tier C ran, regardless of whether transcript
	// or summary came out of it.
	if (
		r.summary &&
		deps.senderNumber &&
		deps.tiktokConfig &&
		!summaryQuotaExceeded
	) {
		const tz = deps.timezone ?? 'Asia/Dubai';
		incrementTiktokCount(deps.senderNumber, ymdInTimezone(tz));
	}

	return {
		kind: 'tiktok',
		url: r.url,
		videoId: r.videoId,
		author: r.metadata.author,
		authorHandle: r.metadata.authorHandle,
		caption: r.metadata.caption,
		title: r.metadata.title,
		durationSec: r.metadata.durationSec,
		postedAt: r.metadata.postedAt,
		views: r.metadata.views,
		likes: r.metadata.likes,
		comments: r.metadata.comments,
		reposts: r.metadata.reposts,
		isPhotoPost: r.isPhotoPost,
		transcript: r.transcript,
		transcriptLang: r.transcriptLang,
		transcriptSource: r.transcriptSource,
		summary: r.summary,
		costUsd: r.costUsd,
		note: r.note,
	};
}

/** Build the `invokeSkill` tool description dynamically from the registry.
 *  Lists each skill's chat_description + 1 example so the model can pick
 *  + format args correctly. Empty registry → terse description warning the
 *  model not to call it. */
function buildInvokeSkillDescription(chatSkills: readonly ChatSkillEntry[]): string {
	const head =
		'Invoke a Claude Skill — fast scoped utility (seconds, not minutes). Prefer this over dispatchAgent for narrow tasks. Skills run synchronously and the output is threaded back to you so you can compose the final reply.';
	if (chatSkills.length === 0) {
		return `${head}\n\n(No skills are enabled — do not call this tool.)`;
	}
	const lines: string[] = [head, '', 'Available skills:'];
	for (const s of chatSkills) {
		const desc = s.chat_description.replace(/\s+/g, ' ').trim();
		lines.push(`- ${s.name}: ${desc}`);
		if (s.examples.length > 0) {
			const e = s.examples[0];
			lines.push(`  Example: invokeSkill({ skillName: "${s.name}", args: ${JSON.stringify(e.args)} })`);
		}
	}
	return lines.join('\n');
}
