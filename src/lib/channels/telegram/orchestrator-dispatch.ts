/** Background agent dispatch for Telegram.
 *
 *  Mirrors `src/lib/orchestrator/worker.ts:runInBackground` (the WhatsApp
 *  path) but uses Telegram outbound. Both channels share:
 *    - `settleBody` → trailer-aware suppression so artefact-producing
 *      agents (author/scribe/media-creator) don't leak the full cleaned
 *      PTY transcript when they forget the `---CHAT---` marker.
 *    - `extractMediaArtefacts` → channel-agnostic detection of PDFs,
 *      images, videos, audio that the agent saved to disk.
 *    - `terminalLine` → consistent emoji/duration/cost status line.
 *
 *  Telegram differences vs WhatsApp:
 *    - No 60s check-in (Telegram's native delivery receipts make it
 *      unnecessary).
 *    - No capacity gate (single-user app).
 *    - Edits the original ack in place for the terminal status line.
 *
 *  Flow:
 *   1. Send "🟡 Running *agentId*…" ack → capture message_id
 *   2. Run `dispatchAgent` generator
 *   3. On `started` event → register in active-run registry so
 *      cancel-by-message works
 *   4. On terminal status →
 *        a. Edit ack to terminal status line
 *        b. Extract artefacts from output (PDF/image/video/audio)
 *        c. Send body via settleBody (suppressed if artefact + no trailer)
 *        d. Upload each artefact via sendMedia (caption on first
 *           image/video where the body fits)
 *        e. If no artefacts but vault path detected → append vault URL */

import { dispatchAgent } from '../../agents/dispatch/index.js';
import { setActive, clearActive } from '../../orchestrator/active-runs.js';
import {
	extractMediaArtefacts,
	pickCaptionTarget,
	CAPTION_LIMIT_CHARS,
} from '../../orchestrator/media-output.js';
import { settleBody, terminalLine } from '../../orchestrator/settle.js';
import { extractVaultPath } from '../../conversation/index.js';
import { editText, sendMedia, sendText } from './outbound.js';
import type { TelegramDeliveryConfig } from './types.js';

interface DispatchArgs {
	chatId: string;
	agentId: string;
	task: string;
	sourceMessage: string;
	conversationKey: string;
	delivery: TelegramDeliveryConfig;
	agentContext?: string;
}

/** Render a clickable vault URL for a vault-relative path. Returns null
 *  if `SOUL_HUB_PUBLIC_URL` is not configured. Mirrors the helper in
 *  `worker.ts` — kept local because it's two lines and pulling it out
 *  would couple the channels through another module. */
function vaultUrl(vaultRelPath: string): string | null {
	const base = (process.env.SOUL_HUB_PUBLIC_URL ?? '').replace(/\/$/, '');
	if (!base) return null;
	return `${base}/vault?note=${encodeURIComponent(vaultRelPath)}`;
}

/** Fire-and-forget — caller must not await. The promise is intentionally
 *  detached so any error caught inside this function surfaces as a
 *  best-effort message back to the chat rather than throwing into the
 *  webhook handler's response loop. */
