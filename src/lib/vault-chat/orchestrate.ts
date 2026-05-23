/** Public entry point: `dispatchVaultChat(message)` — runs the lexical
 *  retrieval pipeline (selector → tools → format) and then hands the
 *  augmented ChatRequest to `dispatchRoute('vault-chat', …)` so the
 *  routes layer's failover/circuit-breaker still kicks in for the final
 *  LLM call.
 *
 *  Per ADR-004: replaces the embeddings-RAG path. Fast (~30 ms retrieval +
 *  one chat LLM call), free (no embedding API), deterministic, fresh.
 *
 *  When the caller passes `media`, the call goes direct to Gemini Flash
 *  (multimodal) instead of through the routes layer — `ChatProvider`
 *  abstracts text-only content, so adding a file part requires bypassing
 *  the failover engine. Trade-off: no failover for image/voice/video
 *  discussion (they stay Gemini-only); same retrieval grounding still
 *  applies because the system prompt is built from the same vault context. */

import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { dispatchRoute } from '../routes/index.js';
import type { DispatchResult } from '../routes/types.js';
import { selectTools } from './selector.js';
import { retrieve } from './retrieval.js';
import { buildSystemPrompt, buildMultimodalSystemPrompt, formatContextBlock } from './format.js';
import { loadHistory, saveTurn, pruneStaleHistory, buildRetrievalInput } from './history.js';
import type { MediaPayload } from '../channels/whatsapp/types.js';

const ROUTE_NAME = 'vault-chat';
// 800 was too tight for retrieval queries that surface 5-10 candidate notes
// with bullets + links; the answer got cut mid-sentence. 1500 gives enough
// room for a substantive list reply without inflating typical short Q&A.
const ANSWER_MAX_TOKENS = 1500;
const MULTIMODAL_MODEL = 'gemini-2.5-flash';

export interface VaultChatMedia {
	buffer: Buffer;
	mimetype: string;
	kind: MediaPayload['kind'];
}

export interface VaultChatTrace {
	selectorSource: 'llm' | 'heuristic';
	selectorReason?: string;
	toolsRun: { name: string; args: Record<string, unknown> }[];
	notesSurfaced: number;
	notesUsed: number;
	contextBytes: number;
	retrievalMs: number;
	historyTurns: number;
}

export interface VaultChatResult extends DispatchResult {
	trace: VaultChatTrace;
}

/** Run a vault-chat turn end-to-end.
 *
 *  When `conversationKey` is supplied (the WhatsApp dispatcher passes
 *  `senderNumber` for DMs and `chatJid` for groups), prior turns are loaded
 *  and threaded into the LLM call so the bot remembers context. Retrieval
 *  also widens its query to include the last 2 user turns, which is what
 *  lets follow-ups like "tell me more about that" resolve.
 *
 *  Without a key (e.g. the `/api/vault-chat/test` debug endpoint when no
 *  key is provided) the call is stateless — same as the pre-history
 *  behaviour. */
