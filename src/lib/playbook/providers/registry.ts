import type { PlaybookProvider } from './types.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';

/**
 * Registry of available playbook providers.
 * Detects which CLI tools are installed and provides fallback logic.
 */
export class ProviderRegistry {
	private providers = new Map<string, PlaybookProvider>();
	private availabilityCache = new Map<string, boolean>();

	constructor() {
		this.register(new ClaudeProvider());
		this.register(new CodexProvider());
	}

	/** Register a provider */
	register(provider: PlaybookProvider): void {
		this.providers.set(provider.id, provider);
	}

	/** Get a provider by ID. Falls back to 'claude' if requested is unavailable. */
	async get(id: string): Promise<{ provider: PlaybookProvider; fallback: boolean }> {
		const requested = this.providers.get(id);
		if (requested) {
			const isAvailable = await this.checkAvailable(id);
			if (isAvailable) {
				return { provider: requested, fallback: false };
			}
		}

		// Fallback to claude
		const claude = this.providers.get('claude');
		if (!claude) {
			throw new Error(`Provider "${id}" not available and no fallback provider found`);
		}
		const claudeAvailable = await this.checkAvailable('claude');
		if (!claudeAvailable) {
			throw new Error('Claude provider not available — check claude binary path in settings');
		}
		return { provider: claude, fallback: true };
	}

	/** Check availability (cached for session lifetime) */
	private async checkAvailable(id: string): Promise<boolean> {
		if (this.availabilityCache.has(id)) {
			return this.availabilityCache.get(id)!;
		}
		const provider = this.providers.get(id);
		if (!provider) return false;
		const available = await provider.available();
		this.availabilityCache.set(id, available);
		return available;
	}

	/** Detect all available providers */
	async detectAvailable(): Promise<Record<string, boolean>> {
		const result: Record<string, boolean> = {};
		for (const [id, provider] of this.providers) {
			result[id] = await provider.available();
		}
		return result;
	}

	/** List all registered provider IDs */
	listProviders(): string[] {
		return Array.from(this.providers.keys());
	}

	/** Clear availability cache (useful after install/uninstall) */
	clearCache(): void {
		this.availabilityCache.clear();
	}
}

/** Singleton registry instance — use globalThis for HMR safety */
const _global = globalThis as unknown as { __soulhub_provider_registry?: ProviderRegistry };
if (!_global.__soulhub_provider_registry) {
	_global.__soulhub_provider_registry = new ProviderRegistry();
}
export const providerRegistry = _global.__soulhub_provider_registry;
