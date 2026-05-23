/** Inbound media download + on-disk archival. Re-uses the WhatsApp
 *  archival convention (`~/.soul-hub/data/<channel>/<account>/media/<id>`)
 *  so the vault save path doesn't have to know which channel an asset
 *  came from. The bytes are downloaded on demand by the dispatcher (not
 *  during inbound parsing) so denied messages cost zero bandwidth. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { downloadFile } from './client.js';
import type { TelegramMediaPayload } from './types.js';

export interface DownloadedMedia {
	buffer: Buffer;
	mimetype: string;
	fileName?: string;
	filePath?: string;
}

/** Download via the Bot API getFile + file fetch dance. Returns a
 *  buffer ready to feed into Gemini multimodal / route handlers. */
export async function downloadMedia(
	media: TelegramMediaPayload,
): Promise<DownloadedMedia> {
	const result = await downloadFile(media.fileId);
	if (!result.ok || !result.buffer) {
		throw new Error(result.error ?? 'download failed');
	}
	return {
		buffer: result.buffer,
		mimetype: media.mimetype,
		fileName: media.fileName,
		filePath: result.filePath,
	};
}

/** Best-effort archival to disk so a downstream `/save` doesn't have to
 *  re-download. Failures are swallowed by the caller — losing a copy of
 *  the asset is preferable to dropping the user's reply. */
export function saveMediaToDisk(opts: {
	account: string;
	messageId: string;
	payload: TelegramMediaPayload;
	buffer: Buffer;
}): string {
	const baseDir = join(
		homedir(),
		'.soul-hub',
		'data',
		'telegram',
		opts.account,
		'media',
	);
	mkdirSync(baseDir, { recursive: true });
	const ext = guessExtension(opts.payload);
	const fname = `${opts.messageId}-${Date.now()}${ext}`;
	const fullPath = join(baseDir, fname);
	writeFileSync(fullPath, opts.buffer);
	return fullPath;
}

function guessExtension(media: TelegramMediaPayload): string {
	if (media.fileName && media.fileName.includes('.')) {
		const m = media.fileName.match(/\.[a-zA-Z0-9]+$/);
		if (m) return m[0];
	}
	switch (media.mimetype) {
		case 'audio/ogg':
			return '.ogg';
		case 'audio/mpeg':
			return '.mp3';
		case 'audio/wav':
			return '.wav';
		case 'video/mp4':
			return '.mp4';
		case 'image/jpeg':
			return '.jpg';
		case 'image/png':
			return '.png';
		case 'image/webp':
			return '.webp';
		default:
			return '';
	}
}
