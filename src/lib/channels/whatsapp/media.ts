/** Inbound media handling for the WhatsApp channel. Three concerns:
 *
 *   1. `extractMediaPayload(message)` — pulls metadata out of the Baileys
 *      message envelope without touching the network. Cheap; called for
 *      every inbound message so the dispatcher can decide whether to
 *      download, transcribe, or pass through.
 *
 *   2. `downloadMedia(rawMessage, kind)` — fetches the encrypted bytes
 *      from WhatsApp's CDN and decrypts them. Returns a Buffer because
 *      the transcription path and the disk-save path both want random
 *      access; voice notes are small enough that streaming isn't worth
 *      the complexity at this stage.
 *
 *   3. `saveMediaToDisk(envelope, payload, buffer, account)` — writes to
 *      `~/.soul-hub/data/whatsapp/<account>/incoming/<id>.<ext>` (mode
 *      0700) and returns the absolute path. Useful for the future
 *      media-creator agent and for letting users archive attachments. */

import { downloadMediaMessage, type proto, type WAMessage } from '@whiskeysockets/baileys';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { soulHubDataDir } from '../../paths.js';
import type { MediaPayload } from './types.js';

type MediaKind = MediaPayload['kind'];

const MIME_TO_EXT: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'video/mp4': 'mp4',
	'video/3gpp': '3gp',
	'audio/ogg; codecs=opus': 'ogg',
	'audio/ogg': 'ogg',
	'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a',
	'audio/wav': 'wav',
	'application/pdf': 'pdf',
	'application/zip': 'zip',
	'application/msword': 'doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

function extForMime(mime: string | null | undefined, fallback = 'bin'): string {
	if (!mime) return fallback;
	const lower = mime.toLowerCase();
	if (MIME_TO_EXT[lower]) return MIME_TO_EXT[lower];
	const slash = lower.indexOf('/');
	if (slash !== -1) {
		const sub = lower.slice(slash + 1).split(';', 1)[0].trim();
		return sub || fallback;
	}
	return fallback;
}

/** Inspect a Baileys message envelope and return a `MediaPayload` when it
 *  carries media. Returns `undefined` for plain text. Voice notes are
 *  audio messages with `ptt: true` — distinguished from arbitrary audio
 *  so the dispatcher can apply the transcription policy precisely. */
export function extractMediaPayload(
	message: proto.IMessage | null | undefined,
): MediaPayload | undefined {
	if (!message) return undefined;

	if (message.imageMessage) {
		return {
			kind: 'image',
			mimetype: message.imageMessage.mimetype ?? 'image/jpeg',
			fileLength: numberFromLong(message.imageMessage.fileLength),
		};
	}
	if (message.videoMessage) {
		return {
			kind: 'video',
			mimetype: message.videoMessage.mimetype ?? 'video/mp4',
			fileLength: numberFromLong(message.videoMessage.fileLength),
			durationSeconds: message.videoMessage.seconds ?? undefined,
		};
	}
	if (message.audioMessage) {
		const isVoice = !!message.audioMessage.ptt;
		return {
			kind: isVoice ? 'voice' : 'audio',
			mimetype: message.audioMessage.mimetype ?? 'audio/ogg; codecs=opus',
			fileLength: numberFromLong(message.audioMessage.fileLength),
			durationSeconds: message.audioMessage.seconds ?? undefined,
		};
	}
	if (message.documentMessage) {
		return {
			kind: 'document',
			mimetype: message.documentMessage.mimetype ?? 'application/octet-stream',
			fileName: message.documentMessage.fileName ?? undefined,
			fileLength: numberFromLong(message.documentMessage.fileLength),
		};
	}
	if (message.documentWithCaptionMessage?.message) {
		return extractMediaPayload(message.documentWithCaptionMessage.message);
	}
	if (message.stickerMessage) {
		return {
			kind: 'sticker',
			mimetype: message.stickerMessage.mimetype ?? 'image/webp',
			fileLength: numberFromLong(message.stickerMessage.fileLength),
		};
	}
	return undefined;
}

function numberFromLong(value: unknown): number | undefined {
	if (value == null) return undefined;
	if (typeof value === 'number') return value;
	if (typeof value === 'string') {
		const n = Number(value);
		return Number.isFinite(n) ? n : undefined;
	}
	if (typeof value === 'object' && value !== null && 'low' in value && 'high' in value) {
		// Baileys uses Long for 64-bit ints; for our size guard the low word
		// is plenty (16MB cap fits in 24 bits).
		return Number((value as { low: number }).low);
	}
	return undefined;
}

/** Download the media bytes and return a Buffer. Throws on network /
 *  decryption failure — caller should `try/catch` and degrade gracefully
 *  (skip transcription, surface a friendly error to the user). The cast
 *  to `WAMessage` is safe because the dispatcher only invokes this for
 *  envelopes that came out of `messages.upsert`, which always carry a
 *  populated `key`. */
export async function downloadMedia(
	rawMessage: proto.IWebMessageInfo,
): Promise<Buffer> {
	return await downloadMediaMessage(rawMessage as WAMessage, 'buffer', {});
}

/** Persist the buffer under `~/.soul-hub/data/whatsapp/<account>/incoming/`.
 *  Filename is `<messageId>.<ext>` so the same upload always lands on the
 *  same path (helpful for retry-after-failure). Returns the absolute path. */
export function saveMediaToDisk(opts: {
	account: string;
	messageId: string;
	payload: MediaPayload;
	buffer: Buffer;
}): string {
	const dir = resolve(soulHubDataDir(), 'whatsapp', opts.account, 'incoming');
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const ext = extForMime(opts.payload.mimetype);
	const safeId = opts.messageId.replace(/[^A-Za-z0-9_-]/g, '_') || 'msg';
	const path = resolve(dir, `${safeId}.${ext}`);
	writeFileSync(path, opts.buffer, { mode: 0o600 });
	return path;
}

/** Best-effort mime guess from a path's extension. Used by the outbound
 *  send path when callers pass `attachPath` without an explicit mimetype. */
export function mimeFromPath(path: string): string {
	const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
	const ext = m?.[1] ?? '';
	switch (ext) {
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'png':
			return 'image/png';
		case 'webp':
			return 'image/webp';
		case 'gif':
			return 'image/gif';
		case 'mp4':
			return 'video/mp4';
		case '3gp':
			return 'video/3gpp';
		case 'mp3':
			return 'audio/mpeg';
		case 'm4a':
			return 'audio/mp4';
		case 'ogg':
		case 'opus':
			return 'audio/ogg';
		case 'wav':
			return 'audio/wav';
		case 'pdf':
			return 'application/pdf';
		default:
			return 'application/octet-stream';
	}
}

/** Map a path extension to the outbound media kind. Used by the adapter
 *  to dispatch `attachPath` to the right Baileys send shape. */
export function kindFromPath(path: string): 'image' | 'video' | 'audio' | 'document' {
	const mime = mimeFromPath(path);
	if (mime.startsWith('image/')) return 'image';
	if (mime.startsWith('video/')) return 'video';
	if (mime.startsWith('audio/')) return 'audio';
	return 'document';
}
