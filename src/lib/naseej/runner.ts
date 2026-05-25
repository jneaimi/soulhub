/**
 * Naseej recipe runner (v1).
 *
 * Loads a recipe.yaml, validates referenced components exist in
 * catalog/components/<name>/BLOCK.md, topo-sorts steps by depends_on,
 * interpolates `{{inputs.X}}` and `{{steps.X.outputs.Y}}` placeholders,
 * spawns each component as a subprocess with stdin JSON, captures
 * stdout JSON, propagates exit codes.
 *
 * Step types supported in v1: `component` only. Recipes that need
 * `script` (legacy block format), `agent` (orchestrator-v2 dispatch),
 * or `approval` (durable gates) are out of scope until those primitives
 * ship — see ADR-001 P2.5 + the deferred P0.
 *
 * Runtime detection from BLOCK.md:
 *   runtime: python  → `uv run <path>/run.py`
 *   runtime: node    → `node <path>/run.mjs`
 *
 * Frontmatter parsing + catalog scanning live in `./manifest.ts` so the
 * publish API gates (POST /api/components, POST /api/recipes) share the
 * exact same Zod schema as the runner. Recipe shape validation comes from
 * `./schemas/recipe.ts`.
 */
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { buildCatalogIndex, type ComponentRecord } from './manifest.js';
import {
	isComponentStep,
	isFileInput,
	parseRecipe,
	type ComponentStep,
	type Recipe,
	type RecipeStep,
} from './schemas/recipe.js';
import {
	recordRunStart,
	recordRunEnd,
	updateRunStatus,
	type RunSource,
} from './audit.js';
import { publish as publishEvent } from './events.js';
import { registerPause } from './pause-registry.js';
import type { DispatchResult, DispatchEvent } from '../agents/dispatch/types.js';

const RECIPES_DIR = resolvePath(process.cwd(), 'catalog/recipes');

export type { Recipe, RecipeStep };

export interface StepResult {
	id: string;
	/** Discriminates which branch produced this result; mirrors the recipe step shape. */
	kind: 'component' | 'agent';
	/** Set on component-step results. */
	component?: string;
	/** Set on agent-step results. */
	agent?: string;
	exit_code: number;
	duration_ms: number;
	outputs?: Record<string, unknown>;
	error?: string;
	// ADR-005 — agent-step-only fields. Optional so existing component-step
	// consumers don't break; populated on the agent branch.
	agent_status?: DispatchResult['status'];
	num_turns?: number;
	cost_usd?: number;
	output_excerpt?: string;
	artifact_path?: string;
	events?: DispatchEvent[];
}

export interface RunResult {
	run_id: string;
	recipe: string;
	status: 'success' | 'failed';
	started_at: string;
	finished_at: string;
	duration_ms: number;
	steps: StepResult[];
	failed_step?: string;
}

export async function loadRecipe(recipePath: string): Promise<Recipe> {
	const raw = await readFile(recipePath, 'utf-8');
	const parsed = parseYaml(raw);
	return parseRecipe(parsed);
}

/** Topological sort. Throws on cycles or unknown deps. */
function topoSort(steps: RecipeStep[]): RecipeStep[] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const visited = new Set<string>();
	const stack = new Set<string>();
	const order: RecipeStep[] = [];

	function visit(id: string) {
		if (visited.has(id)) return;
		if (stack.has(id)) throw new Error(`cycle detected involving step "${id}"`);
		stack.add(id);
		const step = byId.get(id);
		if (!step) throw new Error(`unknown step id: ${id}`);
		for (const dep of step.depends_on ?? []) {
			if (!byId.has(dep)) throw new Error(`step "${id}" depends on unknown step "${dep}"`);
			visit(dep);
		}
		stack.delete(id);
		visited.add(id);
		order.push(step);
	}

	for (const s of steps) visit(s.id);
	return order;
}

