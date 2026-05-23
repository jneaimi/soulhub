/** Translate a Telegram `Update` into our channel-blind `InboundEnvelope`.
 *  Mirrors `whatsapp/inbound.ts:buildEnvelope`. We accept either a
 *  `message` or an `edited_message` (treating edits as a fresh prompt
 *  prevents the bot from missing corrections); `channel_post` is dropped
 *  because Soul Hub doesn't currently broadcast channel content. */

import type {
	InboundEnvelope,
	TelegramMediaPayload,
	TgMessage,
	TgMessageEntity,
	TgUpdate,
} from './types.js';

export function buildEnvelope(
	update: TgUpdate,
	botUsername: string | undefined,
	botUserId: number | undefined,
): InboundEnvelope | null {
	const message = update.message ?? update.edited_message;
	if (!message) return null;
	if (!message.chat) return null;

	const chatJid = String(message.chat.id);
	const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
	const senderId = message.from?.id;
	const senderNumber = senderId !== undefined ? String(senderId) : chatJid;

	const text = message.text ?? message.caption ?? '';
	const entities = message.entities ?? message.caption_entities ?? [];

	return {
		chatJid,
		isGroup,
		senderNumber,
		botMentioned: isBotMentioned(text, entities, botUsername, botUserId),
		body: text,
		media: extractMedia(message),
		messageId: String(message.message_id),
		raw: message,
	};
}

function isBotMentioned(
	text: string,
	entities: TgMessageEntity[],
	botUsername: string | undefined,
	botUserId: number | undefined,
): boolean {
	if (!entities.length) return false;
	for (const e of entities) {
		if (e.type === 'mention' && botUsername) {
			const mention = text.slice(e.offset, e.offset + e.length).toLowerCase();
			// `mention` looks like `@username`
			if (mention === `@${botUsername.toLowerCase()}`) return true;
		}
		if (e.type === 'text_mention' && botUserId !== undefined) {
			if (e.user?.id === botUserId) return true;
		}
		// Slash commands in groups always count as addressing the bot when
		// they include the `@username` suffix; they're already routed via
		// intent map so we don't need to also flag botMentioned for them.
	}
	return false;
}

function extractMedia(message: TgMessage): TelegramMediaPayload | undefined {
	if (message.photo && message.photo.length > 0) {
		// Photos are sent as an array of size variants — pick the largest.
		const largest = message.photo.reduce((a, b) => (a.width > b.width ? a : b));
		return {
			kind: 'image',
			mimetype: 'image/jpeg', // Telegram normalises photos to JPEG
			fileId: largest.file_id,
			fileSize: largest.file_size,
		};
	}
	if (message.video) {
		return {
			kind: 'video',
			mimetype: message.video.mime_type ?? 'video/mp4',
			fileId: message.video.file_id,
			fileSize: message.video.file_size,
			durationSeconds: message.video.duration,
		};
	}
	if (message.voice) {
		return {
			kind: 'voice',
			mimetype: message.voice.mime_type ?? 'audio/ogg',
			fileId: message.voice.file_id,
			fileSize: message.voice.file_size,
			durationSeconds: message.voice.duration,
		};
	}
	if (message.audio) {
		return {
			kind: 'audio',
			mimetype: message.audio.mime_type ?? 'audio/mpeg',
			fileId: message.audio.file_id,
			fileSize: message.audio.file_size,
			durationSeconds: message.audio.duration,
			fileName: message.audio.file_name,
		};
	}
	if (message.document) {
		return {
			kind: 'document',
			mimetype: message.document.mime_type ?? 'application/octet-stream',
			fileId: message.document.file_id,
			fileSize: message.document.file_size,
			fileName: message.document.file_name,
		};
	}
	if (message.sticker) {
		return {
			kind: 'sticker',
			mimetype: 'image/webp',
			fileId: message.sticker.file_id,
		};
	}
	return undefined;
}
