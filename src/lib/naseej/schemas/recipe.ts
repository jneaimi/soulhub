/**
 * Zod schema for Naseej recipe.yaml.
 *
 * Shape grounded in the 2 v1 recipes shipped 2026-05-16:
 *   - catalog/recipes/hello-naseej/recipe.yaml
 *   - catalog/recipes/quality-check-and-log/recipe.yaml
 *
 * Used by:
 *   - src/lib/naseej/runner.ts (loadRecipe — replaces ad-hoc typeof checks)
 *   - src/routes/api/recipes/+server.ts (POST validate gate)
 *
 * Cross-step semantic checks (depends_on resolves to a step id, no cycles,
 * referenced component exists in catalog, version pin satisfiable, project
 * exists in vault) are NOT in the schema — they live in the validator/runner
 * because they need external state.
 */
import { z } from 'zod';

const KebabSlug = z
	.string()
	.regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case starting with a letter');

const SemverString = z
	.string()
	.regex(/^\d+\.\d+\.\d+$/, 'must be semver: major.minor.patch');

/** Component reference: `name@version` (pinned) or bare `name` (any version). */
const ComponentRef = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]*(@\d+\.\d+\.\d+)?$/,
		'must be `name` or `name@version` where version is semver',
	);

/** Recipe-level input declaration (ADR-006 D1).
 *
 * Typed discriminated union over five known types: `string | integer | boolean
 * | file | date`. A free-form fallback (`RecipeInputAny`) accepts arbitrary
 * `type:` labels for forward-compat, with one constraint — it refuses the five
 * known type names so authors cannot silently downgrade a `file` input that
 * forgot its `path:` field. Order matters in the union: typed schemas tried
 * first, fallback last. */
const KNOWN_TYPED_INPUTS = ['string', 'integer', 'boolean', 'file', 'date'] as const;

const RecipeInputBase = z.object({
	name: z.string().min(1, 'input name required'),
	required: z.boolean().optional(),
	default: z.unknown().optional(),
	description: z.string().optional(),
});

const RecipeInputString = RecipeInputBase.extend({
	type: z.literal('string'),
}).strict();

const RecipeInputInteger = RecipeInputBase.extend({
	type: z.literal('integer'),
}).strict();

const RecipeInputBoolean = RecipeInputBase.extend({
	type: z.literal('boolean'),
}).strict();

/** File input — `path:` is a template resolved at recipe-start against the
 *  inputs ctx; `must_exist: true` triggers a stat check before any step runs. */
const RecipeInputFile = RecipeInputBase.extend({
	type: z.literal('file'),
	path: z.string().min(1, 'file input requires `path:` template'),
	must_exist: z.boolean().optional(),
}).strict();

/** Date input — currently a string with format hint; format-level validation
 *  is deferred. The runner trusts the operator/default value verbatim. */
const RecipeInputDate = RecipeInputBase.extend({
	type: z.literal('date'),
	format: z.string().optional(),
}).strict();

/** Fallback for unknown type labels. Refuses the five known names so an
 *  invalid `type: file` (missing `path:`) cannot quietly match the fallback. */
const RecipeInputAny = RecipeInputBase.extend({
	type: z.string().min(1, 'input type required').refine(
		(t) => !KNOWN_TYPED_INPUTS.includes(t as (typeof KNOWN_TYPED_INPUTS)[number]),
		{ message: 'type matches a known typed input — provide all required fields' },
	),
}).strict();

const RecipeInput = z.union([
	RecipeInputString,
	RecipeInputInteger,
	RecipeInputBoolean,
	RecipeInputFile,
	RecipeInputDate,
	RecipeInputAny,
]);
export type RecipeInput = z.infer<typeof RecipeInput>;
export type RecipeInputTyped =
	| z.infer<typeof RecipeInputString>
	| z.infer<typeof RecipeInputInteger>
	| z.infer<typeof RecipeInputBoolean>
	| z.infer<typeof RecipeInputFile>
	| z.infer<typeof RecipeInputDate>;

