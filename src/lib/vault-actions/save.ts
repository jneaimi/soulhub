/** `/save` handler — turns a WhatsApp message + optional decoded media
 *  buffer into a vault note (and a sibling asset file when the message
 *  carries non-text media). Hard-coded to the `whatsapp-brain` agent
 *  slot so writes are rate-limited and audited.
 *
 *  Contract:
 *    - Text-only:     write a note in `inbox/` with the typed body.
 *    - Voice:         body is the upstream transcript; archive the audio
 *                     under `inbox/assets/` and reference it via
 *                     `attachments[]`. No second LLM call.
 *    - Image/video/
 *      document:      single Gemini Flash extraction pass produces a
 *                     `vision_caption` / `summary` / `transcript` per
 *                     modality. Asset archived; extracted fields land in
 *                     frontmatter and the note body.
 *
 *  Type prefix syntax (case-insensitive, optional): `idea: …`,
 *  `recipe: …`, `learning: …`. Bare body → `draft` + `idea` tag (the
 *  inbox zone's allowlist doesn't include `idea` as a type, so we
 *  represent it as a tag instead). */

import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { getVaultEngine } from '../vault/index.js';
import type { InboundEnvelope, MediaPayload } from '../channels/whatsapp/types.js';

type VaultMediaKind = MediaPayload['kind'];

const PUBLIC_URL = process.env.SOUL_HUB_PUBLIC_URL || 'http://localhost:2400';
// ADR-028 P3 — kept as `whatsapp-brain` for backwards compatibility.
// Hundreds of vault notes already carry this agent slug in their
// frontmatter; renaming would create asymmetry across the historical
// archive without semantic value. The rest of the surface uses the
// "Soul Hub vault" terminology, but persisted identifiers stay stable.
const AGENT = 'whatsapp-brain';

export interface VaultSaveNoteInput {
	envelope: InboundEnvelope;
	/** The body the dispatcher already resolved (caption text for media,
	 *  transcript for voice, or the typed message for text). */
	workingBody: string;
	/** Decoded media bytes when present. Voice notes always carry one;
	 *  images/videos/documents only carry one when the dispatcher chose
	 *  to download them (in-process mode) or the worker piggybacked them
	 *  via `mediaBase64`. */
	mediaBuffer?: Buffer;
	mimetype?: string;
	mediaKind?: VaultMediaKind;
	/** Slice 6 — `/img` cache fallback. When the user runs `/save` after
	 *  an `/img` (no fresh attachment), the dispatcher passes the cached
	 *  generated image here so it gets archived like any other capture.
	 *  A real inbound attachment (`mediaBuffer`) takes precedence — the
	 *  user clearly wants to save what they just sent, not the bot's
	 *  last output. */
	cachedImage?: { buffer: Buffer; mimetype: string; prompt: string };
}

export interface VaultSaveNoteResult {
	text: string;
	notePath?: string;
	assetPath?: string;
}

/** Flat-optional Output schema per `feedback_ai_sdk_v6_structured_output`
 *  — Gemini's controlled generation rejects discriminated unions. Each
 *  field is optional so the model can fill what it sees. */
const ExtractionSchema = z.object({
	title: z.string().describe('A short, specific title (≤ 12 words). Pull from the caption when one fits; otherwise summarise the asset.').optional(),
	vision_caption: z.string().describe('One- or two-sentence factual description of what is visible in the image. Image only.').optional(),
	summary: z.string().describe('Three- to five-sentence narrative summary covering the asset content. Video and document modalities.').optional(),
	transcript: z.string().describe('Verbatim spoken-word transcript when audio is present in a video. Skip if silent.').optional(),
	visual_description: z.string().describe('Scene/composition description for video frames (people, setting, action).').optional(),
	tags: z.array(z.string()).describe('3–6 short kebab-case tags drawn from the asset content. Lowercase, no leading "#".').optional(),
	duration_estimate_seconds: z.number().describe('Rough duration estimate for video/audio assets, in seconds.').optional(),
});

type ExtractionOutput = z.infer<typeof ExtractionSchema>;

/** Per-modality prompts. `voice` and `audio` skip the call entirely
 *  because the upstream transcribe pass already produced text. `sticker`
 *  also skips — stickers are emoji-shaped, no useful structured output. */
const EXTRACTION_PROMPTS: Partial<Record<VaultMediaKind, string>> = {
	image:
		'Extract a structured note from this image. Fill `title`, `vision_caption`, and `tags`. Keep the caption factual — no flowery language. If a caption was provided alongside the image, use it to bias the title and tags.',
	video:
		'Extract a structured note from this video. Fill `title`, `summary`, `visual_description`, `transcript` (when speech is present), `duration_estimate_seconds`, and `tags`. Keep the summary tight (3–5 sentences).',
	document:
		'Extract a structured note from this document. Fill `title`, `summary`, and `tags`. Surface the key claim, the audience, and any actionable bits.',
};

