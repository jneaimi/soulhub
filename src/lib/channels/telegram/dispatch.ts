/** Inbound dispatcher — wires the Telegram envelope through access
 *  control → optional voice transcription → pending-proposal classifier
 *  → orchestrator-v2 (decideV2) → routes layer → outbound reply.
 *
 *  Mirrors `whatsapp/_inbound/+server.ts` semantically (the WhatsApp
 *  worker-mode code path) — the orchestrator-v2 layer is channel-blind
 *  by design (per ADR-011) and produces structured `V2Output` payloads
 *  that we render channel-natively (text, image, proposal-with-buttons,
 *  agent dispatch). When orchestrator-v2 falls through (no usable
 *  output, model abstain, etc.) we fall back to the lexical vault-chat
 *  pipeline so the user always gets *something*.
 *
 *  Conversation key prefix: `tg:<chatJid|senderNumber>` so it never
 *  collides with WhatsApp's namespace. */

import { dispatchRoute, RouteNotFoundError } from '../../routes/index.js';
import { dispatchVaultChat } from '../../vault-chat/index.js';
import {
	dispatchVaultSaveNote,
	dispatchVaultFind,
	dispatchVaultRecent,
} from '../../vault-actions/index.js';
import { isResetCommand, resetConversation } from '../../vault-chat/history.js';
import { decideV2 } from '../../orchestrator-v2/index.js';
import { writeIntentDecision } from '../../intent/log.js';
import { normalizeSignature } from '../../intent/normalize.js';
import { config as soulHubConfig } from '../../config.js';
import { WhatsAppChannelSchema } from '../../config.schema.js';
import {
	getPending,
	setPending,
	resolvePending,
	classifyProposalReply,
	formatProposal,
	formatExpiredPrompt,
} from '../../orchestrator/pending-proposals.js';
import { getConversationContext, buildAgentContextBrief } from '../../conversation/index.js';
import { dispatchWebSearch, formatWebSearchForChat } from '../../web-search/index.js';
import { saveTurn } from '../../vault-chat/history.js';
import { markMessageProcessed, recordAgentAction } from '../../inbox/index.js';
import { checkAccess } from './access.js';
import { resolveIntent } from './intent.js';
import { sendText, sendMedia, sendTypingIndicator, editText, chunkText } from './outbound.js';
import { startTypingLoop } from '../_shared/typing.js';
import { isFocusQuery, placeholderTextForRoute } from '../_shared/placeholder.js';
import { startPresence, type PresenceSession } from '../_shared/presence.js';
import {
	progressTextForTool,
	composingTextForTool,
} from '../_shared/tool-progress-text.js';
import { telegramPresenceAdapter } from './presence-adapter.js';
import { downloadMedia, saveMediaToDisk } from './media.js';
import { transcribeVoiceNote } from './transcribe.js';
import { setMessageReaction } from './client.js';
import {
	buildProposalKeyboard,
	rememberProposalButtons,
	buildYoutubeKeyboard,
	rememberYoutubeButtons,
} from './callback.js';
import { runInBackground } from './orchestrator-dispatch.js';
import type {
	InboundEnvelope,
	TelegramChannelConfig,
	TelegramMediaPayload,
} from './types.js';

const HELP_PREFIX = 'I do not recognise that command. Available:';
const PROPOSAL_TTL_MS = 10 * 60 * 1000; // 10 min — matches WhatsApp's default

function helpReply(intentMap: TelegramChannelConfig['intentMap']): string {
	const lines: string[] = [HELP_PREFIX];
	for (const [token, mapping] of Object.entries(intentMap)) {
		if (token === 'default') continue;
		const description = mapping.description ? ` — ${mapping.description}` : '';
		lines.push(`  ${token} → ${mapping.route}${description}`);
	}
	lines.push('');
	lines.push('Free-form messages route to `default`.');
	lines.push('Voice notes are auto-transcribed when transcription is enabled.');
	return lines.join('\n');
}

/** Build the channel-blind conversationKey downstream layers consume.
 *  Always prefixed with `tg:` so it can never collide with a WhatsApp
 *  E.164 number or chat JID. */
