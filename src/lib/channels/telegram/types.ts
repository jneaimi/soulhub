import type { z } from 'zod';
import type {
	TelegramAccessSchema,
	TelegramChannelSchema,
	TelegramDeliverySchema,
	TelegramIntentMapSchema,
	TelegramWebhookSchema,
} from '../../config.schema.js';

export type TelegramChannelConfig = z.infer<typeof TelegramChannelSchema>;
export type TelegramAccessConfig = z.infer<typeof TelegramAccessSchema>;
export type TelegramDeliveryConfig = z.infer<typeof TelegramDeliverySchema>;
export type TelegramIntentMap = z.infer<typeof TelegramIntentMapSchema>;
export type TelegramWebhookConfig = z.infer<typeof TelegramWebhookSchema>;

/** Subset of the Telegram Bot API `Update` shape Soul Hub cares about.
 *  The full type is enormous; we only annotate the fields the dispatcher
 *  reads. Webhook payloads we don't recognise are dropped silently. */
export interface TgUpdate {
	update_id: number;
	message?: TgMessage;
	edited_message?: TgMessage;
	channel_post?: TgMessage;
	callback_query?: TgCallbackQuery;
}

export interface TgMessage {
	message_id: number;
	from?: TgUser;
	chat: TgChat;
	date: number;
	text?: string;
	caption?: string;
	entities?: TgMessageEntity[];
	caption_entities?: TgMessageEntity[];
	reply_to_message?: TgMessage;
	photo?: TgPhotoSize[];
	video?: TgVideo;
	audio?: TgAudio;
	voice?: TgVoice;
	document?: TgDocument;
	sticker?: { file_id: string };
	via_bot?: TgUser;
}

export interface TgUser {
	id: number;
	is_bot: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
	language_code?: string;
}

export interface TgChat {
	id: number;
	type: 'private' | 'group' | 'supergroup' | 'channel';
	title?: string;
	username?: string;
}

export interface TgMessageEntity {
	type: string; // 'mention' | 'bot_command' | 'text_mention' | …
	offset: number;
	length: number;
	user?: TgUser;
}

export interface TgPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TgVideo {
	file_id: string;
	file_unique_id: string;
	mime_type?: string;
	duration: number;
	file_size?: number;
}

export interface TgAudio {
	file_id: string;
	file_unique_id: string;
	mime_type?: string;
	duration: number;
	file_size?: number;
	file_name?: string;
}

export interface TgVoice {
	file_id: string;
	file_unique_id: string;
	mime_type?: string;
	duration: number;
	file_size?: number;
}

export interface TgDocument {
	file_id: string;
	file_unique_id: string;
	mime_type?: string;
	file_name?: string;
	file_size?: number;
}

export interface TgCallbackQuery {
	id: string;
	from: TgUser;
	message?: TgMessage;
	chat_instance: string;
	data?: string;
}

/** Normalised inbound envelope — same shape as the WhatsApp module so
 *  downstream consumers (orchestrator-v2, vault-chat, routes) treat both
 *  channels identically. The `tg:` prefix is applied to `conversationKey`
 *  by the dispatcher, NOT here. */
export interface InboundEnvelope {
	/** Stable string id for the chat ("123456789" for DM, "-100123…" for group). */
	chatJid: string;
	/** True when the source chat is a group/supergroup. */
	isGroup: boolean;
	/** Stable string id for the sender (Telegram user_id). Equal to `chatJid` for DMs. */
	senderNumber: string;
	/** True when the bot's @username was mentioned in the message. */
	botMentioned: boolean;
	/** Message body — caption when there's media, otherwise text. */
	body: string;
	/** Inbound media metadata (file_id + size); bytes downloaded on demand. */
	media?: TelegramMediaPayload;
	/** Telegram message_id, used for editing/replying. */
	messageId: string;
	/** Original Update for downstream tools that need richer fields. */
	raw: TgMessage;
}

export interface TelegramMediaPayload {
	kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
	mimetype: string;
	fileId: string;
	fileSize?: number;
	durationSeconds?: number;
	fileName?: string;
}

export type AccessDecision =
	| { allow: true }
	| { allow: false; reason: AccessDenyReason };

export type AccessDenyReason =
	| 'dm-disabled'
	| 'dm-not-allowlisted'
	| 'group-disabled'
	| 'group-not-allowlisted'
	| 'group-sender-not-allowlisted'
	| 'mention-required';

export interface ResolvedIntent {
	route: string;
	body: string;
	command?: string;
}

/** Outbound media — analogous to WhatsApp's `OutboundMedia`. Telegram has
 *  no `voice` distinct from `audio` for outbound (we'd send via
 *  `sendVoice`); shape kept identical for cross-channel ergonomics. */
export interface OutboundMedia {
	kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
	path: string;
	caption?: string;
	mimetype?: string;
	fileName?: string;
}

export interface InlineKeyboardButton {
	text: string;
	callback_data?: string;
	url?: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}

export interface BotInfo {
	id: number;
	username?: string;
	first_name?: string;
}
