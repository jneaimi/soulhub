/**
 * Zod schema for a Naseej document template (ADR-033 CP1).
 *
 * A document template is catalog data at `catalog/documents/<slug>/document.yaml`.
 * It is a self-contained `{ brand, lang, composition[] }` where each composition
 * entry names a `kind: presentation` component and maps its inputs to a slot
 * `{ class, value? }`. A pipeline instantiates a template each run, filling the
 * `deterministic` + `judgment` slots; the `static` slots carry their value here.
 *
 * Mirrors the brand-profile pattern (schema + tolerant loader + gate + index).
 */
import { z } from 'zod';
import { SlotClassEnum } from './component.js';

/** Kebab slug, must start with a letter (brand slug + component names). */
const KebabSlug = z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case starting with a letter');

/** One slot binding on a composition entry: class override + optional value. */
const SlotBinding = z
	.object({
		class: SlotClassEnum.optional(),
		value: z.unknown().optional(),
	})
	.strict();
export type SlotBinding = z.infer<typeof SlotBinding>;

/** One composition entry — a presentation component instance + its slot map. */
const CompositionEntrySchema = z
	.object({
		component: KebabSlug,
		variant: z.string().optional(),
		slots: z.record(z.string(), SlotBinding).optional(),
		/** Per-instance page-break override. Falls back to the component's own
		 *  `break_inside` default. Use `avoid` to keep a module instance that is
		 *  an atomic box (e.g. an About-the-Author card) whole on one page. */
		break_inside: z.enum(['avoid', 'auto']).optional(),
	})
	.strict();
export type CompositionEntry = z.infer<typeof CompositionEntrySchema>;

export const DocumentTemplateSchema = z
	.object({
		name: z.string().min(1, 'name required'),
		/** Brand slug resolved against catalog/brands/ (ADR-031). */
		brand: KebabSlug,
		/** Default render language. */
		lang: z.enum(['en', 'ar']).default('en'),
		composition: z
			.array(CompositionEntrySchema)
			.min(1, 'composition must have at least one component'),
	})
	.passthrough();

export type DocumentTemplate = z.infer<typeof DocumentTemplateSchema>;

export function safeParseDocumentTemplate(
	raw: unknown,
): { ok: true; data: DocumentTemplate } | { ok: false; errors: z.core.$ZodIssue[] } {
	const result = DocumentTemplateSchema.safeParse(raw);
	if (result.success) return { ok: true, data: result.data };
	return { ok: false, errors: result.error.issues };
}
