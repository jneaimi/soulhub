/** Extract a normalised `InboundEnvelope` from a Baileys
 *  `messages.upsert` event. Handles regular text, captions on media
 *  containers, and populates `envelope.media` for image/video/audio/
 *  voice/document/sticker messages so the dispatcher can choose to
 *  download or transcribe. */

import type { proto } from '@whiskeysockets/baileys';
import type { InboundEnvelope } from './types.js';
import { extractMediaPayload } from './media.js';

/** `5551234567@s.whatsapp.net` → `+5551234567`. Group jids
 *  (`<id>@g.us`) and broadcast jids return empty string. */
export function jidToE164(jid: string | null | undefined): string {
	if (!jid) return '';
	const at = jid.indexOf('@');
	const local = at === -1 ? jid : jid.slice(0, at);
	const digits = local.replace(/[^0-9]/g, '');
	return digits ? `+${digits}` : '';
}

export function isGroupJid(jid: string | null | undefined): boolean {
	return !!jid && jid.endsWith('@g.us');
}

/** True when the JID is WhatsApp's opaque LID (privacy form) rather than
 *  the phone-number form. Important for access control: the LID's leading
 *  digits are not the user's phone number. */
export function isLidJid(jid: string | null | undefined): boolean {
	return !!jid && jid.endsWith('@lid');
}

/** Pull the human-visible text out of a Baileys message envelope. */
function extractText(message: proto.IMessage | null | undefined): string {
	if (!message) return '';
	if (message.conversation) return message.conversation;
	if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
	if (message.imageMessage?.caption) return message.imageMessage.caption;
	if (message.videoMessage?.caption) return message.videoMessage.caption;
	if (message.documentMessage?.caption) return message.documentMessage.caption;
	if (message.documentWithCaptionMessage?.message) {
		return extractText(message.documentWithCaptionMessage.message);
	}
	return '';
}

/** Detect whether the bot was @-mentioned. WhatsApp encodes mentions in
 *  `contextInfo.mentionedJid`; we check membership against every form of
 *  the bot's identity. WhatsApp's privacy layer can encode the mention
 *  against either the bot's phone-number JID (`<phone>@s.whatsapp.net`)
 *  or its LID (`<lid>@lid`) — checking only one misses the other and the
 *  group's `requireMention` gate fails. */
function isBotMentioned(
	message: proto.IMessage | null | undefined,
	botJids: readonly string[],
): boolean {
	if (botJids.length === 0) return false;
	const mentioned = collectMentionedJids(message);
	if (mentioned.length === 0) return false;
	for (const m of mentioned) {
		if (botJids.includes(m)) return true;
	}
	return false;
}

/** Inspect every contextInfo location WhatsApp may put mentions in and
 *  return the union. Exposed for diagnostics so the worker can log the
 *  actual mentioned JIDs when a `requireMention` check fails — the bot's
 *  identity may be encoded under a key we haven't seen before. */
export function collectMentionedJids(message: proto.IMessage | null | undefined): string[] {
	if (!message) return [];
	const ctxs = [
		message.extendedTextMessage?.contextInfo,
		message.imageMessage?.contextInfo,
		message.videoMessage?.contextInfo,
		message.audioMessage?.contextInfo,
		message.documentMessage?.contextInfo,
		message.stickerMessage?.contextInfo,
	];
	const out: string[] = [];
	for (const c of ctxs) {
		const list = c?.mentionedJid;
		if (Array.isArray(list)) for (const j of list) if (typeof j === 'string') out.push(j);
	}
	return out;
}

export function buildEnvelope(
	msg: proto.IWebMessageInfo,
	botJids: string | readonly string[],
): InboundEnvelope | null {
	const botJidArray: readonly string[] = typeof botJids === 'string' ? [botJids].filter(Boolean) : botJids;
	const key = msg.key;
	if (!key) return null;
	const remoteJid = key.remoteJid;
	if (!remoteJid) return null;

	const isGroup = isGroupJid(remoteJid);
	const participantJid = key.participant ?? msg.participant ?? remoteJid;
	let senderJid = isGroup ? participantJid : remoteJid;

	// Sync fast-path for LID resolution: Baileys often surfaces the
	// phone-number JID as `key.remoteJidAlt` (DM) or `key.participantAlt`
	// (group) on the same message, especially after first contact. When the
	// primary JID is `@lid` and the alt is the PN form, prefer the alt so
	// `senderNumber` matches what the user has in their allowlist. The async
	// resolver in `lid-resolve.ts` covers cases where the alt is missing.
	let lidJid: string | undefined;
	const altCandidate = isGroup
		? (key as proto.IMessageKey & { participantAlt?: string }).participantAlt
		: (key as proto.IMessageKey & { remoteJidAlt?: string }).remoteJidAlt;
	if (altCandidate && isLidJid(senderJid) && !isLidJid(altCandidate)) {
		lidJid = senderJid;
		senderJid = altCandidate;
	}

	const media = extractMediaPayload(msg.message);

	return {
		jid: senderJid,
		isGroup,
		chatJid: remoteJid,
		senderNumber: jidToE164(senderJid),
		botMentioned: isBotMentioned(msg.message, botJidArray),
		body: extractText(msg.message),
		media,
		messageId: key.id ?? '',
		lidJid,
	};
}
