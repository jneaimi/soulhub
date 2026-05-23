/**
 * Shared Naseej manifest module.
 *
 * Replaces the duplicated `extractFrontmatter` + ad-hoc parsing that lived
 * in both src/lib/naseej/runner.ts and src/routes/api/components/+server.ts.
 *
 * Two access modes:
 *   - loadComponentManifest(dir)        — strict; throws ZodError on invalid
 *   - loadComponentManifestSafe(dir)    — tolerant; returns ok/error result
 *   - loadAllComponentManifests(dir)    — listing; silently skips invalid
 *                                          dirs so a broken component never
 *                                          breaks the marketplace listing
 *
 * Disk layout assumption: each component is `<catalogDir>/<slug>/BLOCK.md` +
 * a `run.py` (python) or `run.mjs` (node) entry. The schema validates the
 * frontmatter shape; existence of the entry file is checked separately by
 * callers that care (POST /api/components validate gate).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
	type ComponentManifest,
	parseComponentManifest,
	safeParseComponentManifest,
} from './schemas/component.js';

/** Default catalog dir relative to soul-hub cwd. */
export const DEFAULT_CATALOG_DIR = resolvePath(process.cwd(), 'catalog/components');

/** Rich manifest enriched with disk-location metadata. */
export interface ComponentRecord {
	manifest: ComponentManifest;
	/** Absolute path of the component directory. */
	dir: string;
	/** Slug-of-disk-dir (may differ from manifest.name in pathological cases). */
	dir_slug: string;
	/** Absolute path of the entry file (run.py / run.mjs). May not exist on disk. */
	entry: string;
	/** Stable id `name@version` for catalog indexing. */
	id: string;
	/** Repo-relative manifest path for debugging / responses. */
	manifest_path: string;
}

/** Parse the YAML frontmatter block at the top of a BLOCK.md file body. */
export function extractFrontmatter(raw: string): unknown | null {
	const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
	if (!m) return null;
	try {
		const parsed = parseYaml(m[1]);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? parsed
			: null;
	} catch {
		return null;
	}
}

/** Derive the entry-file absolute path from runtime. */
export function entryPathFor(componentDir: string, runtime: ComponentManifest['runtime']): string {
	return runtime === 'python'
		? join(componentDir, 'run.py')
		: join(componentDir, 'run.mjs');
}

/** Check whether a file exists (any type) at the given absolute path. */
export async function fileExists(absPath: string): Promise<boolean> {
	try {
		await stat(absPath);
		return true;
	} catch {
		return false;
	}
}

/** Build a ComponentRecord from a component dir. Strict — throws on bad frontmatter. */
export async function loadComponentManifest(
	componentDir: string,
	catalogDir: string = DEFAULT_CATALOG_DIR,
): Promise<ComponentRecord> {
	const blockPath = join(componentDir, 'BLOCK.md');
	const raw = await readFile(blockPath, 'utf-8');
	const fm = extractFrontmatter(raw);
	if (!fm) {
		throw new Error(`BLOCK.md at ${blockPath} has no YAML frontmatter`);
	}
	const manifest = parseComponentManifest(fm);
	const dir_slug = componentDir.startsWith(catalogDir + '/')
		? componentDir.slice(catalogDir.length + 1)
		: componentDir.split('/').pop()!;
	return {
		manifest,
		dir: componentDir,
		dir_slug,
		entry: entryPathFor(componentDir, manifest.runtime),
		id: `${manifest.name}@${manifest.version}`,
		manifest_path: `catalog/components/${dir_slug}/BLOCK.md`,
	};
}

/** Tolerant variant — returns `{ ok, data | errors }` instead of throwing.
 *  Use this in the POST validate gate to return structured errors.
 *
 *  ADR-005 CP4 tech-debt cleanup: the original signature reached for the
 *  errors type via a `ReturnType<...> extends { ok: false; errors: infer E }`
 *  conditional, but the Zod v4 result-type union didn't narrow as expected
 *  and the inferred type resolved to `never` (svelte-check caught this in
 *  CP2). Pulling the type directly from `z.core.$ZodIssue[]` — the shape
 *  `safeParseComponentManifest` actually returns — fixes the narrowing
 *  while keeping the API identical. */
export async function loadComponentManifestSafe(
	componentDir: string,
	catalogDir: string = DEFAULT_CATALOG_DIR,
): Promise<
	| { ok: true; record: ComponentRecord }
	| { ok: false; reason: 'missing_block_md'; detail: string }
	| { ok: false; reason: 'no_frontmatter'; detail: string }
	| { ok: false; reason: 'schema_invalid'; errors: z.core.$ZodIssue[] }
> {
	const blockPath = join(componentDir, 'BLOCK.md');
	let raw: string;
	try {
		raw = await readFile(blockPath, 'utf-8');
	} catch {
		return { ok: false, reason: 'missing_block_md', detail: blockPath };
	}
	const fm = extractFrontmatter(raw);
	if (!fm) {
		return { ok: false, reason: 'no_frontmatter', detail: blockPath };
	}
	const parsed = safeParseComponentManifest(fm);
	if (!parsed.ok) {
		return { ok: false, reason: 'schema_invalid', errors: parsed.errors };
	}
	const dir_slug = componentDir.startsWith(catalogDir + '/')
		? componentDir.slice(catalogDir.length + 1)
		: componentDir.split('/').pop()!;
	return {
		ok: true,
		record: {
			manifest: parsed.data,
			dir: componentDir,
			dir_slug,
			entry: entryPathFor(componentDir, parsed.data.runtime),
			id: `${parsed.data.name}@${parsed.data.version}`,
			manifest_path: `catalog/components/${dir_slug}/BLOCK.md`,
		},
	};
}

/** Scan the catalog dir. Silently skips dirs with no BLOCK.md or invalid frontmatter
 *  so a single broken component never breaks the marketplace listing. */
export async function loadAllComponentManifests(
	catalogDir: string = DEFAULT_CATALOG_DIR,
): Promise<ComponentRecord[]> {
	let entries: string[];
	try {
		entries = await readdir(catalogDir);
	} catch {
		return [];
	}
	const out: ComponentRecord[] = [];
	for (const dir of entries) {
		const componentDir = join(catalogDir, dir);
		const result = await loadComponentManifestSafe(componentDir, catalogDir);
		if (result.ok) out.push(result.record);
	}
	out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
	return out;
}

/** Build a name→record map (and `name@version`→record map) for catalog lookups.
 *  Bare `name` resolves to the first version encountered in scan order.
 *  Same shape the runner uses today via its private loadCatalog(). */
export async function buildCatalogIndex(
	catalogDir: string = DEFAULT_CATALOG_DIR,
): Promise<Map<string, ComponentRecord>> {
	const all = await loadAllComponentManifests(catalogDir);
	const index = new Map<string, ComponentRecord>();
	for (const rec of all) {
		index.set(rec.id, rec);
		if (!index.has(rec.manifest.name)) {
			index.set(rec.manifest.name, rec);
		}
	}
	return index;
}