export function conversationKeyFor(envelope: InboundEnvelope): string {
	const stem = envelope.isGroup ? envelope.chatJid : envelope.senderNumber;
	return `tg:${stem}`;
}

async function transcribeIfVoice(
	envelope: InboundEnvelope,
	config: TelegramChannelConfig,
	account: string,
): Promise<{ text?: string; buffer?: Buffer; error?: string }> {
	const media = envelope.media;
	if (!media || media.kind !== 'voice') return { text: undefined };
	if (!config.delivery.transcribeVoiceNotes) return { text: undefined };

	const maxBytes = config.delivery.maxMediaSizeMB * 1024 * 1024;
	if (media.fileSize && media.fileSize > maxBytes) {
		return {
			error: `Voice note exceeds ${config.delivery.maxMediaSizeMB}MB cap (was ${(media.fileSize / 1024 / 1024).toFixed(1)}MB) — not transcribing.`,
		};
	}

	let buffer: Buffer;
	let mimetype: string;
	try {
		const downloaded = await downloadMedia(media);
		buffer = downloaded.buffer;
		mimetype = downloaded.mimetype;
	} catch (err) {
		return { error: `Couldn't download voice note: ${(err as Error).message}` };
	}

	try {
		saveMediaToDisk({
			account,
			messageId: envelope.messageId || `inbound-${Date.now()}`,
			payload: media,
			buffer,
		});
	} catch {
		/* archival is optional */
	}

	try {
		const result = await transcribeVoiceNote({
			audio: buffer,
			mimetype,
			providerRef: config.delivery.transcribeProvider,
		});
		return { text: result.text, buffer };
	} catch (err) {
		return { error: `Couldn't transcribe voice note: ${(err as Error).message}` };
	}
}

/** Dispatch one inbound Telegram envelope through the channel-blind
 *  upper layers. */
