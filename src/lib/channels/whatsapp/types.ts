import type { z } from 'zod';
import type {
	WhatsAppAccessSchema,
	WhatsAppChannelSchema,
	WhatsAppDeliverySchema,
	WhatsAppIntentMapSchema,
	WhatsAppWorkerSchema,
} from '../../config.schema.js';

export type WhatsAppChannelConfig = z.infer<typeof WhatsAppChannelSchema>;
export type WhatsAppAccessConfig = z.infer<typeof WhatsAppAccessSchema>;
export type WhatsAppDeliveryConfig = z.infer<typeof WhatsAppDeliverySchema>;
export type WhatsAppIntentMap = z.infer<typeof WhatsAppIntentMapSchema>;
export type WhatsAppWorkerConfig = z.infer<typeof WhatsAppWorkerSchema>;

/** State machine for the Baileys socket. */
export type ConnectionState =
	| 'disconnected'
	| 'connecting'
	| 'qr-required'
	| 'connected'
	| 'reconnecting'
	| 'logged-out';

export interface ConnectionStatus {
	state: ConnectionState;
	/** Most-recent QR string (raw) when state is `qr-required`. */
	qr?: string;
	/** PNG data URL of the QR — convenient for the settings UI. */
	qrDataUrl?: string;
	/** Linked WhatsApp number (E.164, no leading "+") once connected. */
	linkedNumber?: string;
	/** Last error message — surfaced in status responses for diagnostics. */
	lastError?: string;
	/** Unix ms — when the current state was entered. */
	since: number;
}

/** Normalised inbound envelope — channel-agnostic enough to feed routes. */
export interface InboundEnvelope {
	/** Bare WhatsApp JID, e.g. `9715xxxxxxxx@s.whatsapp.net` or `<id>@g.us`. */
	jid: string;
	/** True when the message was sent in a group chat. */
	isGroup: boolean;
	/** Group JID when `isGroup`; equals `jid` otherwise. Used for replies. */
	chatJid: string;
	/** Bare phone number of the sender in E.164 form (with leading `+`). */
	senderNumber: string;
	/** True when the bot's number was @-mentioned. */
	botMentioned: boolean;
	/** Message text — empty string when only media. Captions populate this
	 *  too, so an image with a caption arrives as `body=<caption>` plus
	 *  `media={kind:'image', ...}`. */
	body: string;
	/** Populated when the inbound message contains media. Lets the
	 *  dispatcher choose to download / transcribe / pass through.
	 *  Caption (if any) is already on `body`. */
	media?: MediaPayload;
	/** Original Baileys message id, useful for ack reactions. */
	messageId: string;
	/** When the sender's primary JID was an opaque LID (`<id>@lid` — WhatsApp's
	 *  privacy form), this carries the original LID. `jid`/`senderNumber`
	 *  reflect the resolved phone-number form when resolution succeeds. */
	lidJid?: string;
}

/** Inbound media metadata — the actual bytes are downloaded on demand
 *  via `downloadMedia(rawMessage)` so envelopes stay small until needed. */
export interface MediaPayload {
	kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
	mimetype: string;
	/** Document filename when present. */
	fileName?: string;
	/** Server-reported file size in bytes — checked against
	 *  `delivery.maxMediaSizeMB` before download. */
	fileLength?: number;
	/** Audio duration (seconds) — only set for audio/voice. */
	durationSeconds?: number;
}

/** Outbound media payload — passed to `sendMedia()` from the channel
 *  registry's `send(message, attachPath)` and from any future route step
 *  that wants to attach a file. The path is local to the Soul Hub host.
 *
 *  `voice` (ADR-006 Phase 2) sends as `audio + ptt: true` so WhatsApp
 *  renders the voice-note bubble. `sticker` is not implemented in
 *  `sendMedia` yet — callers should not pass it. */
export interface OutboundMedia {
	kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
	path: string;
	caption?: string;
	/** Optional override; otherwise inferred from extension. */
	mimetype?: string;
	/** Original filename to surface to the recipient (documents only). */
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
	/** Route name to dispatch — e.g. `vault-chat`, `agent-scribe`, `unknown`. */
	route: string;
	/** Body sent to the route — for slash commands, the arguments after the
	 *  command; for default chat, the full message. */
	body: string;
	/** Original command token when the message started with `/`. */
	command?: string;
	/** Per ADR-023 §Phase 2 — when the dynamic router short-circuits via a
	 *  pattern hit, the pattern's `placeholder_text` lands here so the
	 *  inbound dispatcher can pass it into `presence.bubble(route,
	 *  { patternText })` for topic-specific placeholder text. Undefined for
	 *  every non-pattern dispatch (slash, regex, llm, fallback). */
	patternText?: string;
}
