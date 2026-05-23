import type { ProviderRef } from '../llm/types.js';

export class UnsupportedProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedProviderError';
	}
}

export class ProviderUnavailableError extends Error {
	constructor(public readonly providerId: string, message: string) {
		super(message);
		this.name = 'ProviderUnavailableError';
	}
}

export class RouteNotFoundError extends Error {
	constructor(public readonly routeName: string) {
		super(`No route named "${routeName}" — check the routes section of settings.json.`);
		this.name = 'RouteNotFoundError';
	}
}

/** Thrown when every entry in the chain has been tried and none succeeded.
 *  Surfaces the chain + the final upstream error for diagnostics. */
export class AllProvidersFailedError extends Error {
	constructor(
		public readonly chain: ProviderRef[],
		public readonly lastError: Error | undefined,
	) {
		super(
			`All ${chain.length} provider(s) failed for this route. Last error: ${
				lastError?.message ?? 'unknown'
			}`,
		);
		this.name = 'AllProvidersFailedError';
	}
}