export async function dispatchInbound(
	envelope: InboundEnvelope,
	config: TelegramChannelConfig,
	account = 'personal',
): Promise<void> {
	const access = checkAccess(envelope, config.access);
	if (!access.allow) return;

	if (config.delivery.ackEmoji) {
		try {
			await setMessageReaction({
				chat_id: envelope.chatJid,
				message_id: Number(envelope.messageId),
				reaction: [{ type: 'emoji', emoji: config.delivery.ackEmoji }],
			});
		} catch {
			/* swallow */
		}
	}

	// Per ADR-022 Layer A: start typing indicator early so the user sees
	// "Soul Hub is typing…" within ~100ms of their message. Re-fires every
	// 4s; stopped by the outer finally regardless of outcome. Decorative —
	// a typing-indicator failure must never break the reply path.
	const stopTyping = startTypingLoop(() => sendTypingIndicator(envelope.chatJid));
	try {
	let workingBody = envelope.body;
	const transcription = await transcribeIfVoice(envelope, config, account);
	if (transcription.error) {
		await sendText(envelope.chatJid, transcription.error, config.delivery);
		return;
	}
	if (transcription.text !== undefined) {
		workingBody = transcription.text;
	}

	const conversationKey = conversationKeyFor(envelope);

	if (envelope.media && envelope.media.kind !== 'voice' && !workingBody.trim()) {
		const hint =
			envelope.media.kind === 'image'
				? `I got your image. Add a caption or send a follow-up message describing what you want me to do — or send \`/save\` to capture it to the vault.`
				: `I got your ${envelope.media.kind}. Tell me what you want to do with it — ask a question, describe it, or send \`/save\` to capture it to the vault.`;
		await sendText(envelope.chatJid, hint, config.delivery);
		return;
	}

	if (isResetCommand(workingBody)) {
		const cleared = resetConversation(conversationKey);
		const replyText = cleared > 0
			? "Conversation reset. What's on your mind?"
			: 'Already a fresh slate.';
		await sendText(envelope.chatJid, replyText, config.delivery);
		return;
	}

	const intent = resolveIntent(workingBody, config.intentMap);

	if (intent.route === 'unknown' || intent.route === 'help') {
		await sendText(envelope.chatJid, helpReply(config.intentMap), config.delivery);
		return;
	}

	// vault-chat / default route → orchestrator-v2 path with proposal +
	// agent-dispatch + image support. Slash-commands (/save, /find,
	// /recent, /img) bypass the orchestrator and go to their dedicated
	// handlers — same as WhatsApp.
	if (intent.route === 'vault-chat') {
		await dispatchOrchestrated(
			envelope,
			workingBody,
			conversationKey,
			config,
			transcription.buffer,
		);
		return;
	}

	try {
		const userText = intent.body || '(empty message)';
		const brainText = intent.body;
		let replyText: string;

		if (intent.route === 'vault-save-note') {
			let buffer: Buffer | undefined;
			let mimetype: string | undefined;
			let mediaKind: TelegramMediaPayload['kind'] | undefined;
			if (envelope.media?.kind === 'voice' && transcription.buffer) {
				buffer = transcription.buffer;
				mimetype = envelope.media.mimetype;
				mediaKind = 'voice';
			} else if (envelope.media && envelope.media.kind !== 'sticker') {
				try {
					const dl = await downloadMedia(envelope.media);
					buffer = dl.buffer;
					mimetype = dl.mimetype;
					mediaKind = envelope.media.kind;
				} catch (err) {
					await sendText(
						envelope.chatJid,
						`Couldn't fetch the ${envelope.media.kind} for /save: ${(err as Error).message}`,
						config.delivery,
					);
					return;
				}
			}
			const saveResult = await dispatchVaultSaveNote({
				envelope: {
					jid: envelope.chatJid,
					isGroup: envelope.isGroup,
					chatJid: envelope.chatJid,
					senderNumber: envelope.senderNumber,
					botMentioned: envelope.botMentioned,
					body: workingBody,
					messageId: envelope.messageId,
				},
				workingBody: brainText,
				mediaBuffer: buffer,
				mimetype,
				mediaKind,
			});
			replyText = saveResult.text;
		} else if (intent.route === 'vault-find') {
			const findResult = await dispatchVaultFind(brainText);
			replyText = findResult.text;
		} else if (intent.route === 'vault-recent') {
			const recentResult = await dispatchVaultRecent();
			replyText = recentResult.text;
		} else {
			const result = await dispatchRoute(intent.route, {
				messages: [{ role: 'user', content: userText }],
				maxOutputTokens: 800,
			});
			replyText = result.text || '(no reply)';
		}
		await sendText(envelope.chatJid, replyText, config.delivery);
	} catch (err) {
		const message =
			err instanceof RouteNotFoundError
				? `Route "${intent.route}" is not configured. Edit settings.json or remove this command from intentMap.`
				: `Sorry, I hit an error: ${(err as Error).message}`;
		await sendText(envelope.chatJid, message, config.delivery);
	}
	} finally {
		// Outer finally — covers all early returns above (access denied,
		// transcription error, reset, unknown/help, vault-chat orchestrated
		// path) AND the inner try/catch. Ensures the typing loop is always
		// cleared even if an unexpected error escapes.
		stopTyping();
	}
}

/** Orchestrator-v2 path for the default route. Mirrors the WhatsApp
 *  `_inbound/+server.ts` flow: pending-proposal classification → decideV2
 *  → render `V2Output` → fall back to vault-chat on no usable output. */
