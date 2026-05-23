/** Tiny helper: map a file path's extension to an outbound media kind.
 *  Kept separate from `media.ts` (which handles inbound download) so
 *  outbound callers (the adapter's `send(message, attachPath)`) don't
 *  pull in `node:fs` indirection just to choose a Telegram method. */

const EXT_TO_MIME: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	m4a: 'audio/mp4',
	pdf: 'application/pdf',
	json: 'application/json',
	md: 'text/markdown',
	txt: 'text/plain',
};

export function mimeFromPath(path: string): string {
	const lower = path.toLowerCase();
	const m = lower.match(/\.([a-z0-9]+)$/);
	if (!m) return 'application/octet-stream';
	return EXT_TO_MIME[m[1]] ?? 'application/octet-stream';
}

export function kindFromPath(path: string): 'image' | 'video' | 'audio' | 'document' {
	const mime = mimeFromPath(path);
	if (mime.startsWith('image/')) return 'image';
	if (mime.startsWith('video/')) return 'video';
	if (mime.startsWith('audio/')) return 'audio';
	return 'document';
}
