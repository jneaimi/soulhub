/**
 * Naseej catalog-index — typed AI-as-author vocabulary.
 *
 * ADR-027 P2.1 deliverable. One JSON document AI authoring agents fetch to
 * compose recipes. Replaces the N+1 BLOCK.md spelunking pattern that scored
 * 3/10 in the ADR-026 foundation-reset audit.
 *
 * Build mode:
 *   - `buildCatalogIndex()`  — pure in-memory build. ~30 ms at current scale.
 *   - `writeCatalogIndexToDisk(idx, path)` — atomic tmp+rename to
 *     `catalog/catalog-index.json`. Pair with the build step so the disk
 *     file is byte-identical to the endpoint response at write time.
 *
 * Shape: see ADR-027 §Index shape. Two top-level maps:
 *   - components: full manifest projection (incl. inputs/outputs/when_to_use,
 *     `kind`, and for presentation components their template/styles/tokens/
 *     languages/sample_inputs) + `used_by_recipes[]` (inverse walk) +
 *     `example_usage` (first step, first alphabetical recipe consumer).
 *   - recipes: name, version, project, description, step_count,
 *     components_used (deduped + sorted), recipe_path.
 *
 * Determinism guarantees: components + recipes object key order is
 * alphabetical (insertion-order JSON.stringify on a Map populated in sort
 * order). used_by_recipes + components_used sorted; example_usage picks
 * the alphabetically-first consumer recipe so the worked example is stable.
 */
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	DEFAULT_CATALOG_DIR,
	loadAllComponentManifests,
	type ComponentRecord,
} from './manifest.js';
import {
	parseComponentRef,
	safeParseRecipe,
	type Recipe,
	type ComponentStep,
} from './schemas/recipe.js';
import type { ComponentManifest, InputField, OutputField } from './schemas/component.js';

/** Default recipes dir relative to soul-hub cwd. */
export const DEFAULT_RECIPES_DIR = resolvePath(process.cwd(), 'catalog/recipes');

/** Disk path of the canonical catalog-index file. */
export const DEFAULT_CATALOG_INDEX_PATH = resolvePath(
	process.cwd(),
	'catalog/catalog-index.json',
);

/** Single component entry as exposed in the index. */
export interface CatalogIndexComponentEntry {
	name: string;
	version: string;
	/** ADR-030 — component kind. `subprocess` (default) is a stdin-json
	 *  primitive with a run entry; `presentation` is a pure template rendered by
	 *  the `doc-render` engine. AI authoring agents filter on this. */
	kind: 'subprocess' | 'presentation';
	tier: 1 | 2;
	shape: 'default' | 'agentic' | 'gate';
	category?: string;
	/** Present for subprocess components; omitted for presentation (no run entry). */
	runtime?: ComponentManifest['runtime'];
	description?: string;
	when_to_use?: string;
	when_not_to_use?: string;
	inputs: InputField[];
	outputs: OutputField[];
	/** ADR-030 — presentation-only metadata (omitted for subprocess components)
	 *  so AI discovers a presentation component's templates + brand tokens beside
	 *  the subprocess primitives. */
	template?: { en: string; ar?: string };
	styles?: string;
	tokens?: string[];
	languages?: string[];
	sample_inputs?: Record<string, unknown>;
	used_by_recipes: string[];
	example_usage: {
		from_recipe: string;
		step: { id: string; component: string; inputs: Record<string, unknown> };
	} | null;
}

/** Single recipe entry as exposed in the index. */
export interface CatalogIndexRecipeEntry {
	name: string;
	version: string;
	project: string;
	description?: string;
	step_count: number;
	components_used: string[];
	recipe_path: string;
}

/** Full catalog-index document. */
export interface CatalogIndex {
	schema_version: 1;
	generated_at: string;
	components: Record<string, CatalogIndexComponentEntry>;
	recipes: Record<string, CatalogIndexRecipeEntry>;
}

interface LoadedRecipe {
	recipe: Recipe;
	recipe_path: string;
	dir_slug: string;
}

/** Walk `catalogDir/recipes/` tolerantly — same posture as `loadAllComponentManifests`.
 *  Invalid YAML / failed schema parse silently skipped so one broken recipe
 *  doesn't poison the catalog-index. */
async function loadAllRecipes(recipesDir: string): Promise<LoadedRecipe[]> {
	let entries: string[];
	try {
		entries = await readdir(recipesDir);
	} catch {
		return [];
	}
	const out: LoadedRecipe[] = [];
	for (const dir of entries) {
		const recipePath = join(recipesDir, dir, 'recipe.yaml');
		let raw: string;
		try {
			raw = await readFile(recipePath, 'utf-8');
		} catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = parseYaml(raw);
		} catch {
			continue;
		}
		const result = safeParseRecipe(parsed);
		if (!result.ok) continue;
		out.push({
			recipe: result.data,
			recipe_path: `catalog/recipes/${dir}/recipe.yaml`,
			dir_slug: dir,
		});
	}
	out.sort((a, b) => a.recipe.name.localeCompare(b.recipe.name));
	return out;
}

