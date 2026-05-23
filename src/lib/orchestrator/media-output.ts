/** Extract media artefact paths from a settled agent's stdout, classify
 *  each one (image / video / audio / voice), and apply size guards.
 *
 *  Used by `worker.ts:settleRun` after a `media-generator` (or other
 *  media-producing) agent finishes — turns the agent's prose output into
 *  a list of files the worker can `sendMedia` back to WhatsApp.
 *
 *  Detection layers (oldest-first; first match wins per file path):
 *    1. `Saved to: <path>` lines — the canonical agent contract.
 *    2. Standalone path lines under `~/generated_media/` or
 *       `~/vault/operations/claude-soul/media-library/…` — the two
 *       directories the media-generator / media-creator scripts use.
 *
 *  Size + kind classification:
 *    - Extension routes the kind. Audio gets a sidecar lookup
 *      (`<path>.meta.json` `type: "voice"`) to flip to voice notes
 *      (rendered with `ptt: true` and the WhatsApp voice bubble).
 *    - Video files >60MB are dropped (WhatsApp's per-message cap is 64MB;
 *      we leave headroom for Baileys' encryption overhead).
 *    - Image files >15MB are dropped (cap is 16MB).
 *    - Audio >15MB dropped (cap is 16MB).
 *
 *  Cap of 5 artefacts per run keeps a runaway carousel from spamming
 *  the chat. Beyond 5, the rest are silently dropped (the agent's chat
 *  trailer should reference the vault path so the user can still see
 *  the full set). */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

export type MediaKind = 'image' | 'video' | 'audio' | 'voice' | 'document';

export interface MediaArtefact {
	kind: MediaKind;
	path: string;
	bytes: number;
}

const MAX_ARTEFACTS = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024; // WhatsApp doc cap is ~95MB; leave headroom

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|opus|aac|flac)$/i;
const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|epub)$/i;

/** `Saved to:` recognises both vault-relative ("knowledge/research/…")
 *  and absolute ("/Users/…") paths; we normalise below. */
const SAVED_TO_RE = /^[\s>*-]*Saved\s*to:\s*([^\s].*?)\s*$/gim;

/** `PDF: <abs-path>` recognises katib document outputs (the author agent
 *  emits one or two of these per render). Author's contract is documented
 *  in `~/.claude/agents/author.md`. */
const PDF_LABEL_RE = /^[\s>*-]*PDF\s*(?:\([^)]*\))?\s*:\s*([^\s].*?\.pdf)\s*$/gim;

/** Standalone path detection — for cases where the agent emits a path
 *  on its own line (e.g. `~/generated_media/foo.png` in a markdown
 *  bullet). Anchored to known media root prefixes only, to avoid
 *  swallowing arbitrary file references in agent prose. */
const KNOWN_PATH_RE = new RegExp(
	String.raw`(?:^|\s)((?:~|/Users/[^/\s]+|/home/[^/\s]+)?(?:/?generated_media/|/?vault/operations/claude-soul/media-library/|/?Documents/katib/)[^\s]+\.[a-z0-9]{2,5})`,
	'gmi',
);

function expandHome(path: string): string {
	if (path.startsWith('~')) return resolvePath(homedir(), path.slice(2));
	return resolvePath(path);
}

function classifyKind(path: string): MediaKind | null {
	if (IMAGE_EXT.test(path)) return 'image';
	if (VIDEO_EXT.test(path)) return 'video';
	if (DOCUMENT_EXT.test(path)) return 'document';
	if (!AUDIO_EXT.test(path)) return null;
	// Audio: peek at the sidecar to distinguish music-style audio from
	// voice notes. media-generator's `voice` command writes `type: "voice"`
	// in the .meta.json. Missing sidecar → fall back to plain audio.
	try {
		const sidecar = `${path}.meta.json`;
		const meta = JSON.parse(readFileSync(sidecar, 'utf-8')) as { type?: string };
		if (meta.type === 'voice') return 'voice';
	} catch {
		/* sidecar missing or unparseable — treat as plain audio */
	}
	return 'audio';
}

function withinSizeCap(kind: MediaKind, bytes: number): boolean {
	switch (kind) {
		case 'image':
			return bytes <= MAX_IMAGE_BYTES;
		case 'video':
			return bytes <= MAX_VIDEO_BYTES;
		case 'audio':
		case 'voice':
			return bytes <= MAX_AUDIO_BYTES;
		case 'document':
			return bytes <= MAX_DOCUMENT_BYTES;
	}
}

/** Walk the agent's raw output, harvest media paths, classify, and
 *  return the deliverable list. Order preserved from first appearance
 *  in the output. Duplicates filtered. */
export function extractMediaArtefacts(rawOutput: string): MediaArtefact[] {
	if (!rawOutput) return [];
	const seen = new Set<string>();
	const out: MediaArtefact[] = [];

	const candidates: string[] = [];
	for (const m of rawOutput.matchAll(SAVED_TO_RE)) {
		if (m[1]) candidates.push(m[1]);
	}
	for (const m of rawOutput.matchAll(PDF_LABEL_RE)) {
		if (m[1]) candidates.push(m[1]);
	}
	for (const m of rawOutput.matchAll(KNOWN_PATH_RE)) {
		if (m[1]) candidates.push(m[1]);
	}

	for (const raw of candidates) {
		const path = expandHome(raw);
		if (seen.has(path)) continue;
		seen.add(path);
		if (!existsSync(path)) continue;
		const kind = classifyKind(path);
		if (!kind) continue;
		let bytes: number;
		try {
			bytes = statSync(path).size;
		} catch {
			continue;
		}
		if (!withinSizeCap(kind, bytes)) continue;
		out.push({ kind, path, bytes });
		if (out.length >= MAX_ARTEFACTS) break;
	}

	return out;
}

/** Pick which artefact (if any) should carry the chat-trailer summary
 *  as a caption. Captions render on image / video / document — audio
 *  shapes don't accept them. Returns `-1` when no caption target exists,
 *  in which case the caller sends the body as a separate text message. */
export function pickCaptionTarget(artefacts: MediaArtefact[]): number {
	return artefacts.findIndex(
		(a) => a.kind === 'image' || a.kind === 'video' || a.kind === 'document',
	);
}

/** WhatsApp caption length cap (varies by client; 1024 is the
 *  conservative figure most Baileys-based bots use). Bodies longer than
 *  this should be sent as a separate text message rather than crammed
 *  into a caption. */
export const CAPTION_LIMIT_CHARS = 1024;
