/**
 * /api/brands/[slug] — read + write one brand profile (ADR-032 CP1).
 *
 * GET — the full profile for the editor (404 if absent).
 * PUT — validate-then-write: validate the posted profile via the shared
 *       `validateBrandProfile` gate; on pass, write brand.yaml atomically
 *       (tmp + rename, creating the brand dir if new) and regen brand-index;
 *       on fail, return the checks and write nothing.
 *
 * Path-traversal defence: the slug must match BRAND_SLUG_RE and the resolved
 * brand dir must stay under DEFAULT_BRANDS_DIR.
 *
 * Status: 200 ok · 422 gate failed · 404 not found (GET) · 400 bad slug/body.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
	DEFAULT_BRANDS_DIR,
	BRAND_SLUG_RE,
	validateBrandProfile,
} from '$lib/naseej/brand-manifest.js';
import { regenBrandIndexBestEffort } from '$lib/naseej/brand-index.js';

/** Resolve + guard the brand dir for a slug. Returns null if the slug is
 *  malformed or escapes DEFAULT_BRANDS_DIR. */
function brandDir(slug: string): string | null {
	// BRAND_SLUG_RE already blocks `/` and `..`; the prefix check is belt-and-braces.
	if (!BRAND_SLUG_RE.test(slug)) return null;
	const dir = join(DEFAULT_BRANDS_DIR, slug);
	return dir.startsWith(DEFAULT_BRANDS_DIR + '/') ? dir : null;
}

export const GET: RequestHandler = async ({ params }) => {
	const slug = params.slug ?? '';
	const dir = brandDir(slug);
	if (!dir) return json({ error: 'invalid slug' }, { status: 400 });
	let text: string;
	try {
		text = await readFile(join(dir, 'brand.yaml'), 'utf-8');
	} catch {
		return json({ error: `brand not found: catalog/brands/${slug}` }, { status: 404 });
	}
	try {
		return json({ slug, profile: parseYaml(text) });
	} catch (e) {
		return json(
			{ error: `brand.yaml is not valid YAML: ${e instanceof Error ? e.message : String(e)}` },
			{ status: 422 },
		);
	}
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const slug = params.slug ?? '';
	const dir = brandDir(slug);
	if (!dir) return json({ error: 'invalid slug (kebab-case, no path segments)' }, { status: 400 });

	let profile: unknown;
	try {
		profile = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
		return json({ error: 'body must be a brand profile object' }, { status: 400 });
	}

	const gate = await validateBrandProfile(profile, dir);
	if (!gate.ok) {
		return json({ brand: slug, status: 'failed', checks: gate.checks }, { status: 422 });
	}

	// Write brand.yaml atomically (tmp + rename), creating the dir if new.
	await mkdir(dir, { recursive: true });
	const yaml = stringifyYaml(profile);
	const tmp = join(dir, `.brand.yaml.tmp.${process.pid}`);
	await writeFile(tmp, yaml, 'utf-8');
	await rename(tmp, join(dir, 'brand.yaml'));

	void regenBrandIndexBestEffort();
	return json({ brand: slug, status: 'passed', checks: gate.checks }, { status: 200 });
};