/** ADR-013 — group steps into parallel waves by dependency depth.
 *
 *  Back-compat rule: a step with `depends_on === undefined` inherits the
 *  PREVIOUS step in declaration order as its implicit dependency. This keeps
 *  every existing recipe (which assumes sequential execution) running
 *  sequentially. Recipes opt INTO parallelism by declaring `depends_on: []`
 *  explicitly (= no deps, runs in wave 0) or by depending only on a sibling
 *  that's not the immediate predecessor.
 *
 *  Returns waves[]; each wave is an array of steps that can run concurrently.
 *  Steps within a wave have no dependency relationship to each other; all
 *  their deps are in earlier waves. */
function toWaves(steps: RecipeStep[]): RecipeStep[][] {
	// Materialise the dependency graph with implicit-chain back-compat.
	const deps = new Map<string, string[]>();
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (step.depends_on !== undefined) {
			deps.set(step.id, step.depends_on);
		} else {
			deps.set(step.id, i === 0 ? [] : [steps[i - 1].id]);
		}
	}

	const byId = new Map(steps.map((s) => [s.id, s]));
	const remaining = new Set(steps.map((s) => s.id));
	const completed = new Set<string>();
	const waves: RecipeStep[][] = [];

	while (remaining.size > 0) {
		const ready: RecipeStep[] = [];
		for (const id of remaining) {
			const stepDeps = deps.get(id)!;
			if (stepDeps.every((d) => completed.has(d))) {
				ready.push(byId.get(id)!);
			}
		}
		if (ready.length === 0) {
			throw new Error(
				`runner deadlock: no ready steps from remaining {${[...remaining].join(', ')}} — likely a cycle or unknown dep`,
			);
		}
		// Preserve declaration order within a wave for deterministic step ordering.
		ready.sort((a, b) => steps.indexOf(a) - steps.indexOf(b));
		waves.push(ready);
		for (const s of ready) {
			remaining.delete(s.id);
			completed.add(s.id);
		}
	}
	return waves;
}

const DEFAULT_MAX_PARALLELISM = 4;

function lookup(expr: string, ctx: Record<string, unknown>): unknown {
	const parts = expr.split('.');
	let cur: unknown = ctx;
	for (const p of parts) {
		if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
			cur = (cur as Record<string, unknown>)[p];
		} else {
			return undefined;
		}
	}
	return cur;
}

/** ADR-006 D3 — exhaustive filter set. Unknown filter throws; no extensibility
 *  surface today. Filters compose left-to-right via the pipe operator. */
