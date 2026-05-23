import type { TestResult } from '../channels/types.js';
import type { DeclaredSecret } from '../channels/registry.js';
import type { ProviderTester } from './types.js';

import { provider as gemini } from './gemini.js';
import { provider as openrouter } from './openrouter.js';
import { provider as anthropic } from './anthropic.js';
import { provider as elevenlabs } from './elevenlabs.js';
import { provider as resend } from './resend.js';
import { provider as youtube } from './youtube.js';
import { provider as huggingface } from './huggingface.js';
import { provider as googleMaps } from './google-maps.js';
import { provider as eodhd } from './eodhd.js';

/** Built-in provider testers. One env var per provider — providers that
 *  need richer config or bidirectional traffic (i.e. send/listen) should
 *  be modelled as channel adapters instead. */
const providers: ProviderTester[] = [
	gemini,
	openrouter,
	anthropic,
	elevenlabs,
	resend,
	youtube,
	huggingface,
	googleMaps,
	eodhd,
];

const byEnvKey = new Map(providers.map((p) => [p.field.envKey, p]));

/** Provider-declared secrets in the same shape channels expose, so the
 *  settings UI can render them through one merged list. `declaredBy`
 *  carries the provider id — the UI uses it for the "Required for: …" line. */
export function getDeclaredProviderSecrets(): DeclaredSecret[] {
	return providers.map((p) => ({
		key: p.field.envKey,
		label: p.field.label,
		declaredBy: [p.id],
		required: !!p.field.required,
		link: p.field.link,
	}));
}

/** Run the test for the provider that declares `envKey`. Returns
 *  `unsupported` when no provider claims the key, leaving the caller free
 *  to fall through to the channel registry. */
export async function testProviderSecret(envKey: string): Promise<TestResult> {
	const provider = byEnvKey.get(envKey);
	if (!provider) {
		return {
			ok: false,
			status: 'unsupported',
			message: `No provider declares ${envKey}.`,
		};
	}
	return provider.test();
}

/** Did any provider declare `envKey`? Used by `secret-testers.ts` to
 *  decide whether to invoke `testProviderSecret` or short-circuit to the
 *  channel registry. */
export function isProviderSecret(envKey: string): boolean {
	return byEnvKey.has(envKey);
}
