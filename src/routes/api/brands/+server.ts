/**
 * /api/brands — Naseej brand profile catalog (ADR-031 CP1, ADR-032 CP1).
 *
 * GET   ?q=         — list all valid brand profiles (substring on slug + name).
 * POST  { slug }    — validate the on-disk brand profile against the brand gate.
 *
 * The gate (shared with PUT /api/brands/[slug] via `validateBrandProfile`):
 *   1. manifest_schema — brand.yaml parses + every color is a valid CSS color
 *   2. logo_exists     — if logo.primary is declared, the asset exists on disk
 *
 * Status codes: 200 passed · 422 a check failed · 404 brand dir missing · 400 bad body.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	DEFAULT_BRANDS_DIR,
	BRAND_SLUG_RE,
	loadAllBrands,
	validateBrandProfile,
	type BrandCheck,
} from '$lib/naseej/brand-manifest.js';
import { brandDisplayName } from '$lib/naseej/schemas/brand.js';
import { regenBrandIndexBestEffort } from '$lib/naseej/brand-index.js';

interface BrandValidateResult {
	brand: string;
	status: 'passed' | 'failed';
	checks: BrandCheck[];
}

/** GET /api/brands — list brand profiles. */
export const GET: RequestHandler = async ({ url }) => {
	const records = await loadAllBrands();
	const q = url.searchParams.get('q')?.toLowerCase() || null;
	const results = records
		.map((r) => ({
			slug: r.slug,
			name: brandDisplayName(r.profile.name),
			colors: Object.keys(r.profile.colors ?? {}).length,
			/** Up to 6 color values for list-card swatch dots (ADR-032 CP2). */
			swatches: Object.values(r.profile.colors ?? {}).slice(0, 6),
			has_logo: typeof r.profile.logo?.primary === 'string' && !!r.profile.logo.primary,
			brand_path: r.brand_path,
		}))
		.filter((b) => {
			if (!q) return true;
			return `${b.slug} ${b.name}`.toLowerCase().includes(q);
		});
	return json({ results, total: results.length });
};

/** POST /api/brands — validate the on-disk brand profile by slug. */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const { slug } = (body as Record<string, unknown>) ?? {};
	if (typeof slug !== 'string' || !slug) {
		return json({ error: 'slug (string) is required' }, { status: 400 });
	}
	if (!BRAND_SLUG_RE.test(slug)) {
		return json(
			{ error: `slug must match ${BRAND_SLUG_RE.source} (kebab-case, starts with a letter)` },
			{ status: 400 },
		);
	}

	const dir = join(DEFAULT_BRANDS_DIR, slug);
	let rawText: string;
	try {
		rawText = await readFile(join(dir, 'brand.yaml'), 'utf-8');
	} catch {
		return json({ error: `brand not found: catalog/brands/${slug}` }, { status: 404 });
	}
	let raw: unknown;
	try {
		raw = parseYaml(rawText);
	} catch (e) {
		const result: BrandValidateResult = {
			brand: slug,
			status: 'failed',
			checks: [
				{
					name: 'manifest_schema',
					status: 'failed',
					errors: [{ path: [], message: `invalid_yaml: ${e instanceof Error ? e.message : String(e)}` }],
				},
			],
		};
		return json(result, { status: 422 });
	}

	const gate = await validateBrandProfile(raw, dir);
	if (gate.ok) void regenBrandIndexBestEffort();
	const result: BrandValidateResult = {
		brand: slug,
		status: gate.ok ? 'passed' : 'failed',
		checks: gate.checks,
	};
	return json(result, { status: gate.ok ? 200 : 422 });
};
