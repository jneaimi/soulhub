import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ChatProvider, ChatRequest, ChatResult } from './types.js';

const ENV_KEY = 'GEMINI_API_KEY';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export const gemini: ChatProvider = {
	id: 'gemini',
	name: 'Gemini',
	defaultModel: DEFAULT_MODEL,
	envKey: ENV_KEY,

	available(): boolean {
		return !!process.env[ENV_KEY];
	},

	async generate(req: ChatRequest): Promise<ChatResult> {
		const apiKey = process.env[ENV_KEY];
		if (!apiKey) throw new Error(`${ENV_KEY} is not set`);

		const client = createGoogleGenerativeAI({ apiKey });
		const modelId = req.model ?? DEFAULT_MODEL;

		const result = await generateText({
			model: client(modelId),
			system: req.system,
			messages: req.messages,
			maxOutputTokens: req.maxOutputTokens,
			abortSignal: req.signal,
			...(req.providerOptions && { providerOptions: req.providerOptions }),
		});

		return {
			text: result.text,
			finishReason: result.finishReason,
			usage: {
				inputTokens: result.usage?.inputTokens,
				outputTokens: result.usage?.outputTokens,
				totalTokens: result.usage?.totalTokens,
			},
			providerId: 'gemini',
			modelId,
		};
	},
};
