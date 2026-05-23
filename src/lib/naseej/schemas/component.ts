/**
 * Zod schema for Naseej component BLOCK.md frontmatter.
 *
 * Shape grounded in the 3 v1 components shipped 2026-05-16:
 *   - catalog/components/stop-slop/BLOCK.md      (runtime: python)
 *   - catalog/components/vault-write/BLOCK.md    (runtime: node)
 *   - catalog/components/channel-send-text/BLOCK.md (runtime: node)
 *
 * Used by:
 *   - src/lib/naseej/manifest.ts (parsing + tolerant listing)
 *   - src/routes/api/components/+server.ts (GET listing + POST validate gate)
 *   - src/lib/naseej/runner.ts (loadCatalog)
 *
 * Forward-compat rules:
 *   - Extra unknown keys are allowed at the top level (strip)
 *   - Input/output `type` is open-string (forward-compat for new primitive types)
 *   - `runtime` is enum: extending requires schema + runner change in lockstep
 */
import { z } from 'zod';

/** Kebab-case slug, must start with a letter. Used for component name + step ids. */
const KebabSlug = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case starting with a letter');

/** Semver shape: major.minor.patch (no pre-release / build metadata in v1). */
const SemverString = z
	.string()
	.regex(/^\d+\.\d+\.\d+$/, 'must be semver: major.minor.patch');

/** Allowed runtimes — extending requires updating the runner's spawn dispatch. */
export const RuntimeEnum = z.enum(['python', 'node']);
export type Runtime = z.infer<typeof RuntimeEnum>;

/** ADR-030 — component kind discriminator. `subprocess` (default) is the
 *  stdin-json primitive every v1 component is (run.py / run.mjs, invocation
 *  contract). `presentation` is a pure template rendered by the `doc-render`
 *  engine — it has NO run entry; it declares `template` + `styles` + `tokens`
 *  instead of `invocation`. Default `subprocess` keeps every existing
 *  component parsing unchanged. */
export const KindEnum = z.enum(['subprocess', 'presentation']);
export type Kind = z.infer<typeof KindEnum>;

/** ADR-030 — presentation template paths, relative to the component dir.
 *  `en` is required (every presentation component renders English); `ar` is
 *  optional (RTL variant). The doc-render engine picks by lang. */
const PresentationTemplate = z
	.object({
		en: z.string().min(1, 'template.en (relative path) required'),
		ar: z.string().optional(),
	})
	.strict();
export type PresentationTemplate = z.infer<typeof PresentationTemplate>;

/** ADR-031 — slot taxonomy. The human/AI collaboration boundary per input:
 *  `static` (boilerplate set once, never regenerated), `deterministic`
 *  (computed each run by a pipeline step, no LLM), `judgment` (per-run LLM or
 *  human judgment). Optional on the manifest — `resolveSlots()` applies the
 *  `judgment` default so unclassified inputs are never silently locked. */
export const SlotClassEnum = z.enum(['static', 'deterministic', 'judgment']);
export type SlotClass = z.infer<typeof SlotClassEnum>;

/** Input field. Mirrors what BLOCK.md declares per input. */
const InputField = z
	.object({
		name: z.string().min(1, 'input name required'),
		type: z.string().min(1, 'input type required'),
		required: z.boolean().optional(),
		default: z.unknown().optional(),
		enum: z.array(z.unknown()).optional(),
		min: z.number().optional(),
		max: z.number().optional(),
		description: z.string().optional(),
		/** ADR-031 — default slot class for this input (recipes override per
		 *  instance). Omit to leave the input as `judgment` (the safe default). */
		slot_class: SlotClassEnum.optional(),
	})
	.strict();
export type InputField = z.infer<typeof InputField>;

/** Output field. Less constrained than inputs (no required/default semantics). */
const OutputField = z
	.object({
		name: z.string().min(1, 'output name required'),
		type: z.string().min(1, 'output type required'),
		enum: z.array(z.unknown()).optional(),
		description: z.string().optional(),
	})
	.strict();
export type OutputField = z.infer<typeof OutputField>;