async function dispatchOrchestrated(
	envelope: InboundEnvelope,
	workingBody: string,
	conversationKey: string,
	config: TelegramChannelConfig,
	transcriptionBuffer: Buffer | undefined,
): Promise<void> {
	const turnNow = Date.now();

	// 1. Pending-proposal classifier — if the user has an open proposal
	//    and this message is a confirm/decline/web-switch, resolve here
	//    without invoking decideV2 (saves a model call + matches WhatsApp).
	const pending = getPending(conversationKey);
	if (pending) {
		// Past TTL but inside grace window → re-prompt with expired text.
		if (pending.expired) {
			const replyKind = classifyProposalReply(workingBody);
			if (replyKind !== 'confirm') {
				resolvePending(conversationKey, 'expired');
				await sendText(
					envelope.chatJid,
					formatExpiredPrompt(pending),
					config.delivery,
				);
				return;
			}
			// 'confirm' inside grace → fall through to confirm handler.
		}

		const replyKind = classifyProposalReply(workingBody);
		if (replyKind === 'confirm') {
			resolvePending(conversationKey, 'confirm');
			saveTurn(conversationKey, 'user', workingBody, turnNow);

			// ADR-L3 §D7 Guardrail 1 — `inbox-mark-processed` proposals
			// take the inbox path, not orchestratorDispatch. The audit row
			// increments the trust-trainer counter.
			if (pending.agentId === 'inbox-mark-processed') {
				const messageId = Number.parseInt(pending.task, 10);
				if (!Number.isFinite(messageId)) {
					const text = `Internal error: the stored proposal had an invalid message id (${pending.task}). Ask me to list the inbox again and try once more.`;
					saveTurn(conversationKey, 'assistant', text, turnNow + 1);
					await sendText(envelope.chatJid, text, config.delivery);
					return;
				}
				const ok = markMessageProcessed(messageId);
				recordAgentAction({
					tool: 'inbox-mark-processed',
					messageId,
					actor: 'orchestrator',
					args: { messageId, confirmed: true },
					result: { ok, source: 'proposal-confirm' },
					conversationKey,
				});
				const text = ok
					? `Message ${messageId} marked processed.`
					: `Message ${messageId} couldn't be marked — it may have already been handled or is no longer queued.`;
				saveTurn(conversationKey, 'assistant', text, turnNow + 1);
				await sendText(envelope.chatJid, text, config.delivery);
				return;
			}

			const ctx = getConversationContext(conversationKey, {
				jid: envelope.chatJid,
			});
			const agentContext = buildAgentContextBrief(ctx, pending.task);
			runInBackground({
				chatId: envelope.chatJid,
				agentId: pending.agentId,
				task: pending.task,
				sourceMessage: workingBody,
				conversationKey,
				delivery: config.delivery,
				agentContext,
			});
			return;
		}
		if (replyKind === 'decline') {
			resolvePending(conversationKey, 'decline');
			saveTurn(conversationKey, 'user', workingBody, turnNow);
			const text = 'Got it — dropped that. What would you like instead?';
			saveTurn(conversationKey, 'assistant', text, turnNow + 1);
			await sendText(envelope.chatJid, text, config.delivery);
			return;
		}
		if (replyKind === 'switch-to-web') {
			resolvePending(conversationKey, 'switch-to-web');
			saveTurn(conversationKey, 'user', workingBody, turnNow);
			try {
				const r = await dispatchWebSearch(pending.label);
				const text = formatWebSearchForChat(r);
				saveTurn(conversationKey, 'assistant', text, turnNow + 1);
				await sendText(envelope.chatJid, text, config.delivery);
			} catch (err) {
				const text = `Couldn't run a web search: ${(err as Error).message}`;
				saveTurn(conversationKey, 'assistant', text, turnNow + 1);
				await sendText(envelope.chatJid, text, config.delivery);
			}
			return;
		}
		// 'unrelated' — drop the proposal and fall through to fresh classification.
		resolvePending(conversationKey, 'unrelated');
	}

	// ADR-028 Phase 1 — start the presence session NOW (after pending-
	// proposal early returns, before the slow orchestrator LLM call) so
	// the user sees the 🟡 bubble within ~1s of sending. The same session
	// covers both the orchestrator-v2 path AND the fallbackToVaultChat
	// fallback — we pass it in below.
	const presenceAdapter = telegramPresenceAdapter(envelope.chatJid, config.delivery);
	const presence = startPresence(presenceAdapter);
	try {
	await presence.bubble('vault-chat', {
		isFocusQuery: isFocusQuery(workingBody),
		hasMedia: !!envelope.media,
	});

	// ADR-030 v2 — capture bubble id for slow-tool dispatch (background
	// worker edits the SAME bubble when the slow tool completes).
	const bubbleIdForSlowDispatch = presence.state().bubbleId;

	// 2. Run orchestrator-v2.
	const ctx = getConversationContext(conversationKey, { jid: envelope.chatJid });
	let orch: Awaited<ReturnType<typeof decideV2>>;
	try {
		// Image-generation config currently lives under WhatsApp in the
		// schema — promote-to-shared is on the backlog. Until then, Telegram
		// reads the same slice (parsed through the schema for typed access)
		// so `generateImage` works on both channels.
		const waParsed = WhatsAppChannelSchema.safeParse(
			soulHubConfig.channels?.whatsapp ?? {},
		);
		const imgCfg = waParsed.success ? waParsed.data.img : undefined;
		const ytCfg = waParsed.success ? waParsed.data.youtube : undefined;
		const ttCfg = waParsed.success ? waParsed.data.tiktok : undefined;
		const decideStart = Date.now();
		orch = await decideV2(workingBody, {
			history: ctx.history,
			conversationKey,
			senderNumber: envelope.senderNumber,
			channel: 'telegram',
			account: 'personal',
			timezone: 'Asia/Dubai',
			slowDispatch: {
				jid: envelope.chatJid,
				channel: 'telegram',
				progressMessageId: bubbleIdForSlowDispatch,
				deliver: {
					channel: 'telegram',
					send: (text) => presenceAdapter.send(text),
					edit: (id, text) => presenceAdapter.edit(id, text),
				},
			},
			imgConfig: imgCfg
				? {
						enabled: imgCfg.enabled,
						maxPerDay: imgCfg.maxPerDay,
						systemPromptPath: imgCfg.systemPromptPath,
						model: imgCfg.model,
					}
				: undefined,
			youtubeConfig: ytCfg
				? {
						enabled: ytCfg.enabled,
						maxPerDay: ytCfg.maxPerDay,
						model: ytCfg.model,
					}
				: undefined,
			tiktokConfig: ttCfg
				? {
						enabled: ttCfg.enabled,
						maxPerDay: ttCfg.maxPerDay,
						maxDurationSec: ttCfg.maxDurationSec,
						model: ttCfg.model,
					}
				: undefined,
			// ADR-029 — bubble morphs through tool-execution stages. Same
			// shape as the WhatsApp wire-up; Telegram's editMessageText is
			// the more reliable of the two channels so this rarely fails.
			onStreamEvent: (event) => {
				if (!presence) return;
				if (event.kind === 'tool-call-start') {
					void presence.update(progressTextForTool(event.toolName));
				} else if (event.kind === 'tool-result') {
					const text = event.ok
						? composingTextForTool(event.toolName)
						: `🟡 ${event.toolName} hit an error — composing…`;
					void presence.update(text);
				}
			},
		});
		// Per ADR-023 Phase 1: persist orchestrator-v2's routing decision so
		// the future Claude analyst can mine patterns alongside the WhatsApp
		// router decisions. `decision.action` is the orchestrator's chosen
		// sub-action (web-search / vault-chat / dispatch / image / proposal /
		// reply). `fellThrough=true` is logged inside fallbackToVaultChat
		// with source='fallback'.
		if (!orch.fellThrough) {
			writeIntentDecision({
				ts: Date.now(),
				conversationKey,
				rawMessage: workingBody,
				normalizedSignature: normalizeSignature(workingBody),
				pickedRoute: orch.decision.action,
				source: 'llm',
				confidence: orch.decision.confidence,
				latencyMs: Date.now() - decideStart,
				personaVersion: orch.telemetry?.personaBundleHash,
			});
		}
	} catch (err) {
		console.warn(`[telegram] decideV2 threw: ${(err as Error).message}`);
		await fallbackToVaultChat(envelope, workingBody, conversationKey, config, transcriptionBuffer, presence);
		return;
	}

	if (!orch.fellThrough && orch.v2Output) {
		const out = orch.v2Output;
		const decision = orch.decision;
		saveTurn(conversationKey, 'user', workingBody, turnNow);
		console.log(
			`[telegram/orchestrator] v2 action=${decision.action} v2Output=${out.kind} confidence=${decision.confidence.toFixed(2)}${decision.agent ? ` agent=${decision.agent}` : ''}`,
		);

		if (out.kind === 'image') {
			// Morph the bubble to a brief "generated" then send the media
			// as a separate Telegram message (sendMedia doesn't edit).
			await presence.morph('🟡 Image generated — sending…');
			if (out.text && out.text.trim()) {
				await sendText(envelope.chatJid, out.text, config.delivery);
			}
			await sendMedia(envelope.chatJid, {
				kind: 'image',
				path: out.attachPath,
				caption: out.caption,
			});
			saveTurn(
				conversationKey,
				'assistant',
				`[image] ${out.imagePrompt.slice(0, 120)}`,
				turnNow + 1,
			);
			return;
		}

		if (out.kind === 'dispatch') {
			// Morph the bubble into the dispatch ack so the user sees the
			// same bubble morph from "🟡 Looking…" → "On it — running *X*…".
			const ackText = `On it — running *${out.agentId}*. I'll send the summary here when it's ready (reply *cancel* to stop).`;
			await presence.morph(ackText);
			const agentContext = buildAgentContextBrief(ctx, out.task);
			runInBackground({
				chatId: envelope.chatJid,
				agentId: out.agentId,
				task: out.task,
				sourceMessage: workingBody,
				conversationKey,
				delivery: config.delivery,
				agentContext,
			});
			return;
		}

		if (out.kind === 'slow-dispatched') {
			// ADR-030 v2 — Telegram now wires the slow-dispatch adapter, so
			// the background worker is already running. Morph the bubble to
			// the ack; the worker will edit the same bubble with the final
			// result when the slow tool completes.
			await presence.morph(out.ack);
			saveTurn(conversationKey, 'assistant', out.ack, turnNow + 1);
			return;
		}

		if (out.kind === 'proposal') {
			// Proposal needs an inline keyboard that the presence layer's
			// `finalize` (text-only edit) can't carry. Morph the bubble to
			// a brief lead-in, then send the proposal+keyboard as a fresh
			// message. Two messages on this path — acceptable for v0;
			// future polish: extend edit() to carry reply_markup.
			await presence.morph('🟡 Preparing a proposal…');
			const proposal = getPending(conversationKey);
			if (proposal) {
				saveTurn(conversationKey, 'assistant', formatProposal(proposal), turnNow + 1);
				const messageResult = await sendText(
					envelope.chatJid,
					out.text,
					config.delivery,
					{ replyMarkup: buildProposalKeyboard(conversationKey) },
				);
				if (messageResult.ok && messageResult.messageIds.length > 0) {
					const last = messageResult.messageIds[messageResult.messageIds.length - 1];
					rememberProposalButtons(conversationKey, envelope.chatJid, last);
				}
			} else {
				// Unexpected — orchestrator emitted proposal kind without a
				// row. Send the text plain so the user still sees it.
				saveTurn(conversationKey, 'assistant', out.text, turnNow + 1);
				await sendText(envelope.chatJid, out.text, config.delivery);
			}
			return;
		}

		// ADR-011 — navigate is web-only; guard so TypeScript narrows out.text.
		if (out.kind === 'navigate') {
			console.warn('[telegram/orchestrator] navigate output on non-web channel — ignoring');
			return;
		}

		// kind: 'text' | 'error' — already-formatted text payload.
		// ADR-014: when a youtubeFetch turn produced a summary, attach a
		// follow-up keyboard (Save / Full transcript / Skip).
		const ytCtx = out.kind === 'text' ? out.youtubeContext : undefined;
		saveTurn(conversationKey, 'assistant', out.text, turnNow + 1);
		if (ytCtx) {
			// YouTube turns need the keyboard, which `edit` can't attach.
			// Morph the bubble to brief lead-in, then send fresh with kb.
			await presence.morph('🟡 Composing summary…');
			const sendResult = await sendText(envelope.chatJid, out.text, config.delivery, {
				replyMarkup: buildYoutubeKeyboard(conversationKey),
			});
			if (sendResult.ok && sendResult.messageIds.length > 0) {
				const last = sendResult.messageIds[sendResult.messageIds.length - 1];
				rememberYoutubeButtons({
					conversationKey,
					chatJid: envelope.chatJid,
					senderId: envelope.senderNumber,
					messageId: last,
					videoUrl: ytCtx.videoUrl,
					title: ytCtx.title,
					summary: ytCtx.summary,
				});
			}
		} else {
			// Plain text / error — edit the bubble in place; fall back to a
			// fresh send if the edit fails.
			const edited = await presence.finalize(out.text);
			if (!edited) {
				await sendText(envelope.chatJid, out.text, config.delivery);
			}
		}
		return;
	}

	if (orch.note) {
		console.warn(`[telegram/orchestrator] fell through: ${orch.note}`);
	}

	// 3. Fall through to lexical vault-chat — orchestrator abstained or
	//    didn't produce a usable v2 output. Same presence session covers
	//    the fallback's slow LLM call.
	await fallbackToVaultChat(envelope, workingBody, conversationKey, config, transcriptionBuffer, presence);
	} finally {
		presence.stop();
	}
}

