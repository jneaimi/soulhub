/** Outbound delivery — text chunking, media, edit-in-place, inline
 *  keyboards. Mirrors `whatsapp/outbound.ts` so the dispatcher reads
 *  identically across channels. */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
	editMessageText,
	sendChatAction,
	sendMedia as apiSendMedia,
	sendMessage,
} from './client.js';
import type {
	InlineKeyboardMarkup,
	OutboundMedia,
	TelegramDeliveryConfig,
} from './types.js';

/** Split `text` into chunks ≤ `limit`. Telegram's hard cap on
 *  `sendMessage.text` is 4096; we default to 4000 so Markdown escapes
 *  don't push us over. Newline mode prefers paragraph boundaries. */
export function chunkText(
	text: string,
	limit: number,
	mode: 'newline' | 'hard',
): string[] {
	if (text.length <= limit) return text.length === 0 ? [] : [text];

	if (mode === 'hard') {
		const out: string[] = [];
		for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
		return out;
	}

	const paragraphs = text.split(/\n{2,}/);
	const out: string[] = [];
	let buffer = '';

	const flushBuffer = () => {
		if (buffer.length > 0) {
			out.push(buffer);
			buffer = '';
		}
	};

	for (const para of paragraphs) {
		const candidate = buffer ? `${buffer}\n\n${para}` : para;
		if (candidate.length <= limit) {
			buffer = candidate;
			continue;
		}
		flushBuffer();
		if (para.length <= limit) {
			buffer = para;
		} else {
			for (let i = 0; i < para.length; i += limit) {
				out.push(para.slice(i, i + limit));
			}
		}
	}
	flushBuffer();
	return out;
}

export interface SendTextResult {
	ok: boolean;
	messageIds: number[];
	error?: string;
}

export async function sendText(
	chatId: string | number,
	text: string,
	delivery: TelegramDeliveryConfig,
	opts?: { replyMarkup?: InlineKeyboardMarkup; replyToMessageId?: number },
): Promise<SendTextResult> {
	const chunks = chunkText(text, delivery.textChunkLimit, delivery.chunkMode);
	if (chunks.length === 0) {
		return { ok: false, messageIds: [], error: 'empty body' };
	}

	const ids: number[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const isLast = i === chunks.length - 1;
		const result = await sendMessage({
			chat_id: chatId,
			text: chunks[i],
			parse_mode:
				delivery.parseMode === 'none' ? undefined : delivery.parseMode,
			disable_web_page_preview: true,
			// Inline keyboards only attach to the last chunk so the buttons
			// appear under the final segment of a long reply.
			reply_markup: isLast ? opts?.replyMarkup : undefined,
			reply_to_message_id: i === 0 ? opts?.replyToMessageId : undefined,
		});
		if (!result.ok) {
			// First-pass parse_mode failures are common when LLM output has
			// stray Markdown — retry the failing chunk in plain text so the
			// user still gets the reply.
			if (
				delivery.parseMode !== 'none' &&
				result.description?.toLowerCase().includes("can't parse entities")
			) {
				const retry = await sendMessage({
					chat_id: chatId,
					text: chunks[i],
					disable_web_page_preview: true,
					reply_markup: isLast ? opts?.replyMarkup : undefined,
				});
				if (retry.ok && retry.result) {
					ids.push(retry.result.message_id);
					continue;
				}
				return {
					ok: false,
					messageIds: ids,
					error: retry.error ?? 'send failed',
				};
			}
			return { ok: false, messageIds: ids, error: result.error };
		}
		if (result.result) ids.push(result.result.message_id);
	}
	return { ok: true, messageIds: ids };
}

/** Show "Soul Hub is typing…" under the bot name in the chat. Per ADR-022
 *  Layer A. Auto-clears in ~5s; callers re-fire on a 4s cadence via
 *  `keepTypingUntil`. Best-effort — never block the reply path. */
export async function sendTypingIndicator(chatId: string | number): Promise<void> {
	try {
		await sendChatAction({ chat_id: chatId, action: 'typing' });
	} catch {
		/* swallow — decorative only */
	}
}

/** Edit an existing text message in place. */
export async function editText(
	chatId: string | number,
	messageId: number,
	newText: string,
	parseMode: TelegramDeliveryConfig['parseMode'] = 'Markdown',
	replyMarkup?: InlineKeyboardMarkup,
): Promise<{ ok: boolean; error?: string }> {
	const result = await editMessageText({
		chat_id: chatId,
		message_id: messageId,
		text: newText,
		parse_mode: parseMode === 'none' ? undefined : parseMode,
		reply_markup: replyMarkup,
	});
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true };
}

/** Send a local file as photo/video/audio/voice/document. Reads bytes
 *  off disk and ships via multipart. Audio captions are honoured by
 *  Telegram (unlike WhatsApp), so we keep `media.caption` in all cases. */
export async function sendMedia(
	chatId: string | number,
	media: OutboundMedia,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
	let buffer: Buffer;
	try {
		buffer = await readFile(media.path);
	} catch (err) {
		return { ok: false, error: `read failed: ${(err as Error).message}` };
	}

	const fileName = media.fileName ?? basename(media.path);
	const mimetype = media.mimetype;
	const caption = media.caption?.length ? media.caption : undefined;

	let kind: 'photo' | 'video' | 'audio' | 'voice' | 'document';
	switch (media.kind) {
		case 'image':
			kind = 'photo';
			break;
		case 'video':
			kind = 'video';
			break;
		case 'audio':
			kind = 'audio';
			break;
		case 'voice':
			kind = 'voice';
			break;
		case 'document':
			kind = 'document';
			break;
		case 'sticker':
		default:
			return { ok: false, error: 'sticker outbound not implemented' };
	}

	const result = await apiSendMedia({
		chat_id: chatId,
		kind,
		bytes: buffer,
		fileName,
		mimetype,
		caption,
		parse_mode: 'Markdown',
	});
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true, messageId: result.result?.message_id };
}
