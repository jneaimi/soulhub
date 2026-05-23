/** Unified entry point for the settings UI to (a) ask "what credentials
 *  does Soul Hub know about?" and (b) "go test this one". Channels and
 *  providers each maintain their own registries; this module is the only
 *  place that joins them. */

import type { TestResult } from './channels/types.js';
import {
	getDeclaredSecrets as getDeclaredChannelSecrets,
	testSecret as testChannelSecret,
	type DeclaredSecret,
} from './channels/registry.js';
import {
	getDeclaredProviderSecrets,
	isProviderSecret,
	testProviderSecret,
} from './providers/registry.js';

export type { DeclaredSecret } from './channels/registry.js';

/** Union of every secret declared across channels + providers, with the
 *  same merge semantics channels already use: declaredBy is the union, the
 *  first non-empty link wins, required is OR'd. */
export function getAllDeclaredSecrets(): DeclaredSecret[] {
	const merged = new Map<string, DeclaredSecret>();

	for (const entry of [
		...getDeclaredChannelSecrets(),
		...getDeclaredProviderSecrets(),
	]) {
		const existing = merged.get(entry.key);
		if (!existing) {
			merged.set(entry.key, { ...entry, declaredBy: [...entry.declaredBy] });
			continue;
		}
		for (const id of entry.declaredBy) {
			if (!existing.declaredBy.includes(id)) existing.declaredBy.push(id);
		}
		if (entry.required) existing.required = true;
		if (!existing.link && entry.link) existing.link = entry.link;
	}

	return Array.from(merged.values());
}

/** Dispatch to whichever registry declares `envKey`. Channels are checked
 *  first because they may need richer multi-field tests (e.g. token + chat
 *  id) — providers are the simpler one-secret fallback. */
export async function testSecret(envKey: string): Promise<TestResult> {
	if (isProviderSecret(envKey)) {
		// Channel may also declare it (rare); prefer the channel test which
		// can validate composite credentials. Provider is the fallback.
		const channelResult = await testChannelSecret(envKey);
		if (channelResult.status !== 'unsupported') return channelResult;
		return testProviderSecret(envKey);
	}
	return testChannelSecret(envKey);
}