const FILTERS: Record<string, (val: unknown, arg?: string) => unknown> = {
	basename: (v) => basename(String(v ?? '')),
	dirname: (v) => dirname(String(v ?? '')),
	human_bytes: (v) => {
		const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
		if (!Number.isFinite(n)) return String(v ?? '');
		if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
		if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}M`;
		if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
		return `${n}B`;
	},
	date_fmt: (v, arg) => {
		const s = String(v ?? '');
		if (!arg) return s;
		const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
		if (!m) return s;
		const [, year, month, day] = m;
		return arg
			.replace(/YYYY/g, year)
			.replace(/MM/g, month)
			.replace(/DD/g, day);
	},
};

/** Apply a single filter expression like `"basename"` or `"date_fmt:DD/MM/YYYY"`.
 *  Throws on unknown filter — typos shouldn't silently no-op. */
function applyFilter(value: unknown, filterExpr: string): unknown {
	const colonIdx = filterExpr.indexOf(':');
	const name = (colonIdx >= 0 ? filterExpr.slice(0, colonIdx) : filterExpr).trim();
	const arg = colonIdx >= 0 ? filterExpr.slice(colonIdx + 1).trim() : undefined;
	const fn = FILTERS[name];
	if (!fn) {
		throw new Error(
			`unknown templating filter: "${name}". Known filters: ${Object.keys(FILTERS).join(', ')}`,
		);
	}
	return fn(value, arg);
}

/** Evaluate a `{{ expr | filter1 | filter2:arg }}` placeholder body against ctx. */
function evaluateExpr(raw: string, ctx: Record<string, unknown>): unknown {
	const parts = raw.split('|').map((p) => p.trim()).filter((p) => p.length > 0);
	if (parts.length === 0) return undefined;
	let cur: unknown = lookup(parts[0], ctx);
	for (let i = 1; i < parts.length; i++) cur = applyFilter(cur, parts[i]);
	return cur;
}

/** Walk an object/array/string and replace `{{path.to.thing | filter}}` placeholders.
 *  When a string IS a single placeholder (e.g. `"{{inputs.min_score}}"`), the
 *  underlying value's native type is preserved (int stays int, bool stays bool).
 *  Mixed strings (`"hello {{name}}"`) are always concatenated as strings.
 *
 *  ADR-006 D3 — filter pipe syntax: `{{ x | basename }}` and
 *  `{{ x | date_fmt:DD/MM/YYYY }}` are supported. Unknown filters throw. */
function interpolate(value: unknown, ctx: Record<string, unknown>): unknown {
	if (typeof value === 'string') {
		const wholeMatch = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
		if (wholeMatch) {
			const v = evaluateExpr(wholeMatch[1], ctx);
			// Fail loud on an unresolved whole-string reference. `"{{x}}"` means
			// "this value IS x"; if x resolves to undefined (a missing input or a
			// dropped upstream step output) silently substituting "" sends an
			// empty string downstream — e.g. an empty recipe path to the
			// peer-brief scanner, which then reads cwd and crashes with a cryptic
			// IsADirectoryError (2026-05-25 debug). Throwing here mirrors the
			// existing unknown-filter hard-fail in applyFilter; the runner surfaces
			// it as a clean step failure naming the unresolved reference. A
			// present-but-empty value (literal "") is distinct from undefined and
			// passes through unchanged.
			if (v === undefined) {
				throw new Error(
					`unresolved template reference: "{{ ${wholeMatch[1].trim()} }}" resolved to undefined ` +
					'(missing input or upstream step output not emitted)',
				);
			}
			return v;
		}
		return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_full, expr) => {
			const v = evaluateExpr(String(expr), ctx);
			if (v === null || v === undefined) return '';
			return typeof v === 'object' ? JSON.stringify(v) : String(v);
		});
	}
	if (Array.isArray(value)) return value.map((v) => interpolate(v, ctx));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, ctx);
		return out;
	}
	return value;
}

/** Spawn a component. Pipes JSON stdin → reads JSON stdout. */
function runComponent(
	record: ComponentRecord,
	stepInputs: Record<string, unknown>,
): Promise<{ exit_code: number; stdout: string; stderr: string; duration_ms: number }> {
	const command = record.manifest.runtime === 'python' ? 'uv' : 'node';
	const args = record.manifest.runtime === 'python' ? ['run', record.entry] : [record.entry];
	return new Promise((resolveP) => {
		const startedAt = Date.now();
		const proc = spawn(command, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: record.dir,
		});
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d) => { stdout += d; });
		proc.stderr.on('data', (d) => { stderr += d; });
		proc.on('close', (code) => {
			resolveP({
				exit_code: code ?? -1,
				stdout,
				stderr,
				duration_ms: Date.now() - startedAt,
			});
		});
		proc.stdin.end(JSON.stringify(stepInputs));
	});
}

function parseOutputs(stdout: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(stdout);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Resolve recipe inputs against operator-supplied values + defaults.
 *
 *  ADR-006 D1 — typed inputs. `file` inputs interpolate their `path:` template
 *  against the partial ctx (`ctxBase` + inputs resolved so far) and optionally
 *  fail fast if `must_exist: true` and the file is missing. Non-file inputs use
 *  the existing operator-or-default-or-required pipeline.
 *
 *  Declaration order matters — a `file` input's `path:` may reference earlier
 *  inputs (e.g. `{{inputs.date}}`). */
function resolveInputs(
	recipe: Recipe,
	operator: Record<string, unknown> | undefined,
	ctxBase: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const def of recipe.inputs ?? []) {
		const partialCtx = { ...ctxBase, inputs: out };
		if (isFileInput(def)) {
			const resolvedPath = String(interpolate(def.path, partialCtx));
			if (def.must_exist && !existsSync(resolvedPath)) {
				throw new Error(
					`input "${def.name}" file does not exist: ${resolvedPath}`,
				);
			}
			out[def.name] = resolvedPath;
		} else if (operator && def.name in operator) {
			out[def.name] = operator[def.name];
		} else if ('default' in def) {
			// ADR-006 S2 — defaults may contain templates (e.g. `"{{HOME}}/Downloads/..."`).
			// Interpolated against ctxBase + inputs resolved so far. v1 recipes used
			// literal defaults; that path still works (interpolate is a no-op on
			// strings without `{{ }}` markers).
			out[def.name] = interpolate(def.default, partialCtx);
		} else if (def.required) {
			throw new Error(`required input missing: ${def.name}`);
		}
	}
	// Pass-through unknown operator inputs (forward-compat)
	if (operator) {
		for (const [k, v] of Object.entries(operator)) {
			if (!(k in out)) out[k] = v;
		}
	}
	return out;
}

/** Component-step branch. Extracted so the main runRecipe loop reads as a
 *  thin per-step dispatcher to {component, agent} sub-runners. */
async function runComponentStep(
	step: ComponentStep,
	catalog: Map<string, ComponentRecord>,
	ctx: Record<string, unknown>,
): Promise<StepResult> {
	const manifest = catalog.get(step.component);
	if (!manifest) {
		return {
			id: step.id,
			kind: 'component',
			component: step.component,
			exit_code: -1,
			duration_ms: 0,
			error: `component not found in catalog: ${step.component}`,
		};
	}

	const resolvedInputs = interpolate(step.inputs ?? {}, ctx) as Record<string, unknown>;
	const proc = await runComponent(manifest, resolvedInputs);
	const outputs = parseOutputs(proc.stdout);

	const result: StepResult = {
		id: step.id,
		kind: 'component',
		component: step.component,
		exit_code: proc.exit_code,
		duration_ms: proc.duration_ms,
		outputs,
	};
	if (proc.exit_code !== 0) {
		// Tier-1 components like shell-exec emit their failure detail in
		// `outputs.stderr` (the subprocess stderr), not `outputs.error` —
		// fall through to that before defaulting to the component's own
		// stderr or a synthetic message. Without this, shell-exec failures
		// surfaced as empty-string errors at the recipe layer (seen in the
		// ADR-007 S3 peer-brief test 3 triage on 2026-05-17).
		const detail = outputs?.error
			? String(outputs.error)
			: outputs?.stderr
			? String(outputs.stderr)
			: proc.stderr.trim() || `component exited with code ${proc.exit_code}`;
		result.error = detail.trim().slice(0, 500);
	}
	return result;
}

/** ADR-023 CP4 — pause-intercept wrapper for `shape: gate` components.
 *  Calls runComponentStep once. If the result indicates a pause-request
 *  (exit_code === 2 AND manifest declares `shape: gate` AND parsed outputs
 *  carry `{pause: true, kind, ...}`), enters the runner-managed pause flow:
 *  emit the human_required / gate_required SSE event, registerPause() with
 *  the resolver, and on resume RE-INVOKE the component with the operator's
 *  response injected as a `resume_response` step input. Second invocation
 *  exits 0 with the final outputs.
 *
 *  Non-gate components, or gate components that don't actually pause (e.g.
 *  exit 2 from a different error condition), flow through unchanged. The
 *  `shape: gate` guard is essential — without it, shell-exec components
 *  that legitimately exit 2 on bad input would be misidentified. */
async function runComponentStepWithGateIntercept(
	step: ComponentStep,
	catalog: Map<string, ComponentRecord>,
	ctx: Record<string, unknown>,
	runId: string,
	signal: AbortSignal,
): Promise<StepResult> {
	const firstResult = await runComponentStep(step, catalog, ctx);

	if (firstResult.exit_code !== 2) return firstResult;
	const record = catalog.get(step.component);
	if (record?.manifest.shape !== 'gate') return firstResult;
	const pause = firstResult.outputs;
	if (!pause || pause.pause !== true) return firstResult;

	const kind: 'human' | 'gate' = pause.kind === 'gate' ? 'gate' : 'human';
	const timeoutSec = typeof pause.timeout_sec === 'number' ? pause.timeout_sec : 3600;
	const prompt = typeof pause.prompt === 'string' ? pause.prompt : '';

	if (kind === 'human') {
		publishEvent({
			type: 'human_required',
			runId,
			stepId: step.id,
			prompt,
			...(Array.isArray(pause.fields)
				? {
						fields: pause.fields as Array<{
							name: string;
							type: string;
							label?: string;
							required?: boolean;
							options?: string[];
						}>,
					}
				: {}),
			timeoutSec,
			ts: Date.now(),
		});
	} else {
		publishEvent({
			type: 'gate_required',
			runId,
			stepId: step.id,
			prompt,
			allowComment: pause.allow_comment !== false,
			timeoutSec,
			ts: Date.now(),
		});
	}

	updateRunStatus(runId, 'paused');
	let pauseResponse;
	try {
		pauseResponse = await registerPause(runId, step.id, kind, timeoutSec, signal);
	} catch (err) {
		updateRunStatus(runId, 'running');
		return {
			id: step.id,
			kind: 'component',
			component: step.component,
			exit_code: 1,
			duration_ms: 0,
			error: (err as Error).message,
		};
	}
	updateRunStatus(runId, 'running');

	// Re-invoke with operator's response injected as a step input. The
	// component's second invocation sees `resume_response` present, skips the
	// pause emission, and exits 0 with the final outputs.
	//
	// Unwrap one layer for human responses: the /respond endpoint wraps the
	// operator's payload in `HumanResponse = { response: <payload> }` before
	// storing in the pause registry. We pass the raw payload to the component
	// so the human-form's stdout shape `{response: resume_response}` matches
	// the legacy runHumanStep output (single-wrap, not double). Gate responses
	// are already in their final shape (`{decision, comment?}`) — pass through.
	const responseForComponent =
		kind === 'human'
			? (pauseResponse.response as { response: unknown }).response
			: pauseResponse.response;
	const resumedStep: ComponentStep = {
		...step,
		inputs: {
			...(step.inputs ?? {}),
			resume_response: responseForComponent,
		},
	};
	return await runComponentStep(resumedStep, catalog, ctx);
}


export interface RunRecipeOptions {
	signal?: AbortSignal;
	/** @deprecated — vestigial post-ADR-023. The runner no longer dispatches
	 *  agent steps directly; the `agent-dispatch@1.0.0` component owns this
	 *  concern via `inputs.mode`. Accepted-but-ignored to keep the existing
	 *  POST /api/recipes/run contract backward-compatible for one release. */
	mode?: 'production' | 'test' | 'oneshot';
	/** ADR-005 CP3 — opt-in caller-supplied runId. When provided, replaces
	 *  the auto-generated short-id. Lets the caller register a cancel hook
	 *  via POST /api/recipes/runs/<id>/cancel before the run completes.
	 *  When omitted, an 8-char UUID slice is generated and only known
	 *  after the run finishes (legacy CP1+CP2 behaviour). */
	runId?: string;
	/** ADR-021 — invocation source for the audit-trail row. The runner
	 *  itself cannot tell who called it; each caller passes its own value.
	 *  Defaults to 'api' (POST /api/recipes/run); scheduler handler and
	 *  CLI wrapper pass 'scheduler' / 'cli' / 'chat' respectively. */
	source?: RunSource;
}

/** ADR-005 CP3 — in-flight run registry. Each in-progress runRecipe call
 *  registers an AbortController here keyed on its runId; the cancel
 *  endpoint (POST /api/recipes/runs/[run_id]/cancel) calls cancelRun()
 *  to fire it. Entries are deleted in the runRecipe finally block.
 *
 *  Single in-process Map — there is no recipe runner outside the
 *  soul-hub process, and crashes drop the registry which is correct
 *  (a crashed run cannot be cancelled, only restarted). */
const runRegistry = new Map<string, AbortController>();

/** Fire the AbortController for an in-flight run. Returns true if the
 *  run existed in the registry (cancel signal sent); false if no such
 *  run is currently in-flight (already finished, never started, or
 *  the caller used the wrong runId). */
export function cancelRun(runId: string): boolean {
	const controller = runRegistry.get(runId);
	if (!controller) return false;
	controller.abort();
	return true;
}

/** Inspect the live registry. Used by the cancel endpoint to return
 *  meaningful 404 vs "active" diagnostics. Returns the runIds currently
 *  registered (snapshot, not live). */
export function listActiveRuns(): string[] {
	return [...runRegistry.keys()];
}

export async function runRecipe(
	recipePath: string,
	operatorInputs?: Record<string, unknown>,
	opts: RunRecipeOptions = {},
): Promise<RunResult> {
	const recipe = await loadRecipe(recipePath);
	const catalog = await buildCatalogIndex();
	const order = topoSort(recipe.steps);
	const waves = toWaves(recipe.steps);
	const maxParallelism = (recipe as { max_parallelism?: number }).max_parallelism ?? DEFAULT_MAX_PARALLELISM;
	const source: RunSource = opts.source ?? 'api';
	// Recorded on the audit row + recipe_start SSE event for backward compat.
	// Per the @deprecated note on opts.mode, the runner does NOT act on this;
	// agent-dispatch components handle dispatch backend via `inputs.mode`.
	const mode = opts.mode ?? 'production';

	// Pre-flight: every step is a component step post-ADR-023; verify each
	// references an existing catalog entry. Recipe-author errors throw here
	// rather than failing mid-run.
	for (const step of order) {
		if (isComponentStep(step) && !catalog.has(step.component)) {
			throw new Error(`step "${step.id}" references unknown component: ${step.component}`);
		}
	}

	const runId = opts.runId ?? randomUUID().slice(0, 8);
	const startedAt = new Date();
	// ADR-006 D2 — ctxBase carries context globals available DURING input
	// resolution (so a `file` input's `path:` template can reference `{{date}}`,
	// `{{HOME}}`, `{{work_dir}}`). work_dir is materialised below before any
	// step runs; cleanup is deferred to a separate retention job (out of scope).
	const workDir = join(homedir(), '.soul-hub', 'data', 'naseej', 'runs', runId);
	const ctxBase = {
		run_id: runId,
		date: startedAt.toISOString().slice(0, 10),
		// Full ISO timestamp at ms precision. Useful when a recipe wants
		// per-run content uniqueness (e.g. vault-write into a deterministic
		// path where content dedup would otherwise fire).
		now: startedAt.toISOString(),
		project: recipe.project ?? 'naseej',
		HOME: homedir(),
		work_dir: workDir,
	};
	const inputs = resolveInputs(recipe, operatorInputs, ctxBase);
	await mkdir(workDir, { recursive: true });
	const ctx: Record<string, unknown> = {
		...ctxBase,
		inputs,
		steps: {} as Record<string, { outputs: Record<string, unknown> }>,
	};

	// ADR-005 CP3 — register an AbortController for this run so the cancel
	// endpoint can fire it. If the caller already passed opts.signal, chain
	// it into the same controller so either side can trigger cancellation.
	const controller = new AbortController();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
	}
	runRegistry.set(runId, controller);

	// ADR-021 — audit row insert. Non-critical: a DB failure here logs but
	// never blocks the recipe run (recordRunStart wraps in try/catch).
	recordRunStart({
		runId,
		recipe: recipe.name,
		recipeVersion: recipe.version,
		project: recipe.project ?? 'naseej',
		mode,
		source,
		startedAt: startedAt.getTime(),
	});

	// ADR-018 — SSE recipe_start. Subscribers see the run shape immediately.
	publishEvent({
		type: 'recipe_start',
		runId,
		recipe: recipe.name,
		recipeVersion: recipe.version,
		project: recipe.project ?? 'naseej',
		mode,
		source,
		ts: startedAt.getTime(),
	});

	const stepsCtx = ctx.steps as Record<string, { outputs: Record<string, unknown> }>;
	const stepResults: StepResult[] = [];
	let failedStep: string | undefined;

	try {
		// ADR-013 — wave-based execution. Steps within a wave run concurrently
		// (bounded by max_parallelism), waves run sequentially. Step bodies are
		// identical to the legacy sequential loop; only the iteration shape
		// changed. Per-step `on_failure: continue` lets a wave-mate failure not
		// halt the recipe; default `halt` preserves legacy behaviour.
		const runSingleStep = async (step: RecipeStep): Promise<StepResult> => {
			const stepStartedAt = Date.now();
			// ADR-023 CP6 — every step is a component step. The legacy
			// 'agent'/'human'/'gate' stepKind values are gone; SSE consumers
			// discriminate by `componentSlug` instead.
			publishEvent({
				type: 'step_start',
				runId,
				stepId: step.id,
				stepKind: 'component',
				componentSlug: step.component,
				ts: stepStartedAt,
			});
			// `shape: gate` components (human-form, approval-gate, any future
			// gate) flow through the pause-intercept wrapper; non-gate components
			// are unaffected (the wrapper returns the first result unchanged).
			return await runComponentStepWithGateIntercept(
				step,
				catalog,
				ctx,
				runId,
				controller.signal,
			);
		};

		outer: for (const wave of waves) {
			// Bound concurrency: split wide waves into chunks of max_parallelism.
			for (let chunkStart = 0; chunkStart < wave.length; chunkStart += maxParallelism) {
				const chunk = wave.slice(chunkStart, chunkStart + maxParallelism);
				const settled = await Promise.allSettled(chunk.map(runSingleStep));

				// Process results in declaration order so downstream waves see
				// outputs in a stable shape. Order.indexOf is O(n) but the order
				// array is tiny in practice.
				for (let i = 0; i < settled.length; i++) {
					const settledResult = settled[i];
					const step = chunk[i];
					if (settledResult.status === 'rejected') {
						// Wrapper-level error (not the step's own exit code). Surface as
						// a synthetic failed-step result so the recipe response stays
						// consistent. The step's own try/catch should have caught most;
						// this branch is the safety net.
						const errMsg = settledResult.reason instanceof Error
							? settledResult.reason.message
							: String(settledResult.reason);
						const synthetic: StepResult = {
							id: step.id,
							kind: 'component',
							exit_code: 1,
							duration_ms: 0,
							error: `runner wrapper error: ${errMsg}`,
						};
						stepResults.push(synthetic);
						stepsCtx[step.id] = { outputs: {} };
						publishEvent({
							type: 'step_failed',
							runId,
							stepId: step.id,
							exitCode: 1,
							durationMs: 0,
							error: synthetic.error!,
							ts: Date.now(),
						});
						failedStep = step.id;
						break outer;
					}
					const stepResult = settledResult.value;
					stepResults.push(stepResult);
					stepsCtx[step.id] = { outputs: stepResult.outputs ?? {} };
					if (stepResult.exit_code !== 0) {
						publishEvent({
							type: 'step_failed',
							runId,
							stepId: step.id,
							exitCode: stepResult.exit_code,
							durationMs: stepResult.duration_ms,
							...(stepResult.error ? { error: stepResult.error } : {}),
							ts: Date.now(),
						});
						const onFailure = (step as { on_failure?: 'halt' | 'continue' }).on_failure ?? 'halt';
						if (onFailure === 'halt') {
							failedStep = step.id;
							break outer;
						}
						// on_failure: 'continue' — log + keep going (no failedStep set yet,
						// but a later step might set it; for now, the wave continues + the
						// next wave starts).
					} else {
						publishEvent({
							type: 'step_complete',
							runId,
							stepId: step.id,
							exitCode: stepResult.exit_code,
							durationMs: stepResult.duration_ms,
							ts: Date.now(),
						});
					}
				}
			}
		}
	} finally {
		runRegistry.delete(runId);
	}

	const finishedAt = new Date();
	// ADR-021 — cancel-vs-fail discrimination. The cancel endpoint aborts
	// the controller; the loop breaks on the next step's signal check and
	// the failing step's `error` carries an abort signature. Use the
	// controller's signal state as the canonical signal: if aborted, the
	// run was cancelled regardless of which step failed.
	const wasCancelled = controller.signal.aborted;
	const status: 'success' | 'failed' | 'cancelled' = wasCancelled
		? 'cancelled'
		: failedStep
			? 'failed'
			: 'success';
	const durationMs = finishedAt.getTime() - startedAt.getTime();
	const costUsd = stepResults.reduce((sum, s) => sum + (s.cost_usd ?? 0), 0);
	const failedStepResult = failedStep
		? stepResults.find((s) => s.id === failedStep)
		: undefined;

	// ADR-021 — audit row update. Project per-step state to a minimal shape
	// (id + kind + exit_code + duration_ms + error) so the column stays
	// query-friendly; the full step output stays in the runs/ filesystem
	// dir (this table is the index, not the storage).
	recordRunEnd({
		runId,
		status,
		finishedAt: finishedAt.getTime(),
		durationMs,
		stepsJson: JSON.stringify(
			stepResults.map((s) => ({
				id: s.id,
				kind: s.kind,
				exit_code: s.exit_code,
				duration_ms: s.duration_ms,
				...(s.error ? { error: s.error } : {}),
			})),
		),
		...(failedStepResult?.error ? { error: failedStepResult.error } : {}),
		...(failedStep ? { failedStep } : {}),
		...(costUsd > 0 ? { costUsd } : {}),
	});

	// ADR-018 — terminal event. SSE subscribers see this then the bus
	// closes the run ~10s later.
	if (status === 'cancelled') {
		publishEvent({
			type: 'recipe_cancelled',
			runId,
			durationMs,
			...(failedStep ? { failedStep } : {}),
			ts: finishedAt.getTime(),
		});
	} else if (status === 'failed') {
		publishEvent({
			type: 'recipe_failed',
			runId,
			durationMs,
			...(failedStep ? { failedStep } : {}),
			...(failedStepResult?.error ? { error: failedStepResult.error } : {}),
			ts: finishedAt.getTime(),
		});
	} else {
		publishEvent({
			type: 'recipe_complete',
			runId,
			durationMs,
			ts: finishedAt.getTime(),
		});
	}

	return {
		run_id: runId,
		recipe: recipe.name,
		status: status === 'cancelled' ? 'failed' : status,
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		duration_ms: durationMs,
		steps: stepResults,
		...(failedStep ? { failed_step: failedStep } : {}),
	};
}

/** Resolve a recipe name (e.g. "hello-naseej") to an absolute path. */
export function recipePathFromName(name: string): string {
	return join(RECIPES_DIR, name, 'recipe.yaml');
}

/** Resolve an arbitrary recipe path safely (must be under catalog/recipes/ or absolute). */
export function resolveRecipePath(input: string): string {
	if (input.includes('..')) throw new Error('recipe path may not contain ..');
	if (input.endsWith('.yaml') || input.endsWith('.yml')) {
		return resolvePath(process.cwd(), input);
	}
	return recipePathFromName(input);
}