/** Invocation contract. v1 only supports stdin-json. */
const Invocation = z
	.object({
		protocol: z.literal('stdin-json'),
		request: z.string().optional(),
		response: z.string().optional(),
		exit_codes: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type Invocation = z.infer<typeof Invocation>;

/** Full BLOCK.md frontmatter schema. */
export const ComponentManifestSchema = z
	.object({
		name: KebabSlug,
		version: SemverString,
		type: z.literal('component').optional(),
		/** ADR-030 — see KindEnum. Default `subprocess` for back-compat. */
		kind: KindEnum.default('subprocess'),
		category: z.string().optional(),
		runtime: RuntimeEnum.default('node'),
		description: z.string().optional(),
		author: z.string().optional(),
		project: z.string().optional(),
		/** ADR-006 D4 — two-tier catalog model. Tier 1: capability (generic
		 *  protocol-shaped, configured per use-case, e.g. `shell-exec`). Tier 2:
		 *  domain adapter (typed wrapper over an external system, e.g.
		 *  `katib-build`, `vault-write`). Defaults to 2 so existing components
		 *  pre-ADR-006 keep parsing without migration. */
		tier: z.union([z.literal(1), z.literal(2)]).default(2),
		/** ADR-023 — component shape discriminator. `default` (most components:
		 *  passive subprocess with exit 0/non-zero, no pause). `agentic` (UI hint:
		 *  surfaces agent-style metadata; e.g. `agent-dispatch`). `gate` (runner
		 *  applies the stdout-code-2 pause-intercept protocol; required for
		 *  `human-form` + `approval-gate`). Default preserves pre-ADR-023 behaviour. */
		shape: z.enum(['default', 'agentic', 'gate']).default('default'),
		/** ADR-027 — typed catalog vocabulary for AI-as-author. Two optional
		 *  string fields surface in the catalog-index so authoring agents can
		 *  pick the right component without parsing body prose. Frontmatter
		 *  not body — body sections may exist alongside (human-readable),
		 *  but the index reads from frontmatter only. */
		when_to_use: z.string().optional(),
		when_not_to_use: z.string().optional(),
		inputs: z.array(InputField).default([]),
		outputs: z.array(OutputField).default([]),
		invocation: Invocation.optional(),
		/** ADR-030 — presentation-kind fields. Optional at the schema level so
		 *  subprocess components are unaffected; the superRefine below requires
		 *  them when `kind: presentation`. `template` paths + `styles` path are
		 *  relative to the component dir; `tokens` lists the brand CSS variables
		 *  the template consumes (gate check: every `var(--x)` is declared). */
		template: PresentationTemplate.optional(),
		styles: z.string().optional(),
		tokens: z.array(z.string()).optional(),
		languages: z.array(z.string()).optional(),
		/** Page-break behaviour for presentation components. `avoid` keeps the
		 *  whole component on one page (the engine wraps its section in
		 *  break-inside: avoid) so an atomic block — a pull-quote, callout,
		 *  figure, cover — never splits across a page boundary; if it does not
		 *  fit it moves to the next page. `auto` (default) lets long prose
		 *  (modules) flow across pages naturally. */
		break_inside: z.enum(['avoid', 'auto']).optional(),
		/** ADR-030 CP3 — representative inputs the `renders_standalone` publish
		 *  gate feeds to `doc-render` to render this component alone in EN + AR.
		 *  Required for presentation components (enforced in superRefine); ignored
		 *  for subprocess components. Mirrors katib's `component.py test` samples. */
		sample_inputs: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough()
	.superRefine((v, ctx) => {
		const inputNames = (v.inputs ?? []).map((i) => i.name);
		const inputDup = inputNames.find((n, i) => inputNames.indexOf(n) !== i);
		if (inputDup) {
			ctx.addIssue({
				code: 'custom',
				path: ['inputs'],
				message: `duplicate input name: "${inputDup}"`,
			});
		}
		const outputNames = (v.outputs ?? []).map((o) => o.name);
		const outputDup = outputNames.find((n, i) => outputNames.indexOf(n) !== i);
		if (outputDup) {
			ctx.addIssue({
				code: 'custom',
				path: ['outputs'],
				message: `duplicate output name: "${outputDup}"`,
			});
		}
		// ADR-030 — presentation components must declare what they render.
		if (v.kind === 'presentation') {
			if (!v.template) {
				ctx.addIssue({
					code: 'custom',
					path: ['template'],
					message: 'kind: presentation requires `template` (at least template.en)',
				});
			}
			if (!v.styles) {
				ctx.addIssue({
					code: 'custom',
					path: ['styles'],
					message: 'kind: presentation requires `styles` (relative path to the CSS)',
				});
			}
			if (!v.tokens || v.tokens.length === 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['tokens'],
					message:
						'kind: presentation requires `tokens` (the brand CSS variables the template consumes)',
				});
			}
			if (!v.sample_inputs || Object.keys(v.sample_inputs).length === 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['sample_inputs'],
					message:
						'kind: presentation requires `sample_inputs` (representative inputs for the renders_standalone gate)',
				});
			}
		}
	});

export type ComponentManifest = z.infer<typeof ComponentManifestSchema>;

/** ADR-030 — narrow a manifest to the presentation kind. After this guard the
 *  presentation fields (template / styles / tokens) are guaranteed present
 *  because the schema's superRefine rejected a presentation manifest missing
 *  them. */
export function isPresentationManifest(m: ComponentManifest): boolean {
	return m.kind === 'presentation';
}

/** Parse + validate. Throws ZodError on failure. */
export function parseComponentManifest(raw: unknown): ComponentManifest {
	return ComponentManifestSchema.parse(raw);
}

/** Parse + validate. Returns `{ ok: true, data }` or `{ ok: false, error }`. */
export function safeParseComponentManifest(
	raw: unknown,
): { ok: true; data: ComponentManifest } | { ok: false; errors: z.core.$ZodIssue[] } {
	const result = ComponentManifestSchema.safeParse(raw);
	if (result.success) return { ok: true, data: result.data };
	return { ok: false, errors: result.error.issues };
}