function shouldSkipExtraction(kind: VaultMediaKind): boolean {
	return kind === 'voice' || kind === 'audio' || kind === 'sticker';
}

/** Run the multimodal extraction call. Returns `{}` on any failure so
 *  callers can fall back to plain-body save without surfacing an error
 *  to the user. The caller decides what's worth surfacing. */
async function extractFromMedia(
	buffer: Buffer,
	mimetype: string,
	kind: VaultMediaKind,
	caption: string,
): Promise<ExtractionOutput> {
	if (shouldSkipExtraction(kind)) return {};
	const promptBase = EXTRACTION_PROMPTS[kind];
	if (!promptBase) return {};

	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) return {};

	const client = createGoogleGenerativeAI({ apiKey });
	const cleanMime = mimetype.split(';')[0].trim() || 'application/octet-stream';

	const promptWithCaption = caption.trim()
		? `${promptBase}\n\nCaption supplied by user: ${caption.trim()}`
		: promptBase;

	try {
		const result = await generateText({
			model: client('gemini-2.5-flash'),
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: promptWithCaption },
						{ type: 'file', mediaType: cleanMime, data: buffer },
					],
				},
			],
			output: Output.object({ schema: ExtractionSchema }),
			maxOutputTokens: 1500,
			providerOptions: {
				google: {
					thinkingConfig: { thinkingBudget: 0 },
				},
			},
		});
		return result.output ?? {};
	} catch {
		return {};
	}
}

/** Slug a string into a filesystem-safe filename stem. Falls back to
 *  `note` when no characters survive normalization. */
function slugify(input: string): string {
	const normalized = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '') // strip combining marks
		.replace(/[^a-z0-9\s-]/g, ' ')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	const truncated = normalized.slice(0, 60).replace(/-+$/, '');
	return truncated || 'note';
}

/** Strip a leading type prefix (`idea: foo` → `{type: 'draft', tag: 'idea', body: 'foo'}`).
 *  Match is case-insensitive; the prefix and trailing whitespace are
 *  removed from the body. Bare bodies default to `draft + idea` since
 *  the spec frames `/save` as idea capture by default. */
function extractTypeFromPrefix(body: string): { type: string; tag?: string; body: string } {
	const match = body.match(/^\s*(idea|recipe|learning)\s*:\s*/i);
	if (!match) {
		return { type: 'draft', tag: 'idea', body: body.trim() };
	}
	const word = match[1].toLowerCase();
	const trimmed = body.slice(match[0].length).trim();
	if (word === 'idea') return { type: 'draft', tag: 'idea', body: trimmed };
	if (word === 'recipe') return { type: 'recipe', body: trimmed };
	return { type: 'learning', body: trimmed };
}

/** Pick a title for the note. Preference order: extracted title (if a
 *  multimodal extraction ran) → first sentence of body → first 60 chars
 *  of body → fallback "WhatsApp capture". */
function pickTitle(extracted: ExtractionOutput, body: string): string {
	if (extracted.title?.trim()) return extracted.title.trim();
	const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
	if (firstLine) {
		const sentence = firstLine.split(/(?<=[.!?])\s/)[0];
		if (sentence && sentence.length <= 80) return sentence;
		return firstLine.slice(0, 60);
	}
	return 'WhatsApp capture';
}

/** Build the markdown body. Front-loads any extracted fields (caption,
 *  summary, transcript) above the user-typed body so the note reads
 *  top-down: what the asset shows, then what the user said about it. */
function buildBody(extracted: ExtractionOutput, userBody: string): string {
	const sections: string[] = [];
	if (extracted.vision_caption?.trim()) sections.push(`**Vision caption:** ${extracted.vision_caption.trim()}`);
	if (extracted.summary?.trim()) sections.push(`**Summary:** ${extracted.summary.trim()}`);
	if (extracted.visual_description?.trim()) sections.push(`**Visual description:** ${extracted.visual_description.trim()}`);
	if (extracted.transcript?.trim()) sections.push(`**Transcript:**\n\n${extracted.transcript.trim()}`);
	if (userBody.trim()) sections.push(userBody.trim());
	if (sections.length === 0) sections.push('_(empty capture)_');
	return sections.join('\n\n');
}

