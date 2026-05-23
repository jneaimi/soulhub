/**
 * /api/recipes — Naseej recipe catalog (listing + publish gate).
 *
 * GET   ?project=&q=          — list recipes under catalog/recipes/.
 * POST  { name: string }      — validate a recipe against the publish gate.
 *
 * The POST publish gate enforces five checks:
 *   1. schema          — recipe.yaml parses against the Zod schema
 *   2. components      — every step.component name exists in the catalog
 *   3. version_pins    — every pinned step.component@<version> resolves to
 *                        an exact-match BLOCK.md (bare names are trivially
 *                        satisfied if any version exists; covered by `components`)
 *   4. agents_exist    — every step.agent resolves to a known ~/.claude/agents/<id>.md
 *                        agent (ADR-005 falsifier #3)
 *   5. project_exists  — recipe.project resolves to ~/vault/projects/<p>/index.md
 *
 * Status codes:
 *   200 — all checks passed (safe to git-add and publish)
 *   422 — recipe exists but a check failed
 *   404 — catalog/recipes/<name>/recipe.yaml doesn't exist
 *   400 — bad request body
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { fileExists } from '$lib/naseej/manifest.js';
import { buildCatalogIndex } from '$lib/naseej/manifest.js';
import { regenCatalogIndexBestEffort } from '$lib/naseej/catalog-index.js';
import {
	isComponentStep,
	parseComponentRef,
	safeParseRecipe,
	type Recipe,
} from '$lib/naseej/schemas/recipe.js';
import { validateTemplating } from '$lib/naseej/templating-validator.js';
import { getAgent } from '$lib/agents/store.js';

const RECIPES_DIR = resolvePath(process.cwd(), 'catalog/recipes');
const VAULT_PROJECTS_DIR = resolvePath(homedir(), 'vault/projects');

const NAME_RE = /^[a-z][a-z0-9-]*$/;

interface RecipeListing {
	name: string;
	version: string;
	project: string;
	description?: string;
	step_count: number;
	recipe_path: string;
}

type CheckResult =
	| { name: 'schema'; status: 'passed' | 'failed'; errors?: unknown[] }
	| {
			name: 'components';
			status: 'passed' | 'failed';
			missing?: Array<{ step: string; component: string }>;
	  }
	| {
			name: 'version_pins';
			status: 'passed' | 'failed';
			unsatisfied?: Array<{
				step: string;
				component: string;
				requested: string;
				available: string;
			}>;
	  }
	| {
			name: 'agents_exist';
			status: 'passed' | 'failed';
			missing?: Array<{ step: string; agent: string }>;
	  }
	| {
			name: 'project_exists';
			status: 'passed' | 'failed';
			project: string;
			vault_path: string;
	  }
	| {
			name: 'templating_resolves';
			status: 'passed' | 'failed';
			issues?: Array<{
				field_path: string;
				raw_expr: string;
				kind: string;
				detail: string;
				suggestion?: string;
			}>;
	  };

interface PublishResult {
	recipe: string;
	version?: string;
	status: 'passed' | 'failed';
	duration_ms: number;
	checks: CheckResult[];
}

/** Scan catalog/recipes/ tolerantly — skips dirs with no recipe.yaml or invalid YAML. */
async function listRecipes(): Promise<RecipeListing[]> {
	let entries: string[];
	try {
		entries = await readdir(RECIPES_DIR);
	} catch {
		return [];
	}
	const out: RecipeListing[] = [];
	for (const dir of entries) {
		const recipePath = join(RECIPES_DIR, dir, 'recipe.yaml');
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
		const r = result.data;
		out.push({
			name: r.name,
			version: r.version,
			project: r.project,
			description: r.description,
			step_count: r.steps.length,
			recipe_path: `catalog/recipes/${dir}/recipe.yaml`,
		});
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/** GET /api/recipes — list Naseej recipes. Filters: ?project=, ?q= */
export const GET: RequestHandler = async ({ url }) => {
	const recipes = await listRecipes();
	const project = url.searchParams.get('project')?.toLowerCase() || null;
	const q = url.searchParams.get('q')?.toLowerCase() || null;

	const results = recipes.filter((r) => {
		if (project && r.project.toLowerCase() !== project) return false;
		if (q) {
			const hay = `${r.name} ${r.description || ''}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		return true;
	});

	const facets = {
		projects: Array.from(new Set(recipes.map((r) => r.project))).sort(),
	};

	return json({ results, total: results.length, facets });
};

/** POST /api/recipes — validate a recipe against the publish gate.
 *  Body: { name: string }   (recipe dir under catalog/recipes/) */
export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const { name } = (body as Record<string, unknown>) ?? {};
	if (typeof name !== 'string' || !name) {
		return json({ error: 'name (string) is required' }, { status: 400 });
	}
	if (!NAME_RE.test(name)) {
		return json(
			{ error: `name must match ${NAME_RE.source} (kebab-case, starts with a letter)` },
			{ status: 400 },
		);
	}

	const recipePath = resolvePath(RECIPES_DIR, name, 'recipe.yaml');
	if (!recipePath.startsWith(RECIPES_DIR + '/')) {
		return json({ error: 'name resolves outside catalog/recipes/' }, { status: 400 });
	}
	if (!(await fileExists(recipePath))) {
		return json(
			{ error: `recipe not found: catalog/recipes/${name}/recipe.yaml` },
			{ status: 404 },
		);
	}

	const startedAt = Date.now();
	const checks: CheckResult[] = [];

	// Check 1: schema
	let raw: string;
	try {
		raw = await readFile(recipePath, 'utf-8');
	} catch (err) {
		return json({ error: `failed to read recipe: ${(err as Error).message}` }, { status: 500 });
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		checks.push({
			name: 'schema',
			status: 'failed',
			errors: [{ path: [], message: `invalid YAML: ${(err as Error).message}` }],
		});
		return json(
			{ recipe: name, status: 'failed', duration_ms: Date.now() - startedAt, checks },
			{ status: 422 },
		);
	}
	const schemaResult = safeParseRecipe(parsed);
	if (!schemaResult.ok) {
		checks.push({ name: 'schema', status: 'failed', errors: schemaResult.errors });
		return json(
			{ recipe: name, status: 'failed', duration_ms: Date.now() - startedAt, checks },
			{ status: 422 },
		);
	}
	checks.push({ name: 'schema', status: 'passed' });
	const recipe: Recipe = schemaResult.data;

	// Check 2 + 3: components exist + version pins satisfiable
	const catalog = await buildCatalogIndex();
	const missing: Array<{ step: string; component: string }> = [];
	const unsatisfied: Array<{
		step: string;
		component: string;
		requested: string;
		available: string;
	}> = [];

	for (const step of recipe.steps) {
		// ADR-005 — only component steps participate in the components check.
		// The agents_exist gate for agent steps lands in CP2; until then,
		// agent steps simply skip this loop instead of crashing on undefined
		// step.component.
		if (!isComponentStep(step)) continue;
		const ref = parseComponentRef(step.component);
		// Look up by exact pin first (if pinned), else by bare name.
		const pinned = catalog.get(step.component);
		const byName = catalog.get(ref.name);
		if (!pinned && !byName) {
			missing.push({ step: step.id, component: step.component });
			continue;
		}
		if (ref.version !== null) {
			// Pinned: require exact match. catalog.get('name@1.0.0') returns the
			// record only if a version 1.0.0 BLOCK.md exists, so a hit on `pinned`
			// is sufficient. A miss here means a different version is published.
			if (!pinned && byName) {
				unsatisfied.push({
					step: step.id,
					component: step.component,
					requested: ref.version,
					available: byName.manifest.version,
				});
			}
		}
	}
	checks.push({
		name: 'components',
		status: missing.length === 0 ? 'passed' : 'failed',
		...(missing.length > 0 ? { missing } : {}),
	});
	checks.push({
		name: 'version_pins',
		status: unsatisfied.length === 0 ? 'passed' : 'failed',
		...(unsatisfied.length > 0 ? { unsatisfied } : {}),
	});

	// Check 4: agents_exist — post-ADR-023 the `agent:` step type is gone;
	// agents are dispatched via the `agent-dispatch@1.0.0` component with the
	// agent slug in `inputs.agent`. Inspect those component steps and verify
	// each referenced agent resolves via the store. Recipes that don't use
	// `agent-dispatch` pass this check trivially.
	const missingAgents: Array<{ step: string; agent: string }> = [];
	for (const step of recipe.steps) {
		if (!isComponentStep(step)) continue;
		const ref = parseComponentRef(step.component);
		if (ref.name !== 'agent-dispatch') continue;
		const agentSlug = step.inputs?.agent;
		if (typeof agentSlug !== 'string' || !agentSlug) continue;
		if (!getAgent(agentSlug)) {
			missingAgents.push({ step: step.id, agent: agentSlug });
		}
	}
	checks.push({
		name: 'agents_exist',
		status: missingAgents.length === 0 ? 'passed' : 'failed',
		...(missingAgents.length > 0 ? { missing: missingAgents } : {}),
	});

	// Check 5: project_exists
	const projectIndex = join(VAULT_PROJECTS_DIR, recipe.project, 'index.md');
	const projectOk = await fileExists(projectIndex);
	checks.push({
		name: 'project_exists',
		status: projectOk ? 'passed' : 'failed',
		project: recipe.project,
		vault_path: `projects/${recipe.project}/index.md`,
	});

	// Check 6: templating_resolves (ADR-006 D8)
	// Walk every templated field; refuse the recipe if any `{{ ref }}` can't
	// be satisfied by globals + recipe inputs + earlier-step outputs.
	const templatingIssues = validateTemplating(recipe, catalog);
	checks.push({
		name: 'templating_resolves',
		status: templatingIssues.length === 0 ? 'passed' : 'failed',
		...(templatingIssues.length > 0
			? {
					issues: templatingIssues.map((i) => ({
						field_path: i.fieldPath.join('.'),
						raw_expr: i.rawExpr,
						kind: i.kind,
						detail: i.detail,
						...(i.suggestion ? { suggestion: i.suggestion } : {}),
					})),
			  }
			: {}),
	});

	const failed = checks.some((c) => c.status === 'failed');
	const result: PublishResult = {
		recipe: recipe.name,
		version: recipe.version,
		status: failed ? 'failed' : 'passed',
		duration_ms: Date.now() - startedAt,
		checks,
	};
	// ADR-027 P2.2 — auto-regen catalog-index on successful publish. Recipes
	// authoring writes the `used_by_recipes[]` + `example_usage` worked-example
	// payload that AI authoring agents consume, so a recipe publish has to
	// trigger a rebuild the same way a component publish does. Best-effort +
	// non-blocking — the publish-gate has passed, a regen miss must not flip it.
	if (!failed) {
		void regenCatalogIndexBestEffort();
	}
	return json(result, { status: failed ? 422 : 200 });
};