/** Compute `components_used` for one recipe — deduped, alphabetical, name only
 *  (no @version pin). The index keys components by bare name, so a recipe
 *  pinning `stop-slop@1.0.0` still surfaces as `stop-slop` in components_used. */
function computeComponentsUsed(recipe: Recipe): string[] {
	const set = new Set<string>();
	for (const step of recipe.steps) {
		set.add(parseComponentRef(step.component).name);
	}
	return Array.from(set).sort();
}

/** Build the example_usage payload for a component from a known step.
 *  Strips depends_on / on_failure — the worked example is "what does a call
 *  to this component look like", not a full recipe step. */
function buildExampleStep(step: ComponentStep): {
	id: string;
	component: string;
	inputs: Record<string, unknown>;
} {
	return {
		id: step.id,
		component: step.component,
		inputs: step.inputs ?? {},
	};
}

/** Build the in-memory catalog-index. Pure — no disk write. */
export async function buildCatalogIndex(opts?: {
	catalogDir?: string;
	recipesDir?: string;
	now?: () => Date;
}): Promise<CatalogIndex> {
	const catalogDir = opts?.catalogDir ?? DEFAULT_CATALOG_DIR;
	const recipesDir = opts?.recipesDir ?? DEFAULT_RECIPES_DIR;
	const now = opts?.now ?? (() => new Date());

	const components: ComponentRecord[] = await loadAllComponentManifests(catalogDir);
	const recipes: LoadedRecipe[] = await loadAllRecipes(recipesDir);

	// Inverse-walk: bare component name → recipes that use it (set for dedup).
	const usedByRecipes = new Map<string, Set<string>>();
	// Inverse-walk: bare component name → first matching step + its recipe slug.
	const exampleFor = new Map<
		string,
		{ from_recipe: string; step: ComponentStep }
	>();

	for (const { recipe } of recipes) {
		for (const step of recipe.steps) {
			const bareName = parseComponentRef(step.component).name;
			let set = usedByRecipes.get(bareName);
			if (!set) {
				set = new Set();
				usedByRecipes.set(bareName, set);
			}
			set.add(recipe.name);
			// First-encounter wins; recipes are iterated in alphabetical order
			// (sorted in loadAllRecipes) so the example is deterministically
			// the alphabetically-first consumer's first matching step.
			if (!exampleFor.has(bareName)) {
				exampleFor.set(bareName, { from_recipe: recipe.name, step });
			}
		}
	}

	// Build components map. Alphabetical key insertion (records sorted by
	// loadAllComponentManifests) → stable JSON.stringify ordering downstream.
	const componentsOut: Record<string, CatalogIndexComponentEntry> = {};
	for (const rec of components) {
		const m = rec.manifest;
		const usedBySet = usedByRecipes.get(m.name);
		const example = exampleFor.get(m.name);
		const isPresentation = m.kind === 'presentation';
		componentsOut[m.name] = {
			name: m.name,
			version: m.version,
			kind: m.kind,
			tier: m.tier,
			shape: m.shape,
			category: m.category,
			// Subprocess components have a runtime + run entry; presentation
			// components are pure templates (no runtime). undefined keys are
			// dropped by JSON.stringify, so subprocess entries are unchanged.
			runtime: isPresentation ? undefined : m.runtime,
			description: m.description,
			when_to_use: m.when_to_use,
			when_not_to_use: m.when_not_to_use,
			inputs: m.inputs,
			outputs: m.outputs,
			// Presentation-only metadata (undefined → omitted for subprocess).
			template: isPresentation ? m.template : undefined,
			styles: isPresentation ? m.styles : undefined,
			tokens: isPresentation ? m.tokens : undefined,
			languages: isPresentation ? m.languages : undefined,
			sample_inputs: isPresentation ? m.sample_inputs : undefined,
			used_by_recipes: usedBySet ? Array.from(usedBySet).sort() : [],
			example_usage: example
				? { from_recipe: example.from_recipe, step: buildExampleStep(example.step) }
				: null,
		};
	}

	// Build recipes map. Alphabetical insertion.
	const recipesOut: Record<string, CatalogIndexRecipeEntry> = {};
	for (const { recipe, recipe_path } of recipes) {
		recipesOut[recipe.name] = {
			name: recipe.name,
			version: recipe.version,
			project: recipe.project,
			description: recipe.description,
			step_count: recipe.steps.length,
			components_used: computeComponentsUsed(recipe),
			recipe_path,
		};
	}

	return {
		schema_version: 1,
		generated_at: now().toISOString(),
		components: componentsOut,
		recipes: recipesOut,
	};
}

