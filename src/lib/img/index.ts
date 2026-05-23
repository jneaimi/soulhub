/** `dispatchImg` — entry point for `/img` calls. Wraps Gemini Nano
 *  Banana (`gemini-2.5-flash-image` by default) for both text-to-image
 *  generation AND image-to-image editing. The presence of input image
 *  buffers in the request is what flips the model between modes; there
 *  is no separate endpoint.
 *
 *  Per ADR-002:
 *    - One slash command, one model, no flags.
 *    - System prompt comes from `~/vault/operations/whatsapp/IMG.md`,
 *      vault-watched + cached (see `loader.ts`).
 *    - Output is written to `~/.soul-hub/data/whatsapp/<account>/outgoing/`
 *      so both in-process and worker dispatch paths can `sendMedia` it
 *      via the existing file-path API.
 *    - The buffer is also returned so the caller can stash it in the
 *      per-conversation cache (see `cache.ts`) for the `/save` follow-up.
 *
 *  The model uses `generateText` with the image model + `responseModalities:
 *  ['IMAGE']` (handled implicitly by the AI SDK provider) so we get a
 *  proper `system` prompt parameter — same pattern as
 *  `vault-chat/orchestrate.ts:runMultimodal`. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { soulHubDataDir } from '../paths.js';
import { getImgSystemPrompt } from './loader.js';

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const MAX_OUTPUT_TOKENS = 4096; // image bytes don't count toward this; padding for any text the model emits
const PROMPT_CHAR_CAP = 4000; // sanity guard against pathological inputs

export interface ImgInput {
	/** The user's natural-language prompt (the part after `/img `). */
	prompt: string;
	/** Conversation key (chatJid for groups, senderNumber for DMs). Used
	 *  by the caller to decide where to cache the output buffer; we just
	 *  pass it through to the slug for diagnostics. */
	conversationKey: string;
	/** Account name from the WhatsApp config — used to scope the outgoing
	 *  directory so multi-account installs don't collide. */
	account: string;
	/** Input image buffers — present when the user attached an image (or
	 *  multiple). Editing mode kicks in when this is non-empty. */
	inputImages?: { buffer: Buffer; mimetype: string }[];
	/** IMG.md path from settings. Default `operations/whatsapp/IMG.md`. */
	systemPromptPath: string;
	/** Override the default model (e.g. `gemini-3-pro-image-preview`). */
	model?: string;
}

export interface ImgResult {
	/** Absolute path to the generated PNG on disk. Caller passes this to
	 *  `sendMedia` (in-process) or returns it as `attachPath` (worker). */
	path: string;
	/** Same buffer, in memory — for the per-conversation cache so `/save`
	 *  can pick up the last image without re-reading from disk. */
	buffer: Buffer;
	mimetype: string;
	/** The original user prompt — useful for the cache (used as the slug
	 *  if `/save` arrives without text). */
	prompt: string;
	/** Optional caption — currently always omitted; the IMG.md prompt
	 *  tells the model "reply with the image only". Reserved field. */
	caption?: string;
	/** Set when generation failed — caller falls back to a text reply. */
	error?: string;
	mode: 'generate' | 'edit';
}

function slugForFile(input: string): string {
	const cleaned = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9\s-]/g, ' ')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return cleaned.slice(0, 40).replace(/-+$/, '') || 'image';
}

