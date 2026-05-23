// ADR-003 Phase 3a — Naseej surface: recipe + component + audit verbs.
// All thin wrappers over /api/recipes*, /api/components*, /api/naseej/audit.

import { apiGet, apiPost } from '../api.ts';
import { emit, fail, type OutputOpts } from '../output.ts';

/** ─────────────────────────── recipes ─────────────────────────── */

interface RecipeListItem {
  name: string;
  version?: string;
  project?: string;
  description?: string;
  step_count?: number;
  recipe_path?: string;
  [k: string]: unknown;
}
/** API returns `results`, not `recipes`. ADR-003 v1 misnamed it. */
interface RecipesListResp { results: RecipeListItem[]; total?: number; facets?: unknown }

export async function recipeList(args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<RecipesListResp>('/api/recipes', {
    project: args.project,
    q: args.q,
  });
  emit(data, opts, (d: RecipesListResp) => {
    const items = d.results ?? [];
    if (items.length === 0) return '(no recipes)';
    return items
      .map((r) => `${r.name.padEnd(30)} ${(r.version ?? '—').padEnd(10)} project=${(r.project ?? '—').padEnd(20)} ${r.description ?? ''}`)
      .join('\n');
  });
}

/** No singleton endpoint exists; filter the list endpoint with q=<slug>
 *  and pick the exact-name match. Documented drift from ADR-003. */
