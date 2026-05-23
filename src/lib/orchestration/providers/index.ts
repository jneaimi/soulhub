import type { ProviderType } from '../types.js';
import type { OrchestrationProvider } from './types.js';
import { ClaudeCodeOrchProvider } from './claude-code.js';
import { CodexOrchProvider } from './codex.js';
import { ShellOrchProvider } from './shell.js';

export type { OrchestrationProvider, ProviderSession } from './types.js';

const providers = new Map<ProviderType, OrchestrationProvider>();
providers.set('claude-code', new ClaudeCodeOrchProvider());
providers.set('codex', new CodexOrchProvider());
providers.set('shell', new ShellOrchProvider());

/**
 * Get a provider by type. Falls back to claude-code if requested is unavailable.
 */
export async function getProvider(type: ProviderType): Promise<OrchestrationProvider> {
	const provider = providers.get(type);
	if (provider && (await provider.available())) {
		return provider;
	}

	const fallback = providers.get('claude-code')!;
	console.log(`[orchestration] Provider "${type}" unavailable, falling back to claude-code`);
	return fallback;
}

/**
 * Check availability of all providers.
 */
export async function detectProviders(): Promise<Record<ProviderType, boolean>> {
	const result: Record<string, boolean> = {};
	for (const [id, provider] of providers) {
		result[id] = await provider.available();
	}
	return result as Record<ProviderType, boolean>;
}