/** Type guard for file inputs — used by the runner to drive `must_exist`
 *  + `path:` interpolation. */
export function isFileInput(def: RecipeInput): def is z.infer<typeof RecipeInputFile> {
	return (def as { type?: unknown }).type === 'file';
}

/** Component-flavored step — invokes a subprocess from catalog/components/. */
const ComponentStepSchema = z
	.object({
		id: KebabSlug,
		component: ComponentRef,
		depends_on: z.array(z.string()).optional(),
		on_failure: z.enum(['halt', 'continue']).optional(),
		inputs: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type ComponentStep = z.infer<typeof ComponentStepSchema>;

/** Recipe step. Post-ADR-023 (CP6 2026-05-20): the recipe layer recognises
 *  exactly ONE step type — the component step. The legacy `agent:`, `human:`,
 *  and `gate:` step types collapsed into first-class catalog components:
 *  `agent-dispatch@1.0.0`, `human-form@1.0.0`, `approval-gate@1.0.0`. The
 *  pause-intercept lives at the runner layer, gated on `manifest.shape === 'gate'`.
 *  See [[adr-023-component-first-uniformity]] + ADR-026 foundation reset. */
const RecipeStepSchema = ComponentStepSchema;
export type RecipeStep = ComponentStep;

/** Type guard — kept as an identity check so existing call sites continue
 *  compiling. Returns true for every step in the post-ADR-023 world since
 *  ComponentStep is the only kind. */
export function isComponentStep(step: RecipeStep): step is ComponentStep {
	return 'component' in step;
}

/** Full recipe.yaml schema. ADR-003 requires `project:` so it's required here. */
export const RecipeSchema = z
	.object({
		name: KebabSlug,
		version: SemverString,
		project: KebabSlug,
		description: z.string().optional(),
		inputs: z.array(RecipeInput).default([]),
		steps: z.array(RecipeStepSchema).min(1, 'recipe must have at least one step'),
		max_parallelism: z.number().int().positive().max(16).optional(),
	})
	.passthrough()
	.superRefine((v, ctx) => {
		// Step ids unique
		const ids = v.steps.map((s) => s.id);
		const dup = ids.find((id, i) => ids.indexOf(id) !== i);
		if (dup) {
			ctx.addIssue({
				code: 'custom',
				path: ['steps'],
				message: `duplicate step id: "${dup}"`,
			});
		}
		// depends_on targets resolve to known step ids
		const idSet = new Set(ids);
		v.steps.forEach((step, i) => {
			for (const dep of step.depends_on ?? []) {
				if (!idSet.has(dep)) {
					ctx.addIssue({
						code: 'custom',
						path: ['steps', i, 'depends_on'],
						message: `step "${step.id}" depends on unknown step "${dep}"`,
					});
				}
			}
		});
		// Recipe input names unique
		const inputNames = (v.inputs ?? []).map((i) => i.name);
		const inputDup = inputNames.find((n, i) => inputNames.indexOf(n) !== i);
		if (inputDup) {
			ctx.addIssue({
				code: 'custom',
				path: ['inputs'],
				message: `duplicate input name: "${inputDup}"`,
			});
		}
	});

export type Recipe = z.infer<typeof RecipeSchema>;

/** Parse a component reference into `{ name, version | null }`. */
export function parseComponentRef(ref: string): { name: string; version: string | null } {
	const idx = ref.indexOf('@');
	if (idx === -1) return { name: ref, version: null };
	return { name: ref.slice(0, idx), version: ref.slice(idx + 1) };
}

/** Parse + validate. Throws ZodError on failure. */
export function parseRecipe(raw: unknown): Recipe {
	return RecipeSchema.parse(raw);
}

/** Parse + validate. Returns `{ ok: true, data }` or `{ ok: false, errors }`. */
export function safeParseRecipe(
	raw: unknown,
): { ok: true; data: Recipe } | { ok: false; errors: z.core.$ZodIssue[] } {
	const result = RecipeSchema.safeParse(raw);
	if (result.success) return { ok: true, data: result.data };
	return { ok: false, errors: result.error.issues };
}
