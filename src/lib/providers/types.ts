/** Provider tester system — for credentials that aren't tied to a channel
 *  adapter (i.e. one-way API keys for image gen, LLMs, email, etc.). Each
 *  provider declares one env var and a `test()` that pings a cheap auth
 *  endpoint. UIs render a Test button beside the secret using the same
 *  TestResult shape that channels use. */

import type { TestResult } from '../channels/types.js';

export type { TestResult } from '../channels/types.js';

/** A single env var declared by a provider, with metadata for the UI. */
export interface ProviderField {
	/** Env var name, e.g. `GEMINI_API_KEY` */
	envKey: string;
	/** Human label for the credential, e.g. `API Key` */
	label: string;
	/** Where the user can obtain this credential. */
	link?: string;
	/** When true, the provider can't operate without this var. Defaults to
	 *  false because providers are typically optional surface — only the
	 *  skills/agents that use them care. */
	required?: boolean;
}

/** A provider tester — minimal surface for credential validation. */
export interface ProviderTester {
	/** Stable id, e.g. `gemini`. Surfaces in `declaredBy` arrays. */
	id: string;
	/** Display name, e.g. `Gemini`. */
	name: string;
	/** The env var this provider needs. One per provider — providers that
	 *  need multiple secrets should be modelled as a channel adapter. */
	field: ProviderField;
	/** Pings the upstream API with a tiny read-only request. Implementations
	 *  must catch network errors and return `{ status: 'network', ok: false }`
	 *  rather than throwing. */
	test(): Promise<TestResult>;
}