export async function recipeGet(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('recipe get: missing SLUG (e.g. soul recipe get peer-brief)');
  const data = await apiGet<RecipesListResp>('/api/recipes', { q: slug });
  const items = data.results ?? [];
  const hit = items.find((r) => r.name === slug);
  if (!hit) fail(`recipe get: no recipe named "${slug}" (q=${slug} returned ${items.length} matches)`, 2);
  emit(hit, opts, (r: RecipeListItem) => {
    const lines = [
      `Recipe:  ${r.name}@${r.version ?? '?'}`,
      r.project ? `Project: ${r.project}` : '',
      r.recipe_path ? `Path:    ${r.recipe_path}` : '',
      r.step_count !== undefined ? `Steps:   ${r.step_count}` : '',
      r.description ? `\n${r.description}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  });
}

interface RecipeRunResp {
  run_id: string;
  recipe: string;
  status: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  failed_step?: string;
  [k: string]: unknown;
}

/** POST /api/recipes/run.
 *  --input k=v can be repeated; built into a {k:v,...} inputs object.
 *  --inputs-json takes a literal JSON object (wins over --input on overlap).
 *  --mode production|test|oneshot. --run-id for cancellable runs. */
export async function recipeRun(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('recipe run: missing SLUG (e.g. soul recipe run peer-brief --mode test)');

  const inputs: Record<string, unknown> = {};
  // node:util.parseArgs doesn't multi-collect a single flag; we accept JSON
  // for non-scalar inputs and `--input k=v` for one quick pair.
  if (args.input) {
    const eq = args.input.indexOf('=');
    if (eq < 0) fail('recipe run: --input must be of the form key=value');
    inputs[args.input.slice(0, eq)] = args.input.slice(eq + 1);
  }
  if (args['inputs-json']) {
    try {
      const merged = JSON.parse(args['inputs-json']);
      if (typeof merged !== 'object' || merged === null) {
        fail('recipe run: --inputs-json must be a JSON object');
      }
      Object.assign(inputs, merged);
    } catch (err) {
      fail(`recipe run: --inputs-json invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const body: Record<string, unknown> = { recipe: slug };
  if (Object.keys(inputs).length > 0) body.inputs = inputs;
  if (args.mode) {
    if (!['production', 'test', 'oneshot'].includes(args.mode)) {
      fail(`recipe run: --mode must be one of production|test|oneshot (got "${args.mode}")`);
    }
    body.mode = args.mode;
  }
  if (args['run-id']) body.run_id = args['run-id'];

  if (args['dry-run']) {
    emit({ dryRun: true, method: 'POST', path: '/api/recipes/run', body }, opts, (d: any) =>
      `DRY RUN — POST /api/recipes/run\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
    );
    return;
  }

  const data = await apiPost<RecipeRunResp>('/api/recipes/run', body);
  emit(data, opts, (d: RecipeRunResp) => {
    const lines = [
      `Run:      ${d.run_id}`,
      `Recipe:   ${d.recipe}`,
      `Status:   ${d.status}`,
      d.duration_ms !== undefined ? `Duration: ${d.duration_ms}ms` : '',
      d.failed_step ? `Failed:   ${d.failed_step}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  });
  // Recipe runs return 422 on step-failure; ApiError already threw on that
  // path. If somehow we got a non-success body, exit non-zero.
  if (data && data.status && data.status !== 'success') process.exit(1);
}

interface CancelResp { ok: boolean; run_id: string; active?: string[]; error?: string }

export async function recipeCancel(args: Record<string, string | undefined>, opts: OutputOpts) {
  const runId = args._;
  if (!runId) fail('recipe cancel: missing RUN_ID (e.g. soul recipe cancel my-run-uuid)');
  const data = await apiPost<CancelResp>(`/api/recipes/runs/${runId}/cancel`, {});
  emit(data, opts, (d: CancelResp) =>
    d.ok
      ? `✓ cancel signal fired for ${d.run_id}`
      : `✗ ${d.error ?? `no active run "${runId}"`}` +
        (d.active && d.active.length > 0 ? `\nActive: ${d.active.join(', ')}` : ''),
  );
  if (!data.ok) process.exit(1);
}

/** ─────────────────────────── components ─────────────────────────── */

interface ComponentListItem {
  name: string;
  version?: string;
  id?: string;
  type?: string;
  category?: string;
  runtime?: string;
  tier?: number;
  description?: string;
  author?: string;
  project?: string;
  manifest_path?: string;
  [k: string]: unknown;
}
/** API returns `results`, not `components`. */
interface ComponentsListResp { results: ComponentListItem[]; total?: number; facets?: unknown }

export async function componentList(args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<ComponentsListResp>('/api/components', {
    category: args.category,
    runtime: args.runtime,
    q: args.q,
  });
  emit(data, opts, (d: ComponentsListResp) => {
    const items = d.results ?? [];
    if (items.length === 0) return '(no components)';
    return items
      .map((c) => {
        const tier = c.tier ? `T${c.tier}` : '  ';
        return `${c.name.padEnd(30)} ${(c.version ?? '—').padEnd(10)} ${tier}  ${c.description ?? ''}`;
      })
      .join('\n');
  });
}

export async function componentGet(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('component get: missing SLUG (e.g. soul component get vault-write)');
  const data = await apiGet<ComponentsListResp>('/api/components', { q: slug });
  const items = data.results ?? [];
  const hit = items.find((c) => c.name === slug);
  if (!hit) fail(`component get: no component named "${slug}" (q=${slug} returned ${items.length} matches)`, 2);
  emit(hit, opts, (c: ComponentListItem) => {
    const lines = [
      `Component: ${c.name}@${c.version ?? '?'}`,
      c.tier ? `Tier:      ${c.tier}` : '',
      c.category ? `Category:  ${c.category}` : '',
      c.runtime ? `Runtime:   ${c.runtime}` : '',
      c.author ? `Author:    ${c.author}` : '',
      c.manifest_path ? `Manifest:  ${c.manifest_path}` : '',
      c.description ? `\n${c.description}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  });
}

/** ─────────────────────────── naseej audit ─────────────────────────── */

/** Engine returns camelCase columns from the SQLite audit table.
 *  Timestamps are epoch ms; we render YYYY-MM-DD via toISOString. */
interface AuditRun {
  id: number;
  runId: string;
  recipe: string;
  recipeVersion?: string;
  project?: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  mode?: string;
  failedStep?: string | null;
  costUsd?: number | null;
}
interface AuditPublish {
  id: number;
  name: string;
  kind: string;
  status: string;
  ts: number;
}
/** API returns `results` for both runs and publishes. */
interface AuditResp { type: string; results: Array<AuditRun | AuditPublish>; total: number }

export async function naseejAudit(args: Record<string, string | undefined>, opts: OutputOpts) {
  const type = args.type ?? 'runs';
  if (!['runs', 'publishes'].includes(type)) {
    fail(`naseej audit: --type must be runs|publishes (got "${type}")`);
  }
  const data = await apiGet<AuditResp>('/api/naseej/audit', {
    type,
    limit: args.limit ?? '50',
    recipe: args.recipe,
    status: args.status,
    component: args.component,
    project: args.project,
  });
  emit(data, opts, (d: AuditResp) => {
    const items = d.results ?? [];
    if (items.length === 0) return `(no ${type})`;
    if (type === 'runs') {
      return (items as AuditRun[])
        .map((r) => {
          const when = r.startedAt ? new Date(r.startedAt).toISOString().slice(0, 19).replace('T', ' ') : '—';
          const dur = r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
          return `${when}  ${r.status.padEnd(10)} ${dur.padStart(7)}  ${r.recipe.padEnd(28)} ${r.runId}`;
        })
        .join('\n');
    }
    return (items as AuditPublish[])
      .map((p) => {
        const when = p.ts ? new Date(p.ts).toISOString().slice(0, 19).replace('T', ' ') : '—';
        return `${when}  ${p.status.padEnd(8)} ${p.kind.padEnd(10)} ${p.name}`;
      })
      .join('\n');
  });
}
