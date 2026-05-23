/**
 * Recipe templating validator (ADR-006 D8).
 *
 * Publish-time walk of every step's templated fields verifies that every
 * `{{ ref }}` resolves against the recipe's DAG: recipe-level inputs,
 * earlier-step outputs by topological order, and the runner's context
 * globals (HOME, work_dir, run_id, date, project). Typos are blocked at
 * `POST /api/recipes` instead of leaking to 07:30 Dubai when cron fires.
 *
 * Filter names are validated against the exhaustive ADR-006 D3 set
 * (basename, dirname, human_bytes, date_fmt) — an unknown filter
 * throws at runtime today, but catching it at publish time gives the
 * recipe author a clearer error with a suggestion.
 *
 * Lookup grammar (anything outside this surface is unresolvable):
 *   - `<global>`                       — single segment, must be a known global
 *   - `inputs.<name>`                  — name declared in recipe.inputs
 *   - `steps.<id>.outputs.<name>`      — id earlier in topological order;
 *                                        name declared in that step's outputs
 *
 * Deeper paths like `steps.X.outputs.per_dimension.directness` are accepted
 * up to the fourth segment; the runtime lookup walks the nested object
 * shape, which is component-specific and not declared in BLOCK.md.
 */

import type { ComponentRecord } from './manifest.js';
import {
	isComponentStep,
	isFileInput,
	parseComponentRef,
	type Recipe,
	type RecipeStep,
} from './schemas/recipe.js';

const CTX_GLOBALS = new Set(['HOME', 'work_dir', 'run_id', 'date', 'project']);
const KNOWN_FILTERS = new Set(['basename', 'dirname', 'human_bytes', 'date_fmt']);

export interface TemplateRef {
	/** Pre-filter lookup path, e.g. `steps.foo.outputs.bar` */
	lookup: string;
	/** Filter expressions to the right of the first `|` */
	filters: string[];
	/** Field path inside the recipe where this ref was found */
	fieldPath: string[];
	/** The full `{{ ... }}` source, for error messages */
	rawExpr: string;
}

export type TemplatingIssueKind =
	| 'unknown_input'
	| 'unknown_step'
	| 'forward_ref'
	| 'unknown_output'
	| 'unresolvable'
	| 'unknown_filter';

export interface TemplatingIssue {
	rawExpr: string;
	fieldPath: string[];
	kind: TemplatingIssueKind;
	detail: string;
	suggestion?: string;
}

/** Walk an object/array/string and collect every `{{ ... }}` template ref. */
export function findTemplateRefs(value: unknown, fieldPath: string[]): TemplateRef[] {
	const refs: TemplateRef[] = [];
	if (typeof value === 'string') {
		for (const m of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
			const expr = m[1].trim();
			const parts = expr.split('|').map((p) => p.trim());
			const lookup = parts[0];
			const filters = parts.slice(1).filter((p) => p.length > 0);
			refs.push({ lookup, filters, fieldPath: [...fieldPath], rawExpr: m[0] });
		}
	} else if (Array.isArray(value)) {
		value.forEach((v, i) =>
			refs.push(...findTemplateRefs(v, [...fieldPath, String(i)])),
		);
	} else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			refs.push(...findTemplateRefs(v, [...fieldPath, k]));
		}
	}
	return refs;
}

function levenshtein(a: string, b: string): number {
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array(n + 1).fill(0),
	);
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1]
				? dp[i - 1][j - 1]
				: 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
		}
	}
	return dp[m][n];
}

function closestMatch(needle: string, haystack: Iterable<string>): string | undefined {
	let best: string | undefined;
	let bestDist = Infinity;
	for (const candidate of haystack) {
		const dist = levenshtein(needle, candidate);
		if (dist > 0 && dist <= 2 && dist < bestDist) {
			bestDist = dist;
			best = candidate;
		}
	}
	return best;
}

interface SymbolTable {
	inputs: Set<string>;
	/** Step id → declared outputs (populated as topo-walk progresses). */
	stepOutputs: Map<string, Set<string>>;
	/** Step id → topological order index. */
	stepIndex: Map<string, number>;
}

function resolveRef(
	ref: TemplateRef,
	symbols: SymbolTable,
	currentStepIdx: number | null,
): TemplatingIssue | null {
	const parts = ref.lookup.split('.');
	const first = parts[0];

	if (!first) {
		return {
			rawExpr: ref.rawExpr,
			fieldPath: ref.fieldPath,
			kind: 'unresolvable',
			detail: 'empty lookup expression',
		};
	}

	if (parts.length === 1) {
		if (CTX_GLOBALS.has(first)) return null;
		return {
			rawExpr: ref.rawExpr,
			fieldPath: ref.fieldPath,
			kind: 'unresolvable',
			detail: `"${first}" is not a known context global`,
			suggestion: closestMatch(first, CTX_GLOBALS),
		};
	}

	if (first === 'inputs' && parts.length >= 2) {
		const name = parts[1];
		if (symbols.inputs.has(name)) return null;
		return {
			rawExpr: ref.rawExpr,
			fieldPath: ref.fieldPath,
			kind: 'unknown_input',
			detail: `recipe input "${name}" is not declared in inputs:`,
			suggestion: closestMatch(name, symbols.inputs),
		};
	}

	if (first === 'steps' && parts.length >= 4 && parts[2] === 'outputs') {
		const stepId = parts[1];
		const outputName = parts[3];

		const targetIdx = symbols.stepIndex.get(stepId);
		if (targetIdx === undefined) {
			return {
				rawExpr: ref.rawExpr,
				fieldPath: ref.fieldPath,
				kind: 'unknown_step',
				detail: `step "${stepId}" does not exist in the recipe`,
				suggestion: closestMatch(stepId, symbols.stepIndex.keys()),
			};
		}
		if (currentStepIdx !== null && targetIdx >= currentStepIdx) {
			return {
				rawExpr: ref.rawExpr,
				fieldPath: ref.fieldPath,
				kind: 'forward_ref',
				detail: `step "${stepId}" runs at or after the current step (add it to depends_on or reorder)`,
			};
		}
		const declaredOutputs = symbols.stepOutputs.get(stepId) ?? new Set<string>();
		if (declaredOutputs.has(outputName)) return null;
		return {
			rawExpr: ref.rawExpr,
			fieldPath: ref.fieldPath,
			kind: 'unknown_output',
			detail: `step "${stepId}" does not declare output "${outputName}"`,
			suggestion: closestMatch(outputName, declaredOutputs),
		};
	}

	return {
		rawExpr: ref.rawExpr,
		fieldPath: ref.fieldPath,
		kind: 'unresolvable',
		detail: 'expected inputs.<name>, steps.<id>.outputs.<name>, or a context global',
	};
}