export async function dispatchVaultChat(
	userMessage: string,
	conversationKey?: string,
	media?: VaultChatMedia,
): Promise<VaultChatResult> {
	const retrievalStart = Date.now();

	const history = conversationKey ? loadHistory(conversationKey) : [];
	const retrievalInput = buildRetrievalInput(history, userMessage);

	const selection = await selectTools(retrievalInput);
	const outcome = retrieve(selection.tools);
	const contextBlock = formatContextBlock(outcome.notes, userMessage);
	// Pick the system prompt up-front based on whether we'll go multimodal.
	// The text-only "ground every claim in the context" rule reads as
	// "refuse to look at the image" when an attachment is present.
	const useMultimodal =
		media !== undefined &&
		media.kind !== 'voice' &&
		media.kind !== 'sticker';
	const systemPrompt = useMultimodal
		? buildMultimodalSystemPrompt(contextBlock)
		: buildSystemPrompt(contextBlock);
	const retrievalMs = Date.now() - retrievalStart;

	const trace: VaultChatTrace = {
		selectorSource: selection.source,
		selectorReason: selection.reason,
		toolsRun: outcome.toolsRun.map((t) => ({ name: t.name, args: t.args })),
		notesSurfaced: outcome.totalSurfaced,
		notesUsed: outcome.notes.length,
		contextBytes: contextBlock.length,
		retrievalMs,
		historyTurns: history.length,
	};

	// Media path skips the routes-layer failover engine because ChatProvider
	// is text-only. Voice already arrived as a transcript in `userMessage`
	// (no second pass needed); only image/video/audio/document benefit from
	// real multimodal vision. (The same `useMultimodal` flag chose the
	// system prompt above.)
	const result = useMultimodal
		? await runMultimodal(systemPrompt, history, userMessage, media!)
		: await dispatchRoute(ROUTE_NAME, {
				system: systemPrompt,
				messages: [...history, { role: 'user', content: userMessage }],
				maxOutputTokens: ANSWER_MAX_TOKENS,
			});

	// Persist the round-trip after a successful answer so a failed call
	// doesn't leave half a turn in the log. Prune stale rows on the same
	// path to keep the table tidy without a separate cron. We persist only
	// the user's text — the image bytes don't go into history (they would
	// blow the token budget on every subsequent turn).
	if (conversationKey && result.text) {
		const now = Date.now();
		saveTurn(conversationKey, 'user', userMessage, now);
		saveTurn(conversationKey, 'assistant', result.text, now + 1);
		pruneStaleHistory(now);
	}

	return { ...result, trace };
}

/** Direct Gemini Flash call with a multimodal user content array. Mirrors
 *  the routes-layer `dispatchRoute` return shape (`text`, `finishReason`,
 *  `usage`, `providerId`, `modelId`) so the caller can stay agnostic. */
async function runMultimodal(
	systemPrompt: string,
	history: { role: 'user' | 'assistant' | 'system'; content: string }[],
	userMessage: string,
	media: VaultChatMedia,
): Promise<DispatchResult> {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		return {
			text: 'Multimodal vault-chat needs `GEMINI_API_KEY`. Configure it in Settings → Secrets, then resend the image.',
			finishReason: 'error',
			providerId: 'gemini',
			modelId: MULTIMODAL_MODEL,
			routeName: ROUTE_NAME,
			chain: ['gemini:gemini-2.5-flash'],
			attempts: [],
			answeredBy: 'gemini:gemini-2.5-flash',
		};
	}

	const client = createGoogleGenerativeAI({ apiKey });
	const cleanMime = media.mimetype.split(';')[0].trim() || 'application/octet-stream';

	const messages = [
		...history.map((h) => ({ role: h.role, content: h.content })),
		{
			role: 'user' as const,
			content: [
				{ type: 'text' as const, text: userMessage },
				{ type: 'file' as const, mediaType: cleanMime, data: media.buffer },
			],
		},
	];

	try {
		const out = await generateText({
			model: client(MULTIMODAL_MODEL),
			system: systemPrompt,
			messages,
			maxOutputTokens: ANSWER_MAX_TOKENS,
			providerOptions: {
				google: {
					thinkingConfig: { thinkingBudget: 0 },
				},
			},
		});
		return {
			text: out.text,
			finishReason: out.finishReason ?? 'stop',
			usage: {
				inputTokens: out.usage?.inputTokens,
				outputTokens: out.usage?.outputTokens,
				totalTokens: out.usage?.totalTokens,
			},
			providerId: 'gemini',
			modelId: MULTIMODAL_MODEL,
			routeName: ROUTE_NAME,
			chain: ['gemini:gemini-2.5-flash'],
			attempts: [],
			answeredBy: 'gemini:gemini-2.5-flash',
		};
	} catch (err) {
		return {
			text: `Couldn't read the ${media.kind}: ${(err as Error).message}`,
			finishReason: 'error',
			providerId: 'gemini',
			modelId: MULTIMODAL_MODEL,
			routeName: ROUTE_NAME,
			chain: ['gemini:gemini-2.5-flash'],
			attempts: [],
			answeredBy: 'gemini:gemini-2.5-flash',
		};
	}
}