async function fallbackToVaultChat(
	envelope: InboundEnvelope,
	workingBody: string,
	conversationKey: string,
	config: TelegramChannelConfig,
	_transcriptionBuffer: Buffer | undefined,
	presence: PresenceSession,
): Promise<void> {
	const userText = workingBody || '(empty message)';
	// Per ADR-023 Phase 1: log the abstain → vault-chat fallback as a
	// distinct decision source so the analyst can later weigh how often
	// orchestrator-v2 abstains for which kinds of inputs.
	writeIntentDecision({
		ts: Date.now(),
		conversationKey,
		rawMessage: workingBody,
		normalizedSignature: normalizeSignature(workingBody),
		pickedRoute: 'vault-chat',
		source: 'fallback',
		latencyMs: 0,
	});
	let chatMedia:
		| { buffer: Buffer; mimetype: string; kind: TelegramMediaPayload['kind'] }
		| undefined;
	if (
		envelope.media &&
		envelope.media.kind !== 'voice' &&
		envelope.media.kind !== 'sticker'
	) {
		try {
			const dl = await downloadMedia(envelope.media);
			chatMedia = {
				buffer: dl.buffer,
				mimetype: dl.mimetype,
				kind: envelope.media.kind,
			};
		} catch (err) {
			console.warn(
				`[telegram] media download for vault-chat failed: ${(err as Error).message}`,
			);
		}
	}
	// ADR-028 Phase 1 — presence session was started in dispatchOrchestrated
	// before decideV2; its bubble is still on screen. Run the slow LLM call
	// then edit the bubble in place via presence.finalize. On error,
	// presence.finalizeError morphs the bubble into the error text.
	try {
		const result = await dispatchVaultChat(userText, conversationKey, chatMedia);
		const replyText = result.text || '(no reply)';
		if (replyText === '(no reply)') {
			await sendText(envelope.chatJid, replyText, config.delivery);
			return;
		}
		const chunks = chunkText(
			replyText,
			config.delivery.textChunkLimit,
			config.delivery.chunkMode,
		);
		if (chunks.length === 0) {
			await sendText(envelope.chatJid, replyText, config.delivery);
			return;
		}
		const edited = await presence.finalize(chunks[0]);
		if (edited) {
			// First chunk landed via edit; send remaining chunks fresh.
			for (let i = 1; i < chunks.length; i++) {
				await sendText(envelope.chatJid, chunks[i], config.delivery);
			}
		} else {
			// Edit failed (no bubble / edits disabled) — send the full reply
			// fresh so the user always gets the answer.
			await sendText(envelope.chatJid, replyText, config.delivery);
		}
	} catch (err) {
		const message = `Sorry, I hit an error: ${(err as Error).message}`;
		const edited = await presence.finalizeError(message);
		if (!edited) {
			await sendText(envelope.chatJid, message, config.delivery);
		}
	}
}

/** Convenience for outbound media (re-exported for callers that import
 *  via `dispatch.js` rather than `outbound.js`). */
export { sendMedia };