function checkFilters(ref: TemplateRef): TemplatingIssue[] {
	const issues: TemplatingIssue[] = [];
	for (const f of ref.filters) {
		const colonIdx = f.indexOf(':');
		const name = (colonIdx >= 0 ? f.slice(0, colonIdx) : f).trim();
		if (!KNOWN_FILTERS.has(name)) {
			issues.push({
				rawExpr: ref.rawExpr,
				fieldPath: ref.fieldPath,
				kind: 'unknown_filter',
				detail: `unknown filter "${name}"`,
				suggestion: closestMatch(name, KNOWN_FILTERS),
			});
		}
	}
	return issues;
}

/** Topological sort lifted from runner.ts. Validator trusts the schema's
 *  superRefine + the components/agents_exist checks to have caught cycles
 *  and unknown deps, so this version is permissive. */
function topoSort(steps: RecipeStep[]): RecipeStep[] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const order: RecipeStep[] = [];

	function visit(id: string) {
		if (visited.has(id)) return;
		if (visiting.has(id)) return;
		visiting.add(id);
		const step = byId.get(id);
		if (!step) return;
		for (const dep of step.depends_on ?? []) visit(dep);
		visiting.delete(id);
		visited.add(id);
		order.push(step);
	}

	for (const s of steps) visit(s.id);
	return order;
}

function declaredComponentOutputs(
	componentRef: string,
	catalog: Map<string, ComponentRecord>,
): Set<string> {
	const pinned = catalog.get(componentRef);
	if (pinned) return new Set(pinned.manifest.outputs?.map((o) => o.name) ?? []);
	const ref = parseComponentRef(componentRef);
	const byName = catalog.get(ref.name);
	if (byName) return new Set(byName.manifest.outputs?.map((o) => o.name) ?? []);
	return new Set();
}

/** Walk a recipe + return every templating issue. Empty array → recipe passes
 *  the `templating_resolves` gate. */
export function validateTemplating(
	recipe: Recipe,
	catalog: Map<string, ComponentRecord>,
): TemplatingIssue[] {
	const issues: TemplatingIssue[] = [];
	const symbols: SymbolTable = {
		inputs: new Set(),
		stepOutputs: new Map(),
		stepIndex: new Map(),
	};

	// Phase 1: recipe-level input defaults + file `path:` templates.
	// Each input resolves in declaration order, so refs may only target
	// globals + already-declared inputs (no step outputs — those haven't run).
	for (const inputDef of recipe.inputs ?? []) {
		const refs: TemplateRef[] = [];
		if (isFileInput(inputDef)) {
			refs.push(...findTemplateRefs(inputDef.path, ['inputs', inputDef.name, 'path']));
		}
		if ('default' in inputDef) {
			refs.push(...findTemplateRefs(inputDef.default, ['inputs', inputDef.name, 'default']));
		}
		for (const ref of refs) {
			const issue = resolveRef(ref, symbols, null);
			if (issue) {
				// Recipe-level defaults can never reference step outputs even with
				// depends_on. Rewrite forward_ref → unresolvable for clarity.
				if (issue.kind === 'forward_ref') {
					issues.push({
						...issue,
						kind: 'unresolvable',
						detail: 'recipe input defaults may not reference step outputs',
					});
				} else {
					issues.push(issue);
				}
			}
			issues.push(...checkFilters(ref));
		}
		symbols.inputs.add(inputDef.name);
	}

	// Phase 2: each step in topological order. Refs may target globals,
	// recipe inputs, and any earlier step's declared outputs.
	const order = topoSort(recipe.steps);
	order.forEach((step, idx) => symbols.stepIndex.set(step.id, idx));

	order.forEach((step, idx) => {
		const refs: TemplateRef[] = [];
		if (isComponentStep(step)) {
			refs.push(...findTemplateRefs(step.inputs ?? {}, ['steps', step.id, 'inputs']));
		}
		for (const ref of refs) {
			const issue = resolveRef(ref, symbols, idx);
			if (issue) issues.push(issue);
			issues.push(...checkFilters(ref));
		}
		if (isComponentStep(step)) {
			symbols.stepOutputs.set(step.id, declaredComponentOutputs(step.component, catalog));
		}
	});

	return issues;
}
