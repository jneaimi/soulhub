/**
 * Naseej brand-index — AI-discoverable brand catalog (ADR-031 CP1).
 *
 * Sibling of catalog-index. One JSON document at `catalog/brand-index.json`
 * listing every brand profile so authoring agents (and the brand-config UI,
 * ADR-032) can pick a brand by slug without parsing each brand.yaml.
 *
 * Same determinism + atomic-write posture as catalog-index: alphabetical slug
 * order, tmp+rename write, best-effort regen that never throws.
 */
import { rename, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { loadAllBrands, DEFAULT_BRANDS_DIR } from './brand-manifest.js';
import { brandDisplayName } from './schemas/brand.js';

export const DEFAULT_BRAND_INDEX_PATH = resolvePath(process.cwd(), 'catalog/brand-index.json');

export interface BrandIndexEntry {
	slug: string;
	name: string;
	/** Declared color token keys (what this brand overrides). Sorted. */
	colors: string[];
	/** Font languages the brand declares (e.g. ['ar', 'en']). Sorted. */
	languages: string[];
	has_logo: boolean;
	brand_path: string;
}

export interface BrandIndex {
	schema_version: 1;
	generated_at: string;
	brands: Record<string, BrandIndexEntry>;
}

export async function buildBrandIndex(opts?: {
	brandsDir?: string;
	now?: () => Date;
}): Promise<BrandIndex> {
	const brandsDir = opts?.brandsDir ?? DEFAULT_BRANDS_DIR;
	const now = opts?.now ?? (() => new Date());
	const records = await loadAllBrands(brandsDir);

	const brands: Record<string, BrandIndexEntry> = {};
	for (const rec of records) {
		const p = rec.profile;
		const fonts = (p.fonts ?? {}) as Record<string, unknown>;
		brands[rec.slug] = {
			slug: rec.slug,
			name: brandDisplayName(p.name),
			colors: Object.keys(p.colors ?? {}).sort(),
			languages: Object.keys(fonts)
				.filter((k) => k === 'en' || k === 'ar')
				.sort(),
			has_logo: typeof p.logo?.primary === 'string' && !!p.logo.primary,
			brand_path: rec.brand_path,
		};
	}

	return { schema_version: 1, generated_at: now().toISOString(), brands };
}

export function serializeBrandIndex(index: BrandIndex): string {
	return JSON.stringify(index, null, 2) + '\n';
}

export async function writeBrandIndexToDisk(
	index: BrandIndex,
	outPath: string = DEFAULT_BRAND_INDEX_PATH,
): Promise<void> {
	const payload = serializeBrandIndex(index);
	const tmpPath = join(dirname(outPath), `.brand-index.json.tmp.${process.pid}`);
	await writeFile(tmpPath, payload, 'utf-8');
	await rename(tmpPath, outPath);
}

/** Best-effort regen-and-write. Never throws — a brand-index write failure must
 *  not bring down a successful brand validation. */
export async function regenBrandIndexBestEffort(opts?: {
	brandsDir?: string;
	outPath?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const index = await buildBrandIndex({ brandsDir: opts?.brandsDir });
		await writeBrandIndexToDisk(index, opts?.outPath);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
