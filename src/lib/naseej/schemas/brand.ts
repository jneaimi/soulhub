/**
 * Zod schema for a Naseej brand profile (ADR-031 CP1).
 *
 * A brand profile is catalog data at `catalog/brands/<slug>/brand.yaml`. It is
 * the override layer over the shipped base tokens (the doc-render engine's
 * `render_core/tokens.base.yaml`): colors, fonts, identity, logo. doc-render
 * resolves a brand by slug, deep-merges it over the base tokens, and renders.
 *
 * The CSS-color whitelist mirrors the vendored core's `_validate_color`
 * (render_core/tokens.py) — a brand carries operator-supplied color values, so
 * the same injection guard applies on the TS side (the publish gate) as on the
 * Python side (render time).
 *
 * Used by:
 *   - src/lib/naseej/brand-manifest.ts (load + tolerant scan of catalog/brands/)
 *   - src/routes/api/brands/+server.ts (GET list + POST validation gate)
 *   - src/lib/naseej/brand-index.ts (brand-index.json projection)
 */
import { z } from 'zod';

/** CSS color whitelist — keep in lockstep with render_core/tokens.py `_COLOR_PATTERNS`. */
const CSS_COLOR_PATTERNS: RegExp[] = [
	/^#[0-9a-fA-F]{3,8}$/,
	/^rgba?\(\s*[\d.,\s%/]+\s*\)$/,
	/^hsla?\(\s*[\d.,\s%/deg]+\s*\)$/,
	/^[a-zA-Z][a-zA-Z0-9-]*$/, // named colors (forward-compat; not exhaustively checked)
];

const CssColor = z.string().refine((v) => CSS_COLOR_PATTERNS.some((re) => re.test(v)), {
	message: 'not a recognized CSS color (accepted: #hex, rgb()/rgba(), hsl()/hsla(), named)',
});

/** Per-language font stack. All optional — the base tokens supply defaults. */
const FontStack = z
	.object({
		primary: z.string().optional(),
		display: z.string().optional(),
		mono: z.string().optional(),
		fallback: z.string().optional(),
	})
	.passthrough();

const Logo = z
	.object({
		/** Path to the logo asset, relative to the brand dir or absolute. */
		primary: z.string().nullable().optional(),
		max_height_mm: z.number().int().min(1).max(200).optional(),
	})
	.passthrough();

/** Full brand profile. `.passthrough()` keeps forward-compat for keys the
 *  engine doesn't read yet (e.g. charts palette, covers presets in Phase 2). */
export const BrandProfileSchema = z
	.object({
		/** Brand display name. Either a plain string or an {en, ar} pair. */
		name: z.union([z.string().min(1), z.object({ en: z.string(), ar: z.string().optional() })]),
		colors: z.record(z.string(), CssColor).optional(),
		fonts: z
			.object({ en: FontStack.optional(), ar: FontStack.optional() })
			.passthrough()
			.optional(),
		identity: z.record(z.string(), z.unknown()).optional(),
		logo: Logo.optional(),
	})
	.passthrough();

export type BrandProfile = z.infer<typeof BrandProfileSchema>;

/** Parse + validate. Returns `{ ok: true, data }` or `{ ok: false, errors }`. */
export function safeParseBrandProfile(
	raw: unknown,
): { ok: true; data: BrandProfile } | { ok: false; errors: z.core.$ZodIssue[] } {
	const result = BrandProfileSchema.safeParse(raw);
	if (result.success) return { ok: true, data: result.data };
	return { ok: false, errors: result.error.issues };
}

/** Resolve a brand `name` (string | {en,ar}) to a display string for an index. */
export function brandDisplayName(name: BrandProfile['name']): string {
	return typeof name === 'string' ? name : name.en;
}