function outgoingDir(account: string): string {
	const dir = resolve(soulHubDataDir(), 'whatsapp', account, 'outgoing');
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Build the user-message content array. Text first, then any input images
 *  as `{type:'file'}` parts — same shape as `transcribe.ts` and
 *  `vault-chat/orchestrate.ts:runMultimodal`. */
function buildContent(
	prompt: string,
	mode: 'generate' | 'edit',
	inputImages?: { buffer: Buffer; mimetype: string }[],
) {
	const modeHeader = `# Mode: ${mode === 'edit' ? 'EDIT' : 'GENERATE'}\n\n`;
	const userText = `${modeHeader}${prompt.slice(0, PROMPT_CHAR_CAP)}`;
	const parts: Array<
		| { type: 'text'; text: string }
		| { type: 'file'; mediaType: string; data: Buffer }
	> = [{ type: 'text', text: userText }];
	if (inputImages?.length) {
		for (const img of inputImages) {
			const cleanMime = img.mimetype.split(';')[0].trim() || 'image/png';
			parts.push({ type: 'file', mediaType: cleanMime, data: img.buffer });
		}
	}
	return parts;
}

export async function dispatchImg(input: ImgInput): Promise<ImgResult> {
	const apiKey = process.env.GEMINI_API_KEY;
	const mode: 'generate' | 'edit' = input.inputImages?.length ? 'edit' : 'generate';

	if (!apiKey) {
		return {
			path: '',
			buffer: Buffer.alloc(0),
			mimetype: 'image/png',
			prompt: input.prompt,
			error: '`/img` needs `GEMINI_API_KEY`. Configure it in Settings → Secrets, then resend.',
			mode,
		};
	}

	const trimmed = input.prompt.trim();
	if (!trimmed && mode === 'generate') {
		return {
			path: '',
			buffer: Buffer.alloc(0),
			mimetype: 'image/png',
			prompt: input.prompt,
			error: 'Tell me what to draw — `/img a sunset over Dubai marina, 16:9 cinematic`.',
			mode,
		};
	}

	const client = createGoogleGenerativeAI({ apiKey });
	const modelId = input.model ?? DEFAULT_MODEL;
	const systemPrompt = getImgSystemPrompt(input.systemPromptPath);

	let buffer: Buffer;
	let mimetype: string;
	try {
		const result = await generateText({
			model: client(modelId),
			system: systemPrompt,
			messages: [
				{
					role: 'user',
					content: buildContent(trimmed, mode, input.inputImages),
				},
			],
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			providerOptions: {
				google: {
					// Nano Banana doesn't support `thinkingConfig` — it's a
					// pure-image model with no chain-of-thought stage. Pass only
					// the response-modality switch so we get image bytes back
					// instead of text.
					responseModalities: ['IMAGE'],
				},
			},
		});

		const file = result.files?.find((f) => f.mediaType?.startsWith('image/'));
		if (!file) {
			return {
				path: '',
				buffer: Buffer.alloc(0),
				mimetype: 'image/png',
				prompt: input.prompt,
				error: result.text?.trim()
					? `Couldn't make the image. Model said: ${result.text.trim().slice(0, 200)}`
					: "Couldn't make the image — the model returned no image data. Try rephrasing.",
				mode,
			};
		}
		// AI SDK returns either a Uint8Array (`uint8Array`) or base64 string;
		// normalize to a Node Buffer either way.
		const raw = file.uint8Array ?? Buffer.from(file.base64 ?? '', 'base64');
		buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		mimetype = file.mediaType ?? 'image/png';
	} catch (err) {
		return {
			path: '',
			buffer: Buffer.alloc(0),
			mimetype: 'image/png',
			prompt: input.prompt,
			error: `Couldn't make the image: ${(err as Error).message}`,
			mode,
		};
	}

	const ext = mimetype.split('/')[1]?.split(';')[0] ?? 'png';
	const filename = `${Date.now()}-${slugForFile(trimmed)}.${ext === 'jpeg' ? 'jpg' : ext}`;
	const path = resolve(outgoingDir(input.account), filename);
	try {
		writeFileSync(path, buffer);
	} catch (err) {
		return {
			path: '',
			buffer,
			mimetype,
			prompt: input.prompt,
			error: `Generated the image but couldn't save it locally: ${(err as Error).message}`,
			mode,
		};
	}

	return {
		path,
		buffer,
		mimetype,
		prompt: input.prompt,
		mode,
	};
}

export {
	rememberLastImage,
	getLastImage,
	forgetLastImage,
	rememberLastUserImage,
	getLastUserImage,
	forgetLastUserImage,
} from './cache.js';