export function runInBackground(args: DispatchArgs): void {
	const {
		chatId,
		agentId,
		task,
		sourceMessage,
		delivery,
		agentContext,
	} = args;

	const controller = new AbortController();
	const startedAt = Date.now();
	let registered = false;
	let registeredRunId = '';
	let ackMessageId: number | null = null;

	void (async () => {
		// 1. Initial ack — capture messageId for later edits.
		const ack = await sendText(
			chatId,
			`🟡 Running *${agentId}*…\nReply *cancel* to stop.`,
			delivery,
		);
		if (ack.ok && ack.messageIds.length > 0) {
			ackMessageId = ack.messageIds[0];
		}

		const generator = dispatchAgent(agentId, task, {
			jid: chatId,
			sourceMessage,
			signal: controller.signal,
			mode: 'production',
			context: agentContext,
		});

		try {
			let next = await generator.next();
			while (!next.done) {
				const event = next.value;
				if (event.type === 'started') {
					registeredRunId = event.runId;
					setActive({
						runId: registeredRunId,
						agentId,
						jid: chatId,
						startedAt,
						abortController: controller,
					});
					registered = true;
				}
				next = await generator.next();
			}

			const result = next.value;
			const status = terminalLine(agentId, result);

			// (a) Edit the ack to the terminal status line. Edit failure
			// shouldn't block delivery — fall back to a fresh send.
			if (ackMessageId) {
				const edited = await editText(chatId, ackMessageId, status, delivery.parseMode).catch(
					(err) => {
						console.warn(
							`[telegram/orchestrator] settle-status-edit failed: ${(err as Error).message}`,
						);
						return null;
					},
				);
				if (!edited) {
					await sendText(chatId, status, delivery).catch(() => {});
				}
			} else {
				await sendText(chatId, status, delivery).catch(() => {});
			}

			// Cancel: status edit is the whole story. Skip body/artefacts.
			if (result.status === 'cancelled') return;

			// (b) Extract artefacts. Channel-agnostic — same detection the
			// WhatsApp worker uses.
			const artefacts =
				result.status === 'success' && result.output
					? extractMediaArtefacts(result.output)
					: [];

			// (c) Compute the chat body. settleBody suppresses raw output
			// when artefacts are present and the agent forgot its trailer
			// — the file is the deliverable, not the transcript.
			const body = settleBody(result, artefacts.length);

			// (d) Artefact path: upload each as a Telegram media message.
			// Caption goes on the first image/video where it fits; otherwise
			// the body is sent as a separate text message first.
			if (artefacts.length > 0) {
				const captionIdx = pickCaptionTarget(artefacts);
				const captionFits = body.length > 0 && body.length <= CAPTION_LIMIT_CHARS;

				if (body.length > 0 && (!captionFits || captionIdx === -1)) {
					await sendText(chatId, body, delivery).catch((err) => {
						console.error(
							`[telegram/orchestrator] settle-body-send failed: ${(err as Error).message}`,
						);
					});
				}

				for (let i = 0; i < artefacts.length; i++) {
					const a = artefacts[i];
					const useCaption = i === captionIdx && captionFits && captionIdx !== -1;
					await sendMedia(chatId, {
						kind: a.kind,
						path: a.path,
						caption: useCaption ? body : undefined,
					}).catch((err) => {
						console.error(
							`[telegram/orchestrator] media-send failed (${a.kind}): ${(err as Error).message}`,
						);
					});
				}
				return;
			}

			// (e) No artefacts: send the body, then a vault-link follow-up
			// if the agent reported saving a note.
			if (body.length > 0) {
				await sendText(chatId, body, delivery).catch((err) => {
					console.error(
						`[telegram/orchestrator] settle-body-send failed: ${(err as Error).message}`,
					);
				});
			}

			if (result.status === 'success' && result.output) {
				const path = extractVaultPath(result.output);
				const url = path ? vaultUrl(path) : null;
				if (url) {
					await sendText(chatId, `📄 Full report: ${url}`, delivery).catch((err) => {
						console.warn(
							`[telegram/orchestrator] vault-link send failed: ${(err as Error).message}`,
						);
					});
				}
			}
		} catch (err) {
			const message = (err as Error).message;
			console.warn(`[telegram/orchestrator] dispatch threw: ${message}`);
			if (ackMessageId) {
				await editText(
					chatId,
					ackMessageId,
					`❌ *${agentId}* errored: ${message.slice(0, 240)}`,
					delivery.parseMode,
				).catch(() => {});
			} else {
				await sendText(chatId, `❌ *${agentId}* errored: ${message.slice(0, 240)}`, delivery).catch(
					() => {},
				);
			}
		} finally {
			if (registered) {
				clearActive(registeredRunId);
			}
		}
	})();
}
