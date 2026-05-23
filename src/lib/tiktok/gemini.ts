/**
 * Tier C — Gemini multimodal on a TikTok mp4 (ADR-024).
 *
 * Unlike YouTube where Gemini accepts the URL natively (`mediaType:
 * 'video/youtube'`), TikTok URLs are not in Gemini's accepted file_data
 * set. We send the downloaded mp4 as inline binary data.
 *
 * Cost: gemini-2.5-flash bills video at ~263 tokens/sec at low resolution.
 * A 60s clip ≈ 16k input tokens × $0.075/1M ≈ ~$0.0012 per call. Bounded
 * by `cfg.tiktok.maxPerDay`.
 */

import { readFile } from 'node:fs/promises';

import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

import type { TikTokFetchMode } from './types.js';

const ENV_KEY = 'GEMINI_API_KEY';
const DEFAULT_MODEL = 'gemini-2.5-flash';
// 90s — Gemini's video ingestion runs server-side before first token; must
// stay strictly less than orchestrator-v2's TIMEOUT_MS (100s) so this fails
// first as a graceful `gemini-failed` note rather than the orchestrator
// nuking the whole turn.
const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 8_192;

export interface GeminiTikTokResult {
	summary?: string;
	transcript?: string;
	costUsd?: number;
	inputTokens?: number;
	outputTokens?: number;
}

export async function fetchTikTokViaGemini(
	mp4Path: string,
	mode: TikTokFetchMode,
	opts: { model?: string; signal?: AbortSignal } = {},
): Promise<GeminiTikTokResult> {
	const apiKey = process.env[ENV_KEY];
	if (!apiKey) {
		throw new Error(`${ENV_KEY} is not set`);
	}

	const client = createGoogleGenerativeAI({ apiKey });
	const modelId = opts.model ?? DEFAULT_MODEL;

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
	opts.signal?.addEventListener('abort', () => ac.abort());

	const buffer = await readFile(mp4Path);
	const prompt = buildPrompt(mode);

	try {
		const result = await generateText({
			model: client(modelId),
			messages: [
				{
					role: 'user',
					content: [
						{
							type: 'file',
							data: buffer,
							mediaType: 'video/mp4',
						},
						{
							type: 'text',
							text: prompt,
						},
					],
				},
			],
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			abortSignal: ac.signal,
		});

		const parsed = parseJsonResponse(result.text, mode);
		const cost = priceTurn(modelId, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0);

		return {
			...parsed,
			costUsd: cost,
			inputTokens: result.usage?.inputTokens,
			outputTokens: result.usage?.outputTokens,
		};
	} finally {
		clearTimeout(timer);
	}
}

function buildPrompt(mode: TikTokFetchMode): string {
	const lines = [
		'You will analyze the attached TikTok video. Respond with ONLY a JSON object — no markdown fences, no commentary, no preface text.',
		'',
		'Always include these fields:',
	];

	if (mode === 'summary' || mode === 'full') {
		lines.push(
			'- "summary": a 2-3 paragraph plain-text summary of the video\'s key points. No bullet lists, no markdown headings, no inline links.',
		);
	}

	if (mode === 'transcript' || mode === 'full') {
		lines.push(
			'- "transcript": the full spoken-word transcript as plain text. Strip filler words ("um", "uh", "like" when used as filler). Preserve sentences. Do not include timestamps. If the video has no spoken content, set to null.',
		);
	}

	lines.push('', 'Return ONLY the JSON object. Begin your response with `{`.');
	return lines.join('\n');
}

function parseJsonResponse(text: string, mode: TikTokFetchMode): Partial<GeminiTikTokResult> {
	const trimmed = text.trim();
	const jsonStart = trimmed.indexOf('{');
	const jsonEnd = trimmed.lastIndexOf('}');
	if (jsonStart < 0 || jsonEnd <= jsonStart) {
		throw new Error(`Gemini did not return JSON. Got: ${trimmed.slice(0, 200)}`);
	}
	const slice = trimmed.slice(jsonStart, jsonEnd + 1);
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(slice) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`Gemini JSON parse failed: ${(err as Error).message}. Slice: ${slice.slice(0, 200)}`);
	}

	const out: Partial<GeminiTikTokResult> = {};
	if ((mode === 'summary' || mode === 'full') && typeof parsed.summary === 'string') {
		out.summary = parsed.summary.trim();
	}
	if ((mode === 'transcript' || mode === 'full') && typeof parsed.transcript === 'string') {
		out.transcript = parsed.transcript.trim();
	}
	return out;
}

/** gemini-2.5-flash pricing (2026-05): $0.075/1M input, $0.30/1M output for
 *  text + standard inputs. Video tokens are counted at 263 tokens/sec at low
 *  resolution, billed at the same rate as text input. */
function priceTurn(modelId: string, inputTokens: number, outputTokens: number): number {
	const lower = modelId.toLowerCase();
	let inPer1M = 0;
	let outPer1M = 0;
	if (lower.includes('flash')) {
		inPer1M = 0.075;
		outPer1M = 0.3;
	} else if (lower.includes('pro')) {
		inPer1M = 1.25;
		outPer1M = 5.0;
	} else {
		return 0;
	}
	return (inputTokens / 1_000_000) * inPer1M + (outputTokens / 1_000_000) * outPer1M;
}
