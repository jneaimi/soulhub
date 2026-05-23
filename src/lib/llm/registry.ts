/** Chat provider registry — public surface for the routes layer (Phase 2)
 *  and the WhatsApp adapter (Phase 4). Existing playbook providers
 *  (`PlaybookProvider` for CLI/file-output tasks) remain in
 *  `src/lib/playbook/providers/`; this is a parallel surface for
 *  request/response chat traffic. */

import type { ChatProvider } from './types.js';
import { anthropic } from './anthropic.js';
import { openrouter } from './openrouter.js';
import { gemini } from './gemini.js';

const providers = new Map<string, ChatProvider>();
providers.set(anthropic.id, anthropic);
providers.set(openrouter.id, openrouter);
providers.set(gemini.id, gemini);

/** Return a provider by id. Throws when nothing is registered under that
 *  id — callers should validate against `listChatProviders()` first. */
export function getChatProvider(id: string): ChatProvider {
	const provider = providers.get(id);
	if (!provider) {
		throw new Error(
			`Unknown chat provider "${id}". Registered: ${Array.from(providers.keys()).join(', ')}`,
		);
	}
	return provider;
}

export function listChatProviders(): ChatProvider[] {
	return Array.from(providers.values());
}

/** Subset of `listChatProviders()` whose credentials are present in
 *  `process.env`. The routes-layer resolver uses this to skip dead
 *  providers when building a failover chain. */
export function getAvailableChatProviders(): ChatProvider[] {
	return listChatProviders().filter((p) => p.available());
}