function noteOpenUrl(path: string): string {
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${PUBLIC_URL}/vault?note=${encoded}&view=note`;
}

/** Map a media kind to its asset filename extension when the source
 *  mimetype doesn't have an obvious one. Conservative defaults — the
 *  vault prefers a real extension over `.bin`. */
function pickAssetExtension(mimetype: string, kind: VaultSaveNoteInput['mediaKind']): string {
	const sub = mimetype.split('/')[1]?.split(';')[0]?.trim();
	if (sub) {
		// `image/jpeg` → `.jpg`; `audio/ogg` → `.ogg`; `application/pdf` → `.pdf`
		if (sub === 'jpeg') return '.jpg';
		if (sub === 'svg+xml') return '.svg';
		if (sub === 'mp4' || sub === 'mpeg' || sub === 'webm' || sub === 'quicktime') {
			return sub === 'quicktime' ? '.mov' : `.${sub}`;
		}
		return `.${sub}`;
	}
	if (kind === 'image') return '.jpg';
	if (kind === 'voice') return '.ogg';
	if (kind === 'video') return '.mp4';
	return '.bin';
}

export async function dispatchVaultSaveNote(input: VaultSaveNoteInput): Promise<VaultSaveNoteResult> {
	const engine = getVaultEngine();
	if (!engine) {
		return { text: 'Vault is not initialized — /save is unavailable.' };
	}

	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC

	// Slice 6 — promote the `/img` cache image into the regular media
	// triple if and only if the user didn't attach something fresh. A real
	// inbound attachment always wins (the user is clearly saving what they
	// just sent). Cached prompt seeds the body when the user typed nothing.
	let mediaBuffer = input.mediaBuffer;
	let mimetype = input.mimetype;
	let mediaKind: VaultMediaKind | undefined = input.mediaKind;
	let workingBody = input.workingBody;
	if (!mediaBuffer && input.cachedImage) {
		mediaBuffer = input.cachedImage.buffer;
		mimetype = input.cachedImage.mimetype;
		mediaKind = 'image';
		if (!workingBody.trim()) {
			workingBody = input.cachedImage.prompt;
		}
	}

	let extracted: ExtractionOutput = {};
	if (mediaBuffer && mimetype && mediaKind) {
		extracted = await extractFromMedia(
			mediaBuffer,
			mimetype,
			mediaKind,
			workingBody,
		);
	}

	const { type, tag, body } = extractTypeFromPrefix(workingBody);
	const title = pickTitle(extracted, body);
	const slug = slugify(title);
	const filename = `${today}-${slug}.md`;

	const tags = new Set<string>();
	if (tag) tags.add(tag);
	if (extracted.tags) for (const t of extracted.tags) tags.add(t.toLowerCase().replace(/^#/, ''));
	tags.add('whatsapp');

	let assetPath: string | undefined;
	if (mediaBuffer && mimetype && mediaKind) {
		const ext = pickAssetExtension(mimetype, mediaKind);
		const assetFilename = `${today}-${slug}${ext}`;
		const assetResult = await engine.writeAsset({
			zone: 'inbox/assets',
			filename: assetFilename,
			buffer: mediaBuffer,
			mimetype: mimetype,
			agent: AGENT,
			context: `whatsapp:${input.envelope.chatJid}:${input.envelope.messageId ?? ''}`,
		});
		if (assetResult.success) {
			assetPath = assetResult.path;
		}
	}

	const noteBody = buildBody(extracted, body);

	const meta: Record<string, unknown> = {
		type,
		created: today,
		tags: [...tags],
		source: 'whatsapp',
		source_agent: AGENT,
		source_context: `whatsapp:${input.envelope.chatJid}:${input.envelope.messageId ?? ''}`,
	};
	if (assetPath) {
		// Voice attachments carry the upstream transcript + duration
		// metadata so a future indexer can search audio captures by
		// transcript without re-OCRing the audio. Image/video pull their
		// extra fields from the Gemini Flash extraction pass.
		const attachment: Record<string, unknown> = {
			path: assetPath,
			kind: mediaKind,
			mimetype: mimetype,
			bytes: mediaBuffer?.byteLength,
		};
		if (mediaKind === 'voice' && body) {
			attachment.transcript = body;
		}
		if (extracted.transcript?.trim()) attachment.transcript = extracted.transcript.trim();
		if (extracted.vision_caption?.trim()) attachment.vision_caption = extracted.vision_caption.trim();
		if (extracted.summary?.trim()) attachment.summary = extracted.summary.trim();
		if (extracted.visual_description?.trim()) attachment.visual_description = extracted.visual_description.trim();
		if (extracted.duration_estimate_seconds && Number.isFinite(extracted.duration_estimate_seconds)) {
			attachment.duration_estimate_seconds = extracted.duration_estimate_seconds;
		}
		meta.attachments = [attachment];
	}

	const noteResult = await engine.createNote({
		zone: 'inbox',
		filename,
		meta,
		content: noteBody,
	});

	if (!noteResult.success) {
		return {
			text: `Couldn't save: ${noteResult.error}`,
			assetPath,
		};
	}

	const url = noteOpenUrl(noteResult.path);
	const stem = filename.replace(/\.md$/, '');
	return {
		text: `Saved as [[${stem}]] — ${url}`,
		notePath: noteResult.path,
		assetPath,
	};
}