/** Serialize a catalog-index with stable 2-space indent + trailing newline.
 *  Endpoint response uses the same serializer so disk + HTTP stay byte-identical. */
export function serializeCatalogIndex(index: CatalogIndex): string {
	return JSON.stringify(index, null, 2) + '\n';
}

/** Atomic disk write — tmp file in the same directory, then rename. Single-writer
 *  SvelteKit + same-directory tmp = no cross-fs concern. */
export async function writeCatalogIndexToDisk(
	index: CatalogIndex,
	outPath: string = DEFAULT_CATALOG_INDEX_PATH,
): Promise<void> {
	const payload = serializeCatalogIndex(index);
	const tmpPath = join(dirname(outPath), `.catalog-index.json.tmp.${process.pid}`);
	await writeFile(tmpPath, payload, 'utf-8');
	await rename(tmpPath, outPath);
}

/** Best-effort regen-and-write. Never throws — the catalog-index is a side
 *  artefact; a write failure must not bring down a successful publish-gate.
 *  Errors are surfaced through the returned status object so callers can log
 *  if they care, but the publish path proceeds either way. */
export async function regenCatalogIndexBestEffort(opts?: {
	catalogDir?: string;
	recipesDir?: string;
	outPath?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const index = await buildCatalogIndex({
			catalogDir: opts?.catalogDir,
			recipesDir: opts?.recipesDir,
		});
		await writeCatalogIndexToDisk(index, opts?.outPath);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Freshness probe for `soul doctor`. Walks every BLOCK.md + recipe.yaml,
 *  takes the max mtime, compares against the disk catalog-index.json mtime.
 *  Fresh iff the index is at-or-after every source file. Missing index file
 *  → `exists: false` (also stale). Missing catalog dirs → `exists: true`
 *  with `newest_source: null` (vacuously fresh — nothing to compare against). */
export interface CatalogIndexFreshness {
	exists: boolean;
	fresh: boolean;
	indexPath: string;
	indexMtime: string | null;
	newestSource: string | null;
	newestSourceMtime: string | null;
	ageSeconds: number | null;
}

async function newestMtimeIn(rootDir: string, leafName: string): Promise<{
	path: string;
	mtimeMs: number;
} | null> {
	let entries: string[];
	try {
		entries = await readdir(rootDir);
	} catch {
		return null;
	}
	let winner: { path: string; mtimeMs: number } | null = null;
	for (const dir of entries) {
		const leafPath = join(rootDir, dir, leafName);
		try {
			const s = await stat(leafPath);
			if (!winner || s.mtimeMs > winner.mtimeMs) {
				winner = { path: leafPath, mtimeMs: s.mtimeMs };
			}
		} catch {
			// dir without the expected leaf — skip
		}
	}
	return winner;
}

export async function getCatalogIndexFreshness(opts?: {
	catalogDir?: string;
	recipesDir?: string;
	indexPath?: string;
}): Promise<CatalogIndexFreshness> {
	const catalogDir = opts?.catalogDir ?? DEFAULT_CATALOG_DIR;
	const recipesDir = opts?.recipesDir ?? DEFAULT_RECIPES_DIR;
	const indexPath = opts?.indexPath ?? DEFAULT_CATALOG_INDEX_PATH;

	let indexMtimeMs: number | null = null;
	try {
		const s = await stat(indexPath);
		indexMtimeMs = s.mtimeMs;
	} catch {
		// index doesn't exist
	}

	const newestBlock = await newestMtimeIn(catalogDir, 'BLOCK.md');
	const newestRecipe = await newestMtimeIn(recipesDir, 'recipe.yaml');

	let newest: { path: string; mtimeMs: number } | null = null;
	for (const candidate of [newestBlock, newestRecipe]) {
		if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) {
			newest = candidate;
		}
	}

	const exists = indexMtimeMs !== null;
	// Fresh iff: index exists AND (no sources OR index mtime >= newest source)
	const fresh = exists && (newest === null || indexMtimeMs! >= newest.mtimeMs);
	const ageSeconds =
		exists && newest !== null
			? Math.round((indexMtimeMs! - newest.mtimeMs) / 1000)
			: null;

	return {
		exists,
		fresh,
		indexPath,
		indexMtime: indexMtimeMs !== null ? new Date(indexMtimeMs).toISOString() : null,
		newestSource: newest ? newest.path : null,
		newestSourceMtime: newest ? new Date(newest.mtimeMs).toISOString() : null,
		ageSeconds,
	};
}
