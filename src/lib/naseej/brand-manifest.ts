/**
 * Brand profile loading (ADR-031 CP1).
 *
 * Disk layout: each brand is `catalog/brands/<slug>/brand.yaml` plus sidecar
 * assets (e.g. a logo). Mirrors the component layout (`<slug>/BLOCK.md`) and the
 * same tolerant-scan posture: a single malformed brand never breaks the listing.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fileExists } from './manifest.js';
import { BrandProfileSchema, safeParseBrandProfile, type BrandProfile } from './schemas/brand.js';

/** Default brands dir relative to soul-hub cwd. */
export const DEFAULT_BRANDS_DIR = resolvePath(process.cwd(), 'catalog/brands');

/** Slug pattern — kebab-case, starts with a letter. Blocks path traversal. */
export const BRAND_SLUG_RE = /^[a-z][a-z0-9-]*$/;

export interface BrandRecord {
	slug: string;
	profile: BrandProfile;
	dir: string;
	brand_path: string; // repo-relative
	/** Absolute logo path if the profile declares one (existence checked separately). */
	logoPath: string | null;
}

export type LoadBrandResult =
	| { ok: true; record: BrandRecord }
	| { ok: false; reason: 'not_found' | 'unreadable' | 'invalid_yaml' | 'schema_invalid'; detail?: string; errors?: unknown[] };

/** Load + validate one brand by slug from a brands dir. */
export async function loadBrandSafe(
	slug: string,
	brandsDir: string = DEFAULT_BRANDS_DIR,
): Promise<LoadBrandResult> {
	const dir = join(brandsDir, slug);
	const brandPath = join(dir, 'brand.yaml');
	let raw: string;
	try {
		raw = await readFile(brandPath, 'utf-8');
	} catch {
		return { ok: false, reason: 'not_found', detail: `no brand.yaml at ${brandPath}` };
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (e) {
		return { ok: false, reason: 'invalid_yaml', detail: e instanceof Error ? e.message : String(e) };
	}
	const result = safeParseBrandProfile(parsed);
	if (!result.ok) {
		return { ok: false, reason: 'schema_invalid', errors: result.errors };
	}
	const logoPrimary = result.data.logo?.primary;
	let logoPath: string | null = null;
	if (typeof logoPrimary === 'string' && logoPrimary) {
		logoPath = logoPrimary.startsWith('/') ? logoPrimary : join(dir, logoPrimary);
	}
	return {
		ok: true,
		record: {
			slug,
			profile: result.data,
			dir,
			brand_path: `catalog/brands/${slug}/brand.yaml`,
			logoPath,
		},
	};
}

/** Tolerant scan of the brands dir — invalid brands silently skipped. */
export async function loadAllBrands(brandsDir: string = DEFAULT_BRANDS_DIR): Promise<BrandRecord[]> {
	let entries: string[];
	try {
		entries = await readdir(brandsDir);
	} catch {
		return [];
	}
	const out: BrandRecord[] = [];
	for (const slug of entries) {
		if (!BRAND_SLUG_RE.test(slug)) continue;
		const result = await loadBrandSafe(slug, brandsDir);
		if (result.ok) out.push(result.record);
	}
	out.sort((a, b) => a.slug.localeCompare(b.slug));
	return out;
}

/** One brand-gate check. Shared by POST /api/brands (validate on disk) and
 *  PUT /api/brands/[slug] (validate-then-write a posted profile). */
export type BrandCheck =
	| { name: 'manifest_schema'; status: 'passed' | 'failed'; errors?: unknown[] }
	| { name: 'logo_exists'; status: 'passed' | 'failed' | 'skipped'; detail?: string };

export interface BrandGateResult {
	ok: boolean;
	checks: BrandCheck[];
	profile?: BrandProfile;
	/** Absolute logo path resolved against `brandDir` (null when no logo). */
	logoPath: string | null;
}

/** The shared brand gate (ADR-032 CP1): schema parse + CSS-color injection guard
 *  (both via `BrandProfileSchema`) + `logo_exists`. Takes a RAW value (a posted
 *  JSON object, or a parsed brand.yaml) and the brand dir the logo resolves
 *  against. POST loads-from-disk → validates; PUT parses-the-body → validates →
 *  writes only on `ok`. One code path so the two cannot diverge. */
export async function validateBrandProfile(
	raw: unknown,
	brandDir: string,
): Promise<BrandGateResult> {
	const parsed = safeParseBrandProfile(raw);
	if (!parsed.ok) {
		return {
			ok: false,
			checks: [{ name: 'manifest_schema', status: 'failed', errors: parsed.errors }],
			logoPath: null,
		};
	}
	const checks: BrandCheck[] = [{ name: 'manifest_schema', status: 'passed' }];
	const logoPrimary = parsed.data.logo?.primary;
	let logoPath: string | null = null;
	if (typeof logoPrimary === 'string' && logoPrimary) {
		logoPath = logoPrimary.startsWith('/') ? logoPrimary : join(brandDir, logoPrimary);
		const present = await fileExists(logoPath);
		checks.push(
			present
				? { name: 'logo_exists', status: 'passed' }
				: {
						name: 'logo_exists',
						status: 'failed',
						detail: `logo.primary declared but not found at ${logoPath.replace(process.cwd() + '/', '')}`,
				  },
		);
	} else {
		checks.push({ name: 'logo_exists', status: 'skipped', detail: 'no logo declared' });
	}
	return { ok: !checks.some((c) => c.status === 'failed'), checks, profile: parsed.data, logoPath };
}

/** Re-export so callers can reach the schema through one module. */
export { BrandProfileSchema, fileExists };
