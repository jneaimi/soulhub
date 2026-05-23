/** Zod schemas for the routes section of `~/.soul-hub/settings.json`. The
 *  schema is the source of truth — `RouteConfig`/`FailoverTrigger` types
 *  in `types.ts` mirror these for editor ergonomics. */

import { z } from 'zod';

/** Provider id whitelist — keep in sync with `src/lib/llm/registry.ts`
 *  plus `cli` (deferred to Phase 4 for actual dispatch, but accepted in
 *  config so users can pre-wire agent routes). */
export const ProviderIdSchema = z.enum(['cli', 'anthropic', 'openrouter', 'gemini']);

/** `provider:model` reference. Examples: `openrouter:google/gemini-2.5-flash`,
 *  `gemini:gemini-2.5-flash`, `cli:sonnet-4-6`. The model half is left as
 *  free-form because each provider has its own slug conventions. */
export const ProviderRefSchema = z
	.string()
	.regex(/^(cli|anthropic|openrouter|gemini):.+$/, {
		message: 'Expected `provider:model`, where provider ∈ {cli, anthropic, openrouter, gemini}.',
	});

export const FailoverTriggerSchema = z.enum(['timeout', '5xx', 'rate_limit', 'network']);

export const RouteConfigSchema = z.object({
	description: z.string().optional(),
	default: ProviderRefSchema,
	failover: z.array(ProviderRefSchema).default([]),
	timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
	retries: z.number().int().min(0).max(5).default(0),
	onError: z
		.array(FailoverTriggerSchema)
		.default(['timeout', '5xx', 'rate_limit', 'network']),
});

/** Routes section is a free-form record so users can add their own
 *  intent names without touching code. */
export const RoutesSchema = z.record(z.string(), RouteConfigSchema);

export type RouteConfigInput = z.input<typeof RouteConfigSchema>;
export type RoutesInput = z.input<typeof RoutesSchema>;
