/** Voice-note transcription helper. Uses Gemini's multimodal capability
 *  via `@ai-sdk/google` directly — kept distinct from the `ChatProvider`
 *  surface because that interface only carries text. Bundling audio into
 *  it would force every chat provider to implement multimodal stubs.
 *
 *  Output is a plain transcript (no commentary) — the dispatcher then
 *  feeds that string into the routes layer as if it were typed text. */

import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { parseProviderRef } from '../../llm/types.js';

const TRANSCRIBE_PROMPT =
	'Transcribe this voice note verbatim. Output only the transcript — no preamble, no quotation marks, no language label, no commentary. Preserve the original language. If the audio is silent or unintelligible, output the literal string "[unintelligible]".';

export interface TranscribeOptions {
	audio: Buffer;
	mimetype: string;
	providerRef?: string;
	signal?: AbortSignal;
	maxOutputTokens?: number;
}

export interface TranscribeResult {
	text: string;
	providerId: string;
	modelId: string;
}

/** Transcribe a voice note. Throws on credential / API failure — the
 *  dispatcher catches and falls back to a friendly "couldn't transcribe"
 *  reply rather than blocking the channel. */
export async function transcribeVoiceNote(
	opts: TranscribeOptions,
): Promise<TranscribeResult> {
	const ref = opts.providerRef ?? 'gemini:gemini-2.5-flash';
	const { providerId, modelId } = parseProviderRef(ref);
	if (providerId !== 'gemini') {
		throw new Error(
			`transcribeVoiceNote: provider "${providerId}" is not supported — only Gemini is wired for multimodal input. Set delivery.transcribeProvider to "gemini:<model>".`,
		);
	}

	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		throw new Error('GEMINI_API_KEY is not set — voice transcription requires Gemini.');
	}

	const client = createGoogleGenerativeAI({ apiKey });
	// Gemini accepts `audio/ogg` even for opus payloads; we strip codec
	// hints because some SDK versions reject the parameterised form.
	const cleanMime = opts.mimetype.split(';')[0].trim() || 'audio/ogg';

	const result = await generateText({
		model: client(modelId),
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: TRANSCRIBE_PROMPT },
					{ type: 'file', mediaType: cleanMime, data: opts.audio },
				],
			},
		],
		maxOutputTokens: opts.maxOutputTokens ?? 1500,
		abortSignal: opts.signal,
	});

	return { text: result.text.trim(), providerId, modelId };
}
