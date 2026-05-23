/**
 * Web-search action — Gemini Flash + Google Search grounding.
 *
 * The middle tier between "answer from training data" (`reply`) and "spin
 * up a 3-minute researcher agent" (`dispatch`). Use for current/fresh
 * facts ("weather today", "latest news on X", single-fact lookups) where
 * the user wants a one-paragraph conversational answer with a citation,
 * not a vault note.
 *
 * Cost: ~$0.001 per call. Latency: 1-3s. Returns text + (optional)
 * citation URL extracted from grounding metadata.
 *
 * Wiring: not on the routes layer — this is a one-shot Gemini call with
 * the `googleSearch` tool enabled. Failover would mean cutting over to
 * a non-search provider, which defeats the purpose; we fail loud instead.
 */

import { generateText } from 'ai';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';

const ENV_KEY = 'GEMINI_API_KEY';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export interface WebSearchResult {
	text: string;
	citations: string[];
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
}

const SYSTEM_PROMPT = `You are answering one user question with a quick web lookup over WhatsApp.

Rules:
- Answer in 1-3 sentences max. No headings, no bullet lists, no code blocks — phone screen.
- Use the google_search tool to fetch current information.
- Cite the most relevant single source inline at the end as a URL on its own line, like:
  Source: https://example.com/path
- If the search returns nothing useful, say so in one sentence and stop. Don't speculate.
- Match the user's language (if they ask in Arabic, answer in Arabic).`;

/** Run a Gemini-grounded web search and return the conversational answer
 *  + any citation URLs the grounding metadata surfaced. Throws on missing
 *  API key or upstream failure — caller decides how to surface the error
 *  to the user. */
export async function dispatchWebSearch(
	query: string,
	opts: { signal?: AbortSignal } = {},
): Promise<WebSearchResult> {
	const apiKey = process.env[ENV_KEY];
	if (!apiKey) throw new Error(`${ENV_KEY} is not set`);

	const client = createGoogleGenerativeAI({ apiKey });

	const result = await generateText({
		model: client(DEFAULT_MODEL),
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content: query }],
		tools: { google_search: google.tools.googleSearch({}) },
		maxOutputTokens: 600,
		abortSignal: opts.signal,
	});

	const citations = extractCitations(result);

	return {
		text: result.text.trim(),
		citations,
		usage: {
			inputTokens: result.usage?.inputTokens,
			outputTokens: result.usage?.outputTokens,
			totalTokens: result.usage?.totalTokens,
		},
	};
}

/** Extract grounded-source URLs from the AI SDK result. Gemini surfaces
 *  these in `providerMetadata.google.groundingMetadata.groundingChunks[].web.uri`
 *  per the Google AI docs. Defensive lookup — shape varies between
 *  versions and we never want this to throw. */
function extractCitations(result: { providerMetadata?: unknown }): string[] {
	const meta = result.providerMetadata as
		| { google?: { groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> } } }
		| undefined;
	const chunks = meta?.google?.groundingMetadata?.groundingChunks;
	if (!Array.isArray(chunks)) return [];
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const c of chunks) {
		const uri = c?.web?.uri;
		if (typeof uri === 'string' && !seen.has(uri)) {
			seen.add(uri);
			urls.push(uri);
		}
	}
	return urls;
}

/** Render the result for chat — prefer the model's inline citation
 *  (cleaner). If the model didn't include one but the grounding metadata
 *  has URLs, append the first as `Source:` line. */
export function formatWebSearchForChat(result: WebSearchResult): string {
	const text = result.text.trim();
	if (/source:\s*https?:\/\//i.test(text)) return text;
	if (result.citations.length === 0) return text;
	return `${text}\n\nSource: ${result.citations[0]}`;
}
