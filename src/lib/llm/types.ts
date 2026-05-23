/** Chat provider abstraction — Vercel AI SDK-shaped wrappers around the
 *  paid LLM APIs (Anthropic, OpenRouter, Gemini). Distinct from the
 *  playbook `PlaybookProvider` system, which executes long-running CLI
 *  tasks that write files. ChatProvider is for request/response chat
 *  used by the routes layer (WhatsApp dispatch, vault chat, etc.). */

import type { JSONValue } from 'ai';

export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export interface ChatRequest {
	/** System prompt — passed as a separate role on providers that prefer it,
	 *  or prepended to messages otherwise. */
	system?: string;
	messages: ChatMessage[];
	/** Provider-specific model id. When omitted, providers fall back to
	 *  their `defaultModel`. */
	model?: string;
	/** Cap output tokens. Providers map this to their native parameter. */
	maxOutputTokens?: number;
	/** Aborts the in-flight request. Honoured by every SDK we wrap. */
	signal?: AbortSignal;
	/** Anthropic prompt-caching hint. Forwarded to `@ai-sdk/anthropic`
	 *  via `providerOptions.anthropic.cacheControl`. Ignored by other
	 *  providers (per AI SDK spec). */
	cacheControl?: 'ephemeral';
	/** Raw AI SDK provider options forwarded to `generateText`. Use this
	 *  to disable Gemini thinking on JSON-output calls (the orchestrator
	 *  classifier hit empty/non-JSON responses when thinking ate the
	 *  output budget — see `feedback_gemini_thinking_budget`). Shape:
	 *  `{ google: { thinkingConfig: { thinkingBudget: 0 } } }`. AI SDK's
	 *  shape is `Record<string, JSONObject>`; we use `JSONValue` here so
	 *  callers don't have to import the SDK's internal types. */
	providerOptions?: Record<string, Record<string, JSONValue>>;
}

export interface ChatUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export interface ChatResult {
	text: string;
	finishReason: string;
	usage?: ChatUsage;
	providerId: string;
	modelId: string;
}

export interface ChatProvider {
	/** Stable id, e.g. `anthropic`. */
	readonly id: string;
	/** Display name, e.g. `Anthropic`. */
	readonly name: string;
	/** Model used when the request omits one. */
	readonly defaultModel: string;
	/** Env var the provider needs (single source of truth — providers and
	 *  testers reference the same name). Consulted by `available()`. */
	readonly envKey: string;
	/** True when the credential is present. Cheap, sync — does not call out. */
	available(): boolean;
	/** One-shot generation. Streaming is added in Phase 2 when the WhatsApp
	 *  adapter needs it; until then chat dispatches use the buffered result. */
	generate(req: ChatRequest): Promise<ChatResult>;
}

/** `provider:model` reference used by the routes layer (Phase 2). Defined
 *  here so the parser/types live next to the providers they refer to. */
export type ProviderRef = `${string}:${string}`;

export function parseProviderRef(ref: string): { providerId: string; modelId: string } {
	const idx = ref.indexOf(':');
	if (idx === -1) {
		throw new Error(`Invalid ProviderRef "${ref}" — expected "provider:model".`);
	}
	return { providerId: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}
