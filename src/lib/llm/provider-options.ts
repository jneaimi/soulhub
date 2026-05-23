/** Shallow-merge two AI SDK `providerOptions` blocks. Used by providers
 *  that compose caller-supplied options with their own (e.g., Anthropic
 *  cacheControl). Returns `undefined` when both inputs are absent so the
 *  call site can omit the field entirely. */

import type { JSONValue } from 'ai';

type ProviderOpts = Record<string, Record<string, JSONValue>>;

export function mergeProviderOptions(
	a: ProviderOpts | undefined,
	b: ProviderOpts | undefined,
): ProviderOpts | undefined {
	if (!a) return b;
	if (!b) return a;
	const out: ProviderOpts = { ...a };
	for (const [provider, opts] of Object.entries(b)) {
		out[provider] = { ...(out[provider] ?? {}), ...opts };
	}
	return out;
}
