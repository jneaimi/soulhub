import { apiGet, apiPost, apiPut } from '../api.ts';
import { emit, fail, ageDays, todayIso, exitIfApiFailure, withCanonical, type OutputOpts } from '../output.ts';

/** Shared write-response shape used by next-actions / similar / propose-adr /
 *  ship-slice and label-falsifier. The API surfaces { success, error?, ... }. */
interface WriteResultLike { success?: boolean; error?: string; [k: string]: unknown }

/** projects-graph ADR-001 — canonical shape enum. Kept in lockstep with
 *  `PROJECT_SHAPES` in `src/lib/vault/types.ts` and the `## Allowed Project
 *  Shapes` section in `~/vault/projects/CLAUDE.md`. Used by `label-shape`. */
const PROJECT_SHAPES = [
  'coding-spine',
  'producer-pipeline',
  'publishing-outlet',
  'strategy-initiative',
  'time-boxed-bet',
  'maintained-system',
  'parent',
] as const;

interface ProjectRow {
  slug: string;
  parentProject?: string | null;
  adrCount: number;
  noteCount: number;
  statusCounts: Record<string, number>;
  openCount: number;
  lastActivity?: number | null;
  hasIndex: boolean;
  indexPath?: string;
  upcomingFalsifiers?: Array<{ slug: string; date: string }>;
}
interface ProjectsResp { projects: ProjectRow[]; total: number; }

export async function list(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<ProjectsResp>('/api/vault/projects');
  emit(withCanonical(data, 'projects'), opts, (d: ProjectsResp) => {
    if (d.projects.length === 0) return '(no projects)';
    const rows = d.projects
      .slice()
      .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
      .map((p) => {
        const parent = p.parentProject ? ` ← ${p.parentProject}` : '';
        return `${p.slug.padEnd(28)} adrs=${String(p.adrCount).padEnd(3)} open=${String(p.openCount).padEnd(3)} ${ageDays(p.lastActivity ?? null)}${parent}`;
      });
    return rows.join('\n');
  });
}

export async function get(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('project get: missing SLUG (e.g. soul project get soul-hub-cli)');
  const data = await apiGet<ProjectsResp>('/api/vault/projects', { slug });
  const row = data.projects.find((p) => p.slug === slug) ?? data.projects[0];
  if (!row) fail(`project get: no project named "${slug}"`, 2);
  emit(row, opts, (p: ProjectRow) => {
    const lines = [
      `Project: ${p.slug}`,
      p.parentProject ? `Parent:  ${p.parentProject}` : 'Parent:  (top-level)',
      `Index:   ${p.indexPath ?? '(missing)'}`,
      `ADRs:    ${p.adrCount} total | ${p.openCount} open`,
      `Last:    ${ageDays(p.lastActivity ?? null)}`,
      '',
      'Status counts:',
      ...Object.entries(p.statusCounts).map(([k, v]) => `  ${k.padEnd(12)} ${v}`),
    ];
    if (p.upcomingFalsifiers && p.upcomingFalsifiers.length > 0) {
      lines.push('', 'Upcoming falsifiers:');
      for (const f of p.upcomingFalsifiers) lines.push(`  ${f.date}  ${f.slug}`);
    }
    return lines.join('\n');
  });
}

/** projects-graph ADR-005 — project-level graph response shape returned
 *  by `/api/vault/projects/graph`. Mirrors `ProjectGraphData` in
 *  `src/lib/vault/types.ts`; kept local so this CLI has no runtime
 *  dependency on the Svelte app build output. */
interface GraphNodeLite {
  id: string;
  label: string;
  shape?: string;
  cluster?: string;
  parent?: string | null;
  size: number;
  aggregateStatus?: { open: number; shipped: number; total: number };
  hasOverdueFalsifier?: boolean;
}
interface GraphEdgeLite {
  source: string;
  target: string;
  type?: string;
}
interface ProjectGraphResp {
  nodes: GraphNodeLite[];
  edges: GraphEdgeLite[];
  clusters: Array<{ name: string; member_slugs: string[] }>;
}

function slugFromId(id: string): string {
  return id.replace(/^projects\//, '').replace(/\/index\.md$/i, '');
}

function emitDot(g: ProjectGraphResp): string {
  const lines: string[] = ['digraph projects {'];
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style=rounded];');
  // Cluster subgraphs — dot uses `cluster_` prefix to draw boxes.
  for (const c of g.clusters) {
    if (c.name === 'ungrouped' || c.member_slugs.length === 0) continue;
    lines.push(`  subgraph cluster_${c.name.replace(/[^a-z0-9]/gi, '_')} {`);
    lines.push(`    label="cluster:${c.name}";`);
    for (const slug of c.member_slugs) lines.push(`    "${slug}";`);
    lines.push('  }');
  }
  for (const e of g.edges) {
    const src = slugFromId(e.source);
    const tgt = slugFromId(e.target);
    const style = e.type === 'parent' ? ' [color="#94a3b8"]' : '';
    lines.push(`  "${src}" -> "${tgt}"${style};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function emitAdjacencyList(g: ProjectGraphResp): string {
  // Group edges by source slug, then format `<src> -> <tgt1>, <tgt2>`.
  const out = new Map<string, string[]>();
  for (const e of g.edges) {
    const src = slugFromId(e.source);
    const tgt = slugFromId(e.target);
    const list = out.get(src) ?? [];
    list.push(tgt);
    out.set(src, list);
  }
  const lines: string[] = [];
  // Walk in node order so unconnected projects still appear (with empty list).
  for (const n of g.nodes) {
    const slug = slugFromId(n.id);
    const children = out.get(slug) ?? [];
    const tail = children.length > 0 ? ' → ' + children.sort().join(', ') : '';
    const shape = n.shape ? ` [${n.shape}]` : '';
    const cluster = n.cluster ? ` (cluster:${n.cluster})` : '';
    lines.push(`${slug}${shape}${cluster}${tail}`);
  }
  return lines.join('\n');
}

export async function graph(args: Record<string, string | undefined>, opts: OutputOpts) {
  const format = (args.format ?? 'adjacency-list').toLowerCase();
  if (!['json', 'adjacency-list', 'dot'].includes(format)) {
    fail(`project graph: unknown --format "${format}". Allowed: json, adjacency-list, dot`);
  }

  const data = await apiGet<ProjectGraphResp>('/api/vault/projects/graph');

  // `--json` always wins (matches the global flag contract) and emits
  // the raw API JSON. `--format json` is the same thing for explicit
  // call-site readability.
  if (opts.json || format === 'json') {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }

  const rendered = format === 'dot' ? emitDot(data) : emitAdjacencyList(data);
  process.stdout.write(rendered + '\n');
}

interface WriteResp { success?: boolean; path?: string; error?: string }

/** projects-graph ADR-006 — outgoing + incoming producer→consumer edges
 *  for a single project. Reads `producesFor` from the producer rollup
 *  (passthrough of `produces_for[]` frontmatter) AND `consumesFrom` from
 *  the same endpoint's computed inverse (no second round-trip). */
export async function edges(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('project edges: missing SLUG (e.g. soul project edges signal-forge)');
  const format = (args.format ?? 'adjacency-list').toLowerCase();
  if (!['json', 'adjacency-list'].includes(format)) {
    fail(`project edges: unknown --format "${format}". Allowed: json, adjacency-list`);
  }

  type ProducerEdgeLite =
    | string
    | { target?: string; destination?: string; falsifier?: string; falsifier_date?: string };
  interface EdgesRow extends ProjectRow {
    producesFor?: ProducerEdgeLite[];
    consumesFrom?: string[];
  }
  interface EdgesResp { projects: EdgesRow[] }

  const data = await apiGet<EdgesResp>('/api/vault/projects', { slug });
  const row = data.projects.find((p) => p.slug === slug) ?? data.projects[0];
  if (!row) fail(`project edges: no project named "${slug}"`, 2);

  if (opts.json || format === 'json') {
    process.stdout.write(
      JSON.stringify(
        {
          slug: row.slug,
          producesFor: row.producesFor ?? [],
          consumesFrom: row.consumesFrom ?? [],
        },
      ) + '\n',
    );
    return;
  }

  const targetSlug = (raw: string): string => {
    const m = /^\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]$/.exec(raw.trim());
    if (!m) return raw;
    const segs = m[1].split('/').filter(Boolean);
    while (segs.length > 1 && /^index(\.md)?$/i.test(segs[segs.length - 1])) segs.pop();
    return (segs[segs.length - 1] ?? m[1]).replace(/\.md$/i, '');
  };

  const outgoing = row.producesFor ?? [];
  const incoming = row.consumesFrom ?? [];
  const lines: string[] = [];
  lines.push(`# ${row.slug}`);
  if (outgoing.length > 0) {
    lines.push(`\nOutgoing (produces_for):`);
    for (const e of outgoing) {
      if (typeof e === 'string') lines.push(`  → ${targetSlug(e)}`);
      else if (e && typeof e === 'object') {
        const tgt = typeof e.target === 'string' ? targetSlug(e.target) : '(no-target)';
        const meta: string[] = [];
        if (e.destination) meta.push(`dest=${e.destination}`);
        if (e.falsifier_date) meta.push(`falsifier=${e.falsifier_date}`);
        lines.push(`  → ${tgt}${meta.length > 0 ? ' [' + meta.join(', ') + ']' : ''}`);
      }
    }
  } else {
    lines.push(`\nOutgoing: (none)`);
  }
  if (incoming.length > 0) {
    lines.push(`\nIncoming (consumes_from — computed):`);
    for (const slug of incoming) lines.push(`  ← ${slug}`);
  } else {
    lines.push(`\nIncoming: (none)`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

/** projects-graph ADR-018 — read the Handoff Workbench (five readiness lanes).
 *  AI-facing surface for "what can I pick up / what's gated on whom". */
export async function worklist(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('project worklist: missing SLUG (e.g. soul project worklist ai-agriculture-platform)');

  type Item = { slug: string; title: string; type: string; status: string; owner: string; assignee: string | null; blockedByUnmet: string[] };
  interface WorklistResp { project: string; lanes: Record<string, Item[]>; counts: Record<string, number> }

  const data = await apiGet<WorklistResp>(`/api/vault/projects/${encodeURIComponent(slug)}/worklist`);

  if (opts.json) {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }

  const LANES: [string, string][] = [
    ['ready_for_ai', 'Ready for AI'],
    ['waiting_on_you', 'Waiting on you'],
    ['ready_for_you', 'Ready for you'],
    ['waiting_on_ai', 'Waiting on AI'],
    ['in_flight', 'In flight'],
  ];
  const lines: string[] = [`# ${data.project} — workbench`];
  for (const [key, label] of LANES) {
    const items = data.lanes[key] ?? [];
    lines.push(`\n${label} (${items.length})`);
    for (const it of items) {
      const owner = it.owner === 'ai' ? `AI:${it.assignee}` : it.owner === 'human' ? (it.assignee ?? 'you') : 'unassigned';
      const blocked = it.blockedByUnmet.length > 0 ? ` [blocked ×${it.blockedByUnmet.length}]` : '';
      lines.push(`  - ${it.type}/${it.status} ${owner} :: ${it.title}${blocked}`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
}

export async function create(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.slug) fail('project create: --slug is required');
  const slug = args.slug;
  const today = todayIso();

  const meta: Record<string, unknown> = {
    type: 'index',
    status: 'maintained',
    created: today,
    updated: today,
    project: slug,
    tags: args.parent ? [`cluster:${args.parent}`, args.parent, slug] : [slug],
    source_agent: 'soul-cli',
    source_context: `Project created via soul project create on ${today}`,
  };
  if (args.parent) meta.parent_project = `[[${args.parent}|${args.parent}]]`;

  // Merge in --meta-json overrides last so the caller wins.
  if (args['meta-json']) {
    try {
      Object.assign(meta, JSON.parse(args['meta-json']));
    } catch (err) {
      fail(`--meta-json: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const title = args.title ?? slug;
  const content = `# ${title}\n\n> Project home for **${slug}**. Created by \`soul project create\` ${today}.\n\n## Documents\n\n(no decisions yet)\n\n## Related\n\n${args.parent ? `- [[../${args.parent}/index|${args.parent}]] — parent project.\n` : ''}`;

  const body = { zone: `projects/${slug}`, filename: 'index.md', meta, content };

  if (args['dry-run']) {
    emit({ dryRun: true, method: 'POST', path: '/api/vault/notes', body }, opts, (d: any) =>
      `DRY RUN — POST /api/vault/notes\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
    );
    return;
  }

  const data = await apiPost<WriteResp>('/api/vault/notes', body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false
      ? `✗ ${d.error ?? 'unknown error'}`
      : `✓ created project ${slug} → ${d.path ?? `projects/${slug}/index.md`}`,
  );
  exitIfApiFailure(data);
}

/** projects-graph ADR-001 — set the `project_shape:` frontmatter on a
 *  project root `index.md` via the vault chokepoint (PUT /api/vault/notes).
 *  Validates the value against the canonical enum BEFORE the HTTP call so
 *  errors point at the CLI (not the API) when the operator fat-fingers a
 *  shape. Supports `--dry-run`.
 *
 *  Usage:
 *    soul project label-shape <slug> --shape <shape>
 *    soul project label-shape <slug> <shape>      (positional shape)
 */
export async function labelShape(args: Record<string, string | undefined>, opts: OutputOpts) {
  // `args._` packs all positionals as `slug/shape` per index.ts:139.
  const positionals = (args._ ?? '').split('/').filter(Boolean);
  const slug = positionals[0];
  const shape = args.shape ?? positionals[1];

  if (!slug) fail('project label-shape: missing SLUG (e.g. soul project label-shape soul-hub --shape coding-spine)');
  if (!shape) fail('project label-shape: missing SHAPE (--shape coding-spine; one of: ' + PROJECT_SHAPES.join(', ') + ')');
  if (!(PROJECT_SHAPES as readonly string[]).includes(shape)) {
    fail(`project label-shape: invalid shape "${shape}". Allowed: ${PROJECT_SHAPES.join(', ')}`);
  }

  const path = `projects/${slug}/index.md`;
  const body = {
    meta: {
      project_shape: shape,
      // Stamp WHO labelled and WHEN for the Day 1-7 sweep audit trail.
      source_agent: 'soul-cli',
      source_context: `soul project label-shape ${slug} ${shape} (${todayIso()})`,
    },
  };

  if (args['dry-run']) {
    emit({ dryRun: true, method: 'PUT', path: `/api/vault/notes/${path}`, body }, opts, (d: any) =>
      `DRY RUN — PUT /api/vault/notes/${path}\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
    );
    return;
  }

  const data = await apiPut<WriteResp>(`/api/vault/notes/${path}`, body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false
      ? `✗ ${d.error ?? 'unknown error'}`
      : `✓ labelled ${slug} → project_shape: ${shape}`,
  );
  exitIfApiFailure(data);
}

/** ADR-003 Phase 3a — `project_falsifier:` + `falsifier_date:` setter.
 *  Mirror of label-shape (different field set). Sets the optional free-text
 *  claim plus the date the falsifier evaluates. Both fields live on the
 *  project's `index.md`. */
export async function labelFalsifier(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('project label-falsifier: missing SLUG (e.g. soul project label-falsifier signal-forge --on 2026-08-16)');
  if (!args.on) fail('project label-falsifier: --on YYYY-MM-DD is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.on)) {
    fail(`project label-falsifier: --on must be YYYY-MM-DD (got "${args.on}")`);
  }

  const path = `projects/${slug}/index.md`;
  const meta: Record<string, unknown> = {
    falsifier_date: args.on,
    source_agent: 'soul-cli',
    source_context: `soul project label-falsifier ${slug} (${todayIso()})`,
  };
  if (args.text) meta.project_falsifier = args.text;

  const body = { meta };

  if (args['dry-run']) {
    emit({ dryRun: true, method: 'PUT', path: `/api/vault/notes/${path}`, body }, opts, (d: any) =>
      `DRY RUN — PUT /api/vault/notes/${path}\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
    );
    return;
  }

  const data = await apiPut<WriteResp>(`/api/vault/notes/${path}`, body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false
      ? `✗ ${d.error ?? 'unknown error'}`
      : `✓ labelled ${slug} → falsifier_date: ${args.on}${args.text ? ` ("${args.text}")` : ''}`,
  );
  exitIfApiFailure(data);
}

/** ADR-003 Phase 3a — projects-graph next-actions surface. GET-only.
 *  Returns open/blocked/recent_shipped ADRs ranked for "do this next".
 *  Pretty mode shows `next` + counts; --json passes the full structure. */
interface NextActionItem {
  id: string;
  slug: string;
  label: string;
  status: string;
  target_date: string | null;
  falsifier_date: string | null;
}
interface NextActionsResp {
  project: string;
  generated_at: string;
  open: NextActionItem[];
  blocked: NextActionItem[];
  recent_shipped: NextActionItem[];
  next: NextActionItem | null;
  hint: 'no_adrs' | null;
}

export async function nextActions(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('project next-actions: missing SLUG (e.g. soul project next-actions naseej)');
  const data = await apiGet<NextActionsResp>(
    `/api/vault/projects/${slug}/next-actions`,
    { shipped_limit: args.limit },
  );
  emit(data, opts, (d: NextActionsResp) => {
    if (d.hint === 'no_adrs') return `${d.project}: no ADRs yet — propose one with \`soul project propose-adr ${d.project} …\``;
    const lines: string[] = [`Project: ${d.project}`, `Generated: ${d.generated_at}`, ''];
    if (d.next) {
      lines.push(`Next: ${d.next.slug}  (${d.next.status})  ${d.next.label}`);
      lines.push('');
    }
    lines.push(`Open:    ${d.open.length}`);
    for (const o of d.open.slice(0, 10)) lines.push(`  ${o.slug.padEnd(40)} ${o.status.padEnd(10)} ${o.label}`);
    if (d.blocked.length > 0) {
      lines.push('', `Blocked: ${d.blocked.length}`);
      for (const b of d.blocked.slice(0, 10)) lines.push(`  ${b.slug.padEnd(40)} ${b.status.padEnd(10)} ${b.label}`);
    }
    if (d.recent_shipped.length > 0) {
      lines.push('', `Recent shipped: ${d.recent_shipped.length}`);
      for (const s of d.recent_shipped.slice(0, 5)) lines.push(`  ${s.slug.padEnd(40)} ${s.label}`);
    }
    return lines.join('\n');
  });
}

/** ADR-003 Phase 3a — project similarity probe. GET endpoint takes a
 *  proposed slug + optional title + description; returns matches + verdict.
 *  Despite the ADR-003 v1 draft saying `-q TEXT`, the live endpoint requires
 *  `slug` (it's a creation-time validation hook, not free-form search). */
interface SimilarityMatch { slug: string; title?: string; score?: number; reason?: string }
interface SimilarityResp {
  matches: SimilarityMatch[];
  verdict?: string;
  confidence?: string;
  [k: string]: unknown;
}

export async function similar(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args.slug ?? args._;
  if (!slug) fail('project similar: --slug NEW-SLUG is required (proposed kebab-case project slug)');
  const data = await apiGet<SimilarityResp>('/api/vault/projects/similar', {
    slug,
    title: args.title,
    description: args.description,
    skipSemantic: args['skip-semantic'],
  });
  emit(data, opts, (d: SimilarityResp) => {
    if (!d.matches || d.matches.length === 0) return `(no similar projects to "${slug}")`;
    const lines = [
      `Proposed: ${slug}`,
      d.verdict ? `Verdict:  ${d.verdict}${d.confidence ? ` (${d.confidence})` : ''}` : '',
      '',
      'Matches:',
    ].filter(Boolean);
    for (const m of d.matches.slice(0, 10)) {
      lines.push(`  ${m.slug.padEnd(30)} ${m.score ?? '—'}  ${m.title ?? ''}`);
    }
    return lines.join('\n');
  });
}

/** ADR-003 Phase 3a — propose-adr orchestrator surface.
 *  POST /api/vault/projects/:slug/propose-adr — body shape is rich
 *  (working_title + tier + problem_statement + decision_sketch[] +
 *  falsifier_conditions[]). The CLI is a dumb pipe per ADR-001: callers
 *  pass the body via --input-json. Convenience flags --title / --problem /
 *  --tier exist for the most common subset; --input-json wins on conflict. */
export async function proposeAdr(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('project propose-adr: missing SLUG (e.g. soul project propose-adr naseej --input-json \'{...}\')');

  let body: Record<string, unknown> = {};
  if (args.title) body.working_title = args.title;
  if (args.tier) body.tier = args.tier;
  if (args.problem) body.problem_statement = args.problem;
  if (args['input-json']) {
    try {
      const merged = JSON.parse(args['input-json']);
      if (typeof merged !== 'object' || merged === null) {
        fail('project propose-adr: --input-json must be a JSON object');
      }
      body = { ...body, ...(merged as Record<string, unknown>) };
    } catch (err) {
      fail(`project propose-adr: --input-json invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (Object.keys(body).length === 0) {
    fail('project propose-adr: provide --input-json \'{...}\' OR at least --title T --tier "Tier 2" --problem STR');
  }

  if (args['dry-run']) {
    emit(
      { dryRun: true, method: 'POST', path: `/api/vault/projects/${slug}/propose-adr`, body },
      opts,
      (d: any) =>
        `DRY RUN — POST /api/vault/projects/${slug}/propose-adr\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
    );
    return;
  }

  const data = await apiPost<WriteResultLike>(`/api/vault/projects/${slug}/propose-adr`, body);
  emit(data, opts, (d: WriteResultLike) =>
    d.success === false
      ? `✗ ${d.error ?? 'propose-adr failed'}`
      : `✓ proposed ${(d.path as string) ?? slug}`,
  );
  exitIfApiFailure(data);
}

/** ADR-003 Phase 3a — atomic ship-slice mutation surface.
 *  POST /api/vault/projects/:slug/ship-slice. Body shape per ShipSliceRequestSchema
 *  (adr + slice_id + status + optional commit/date/bundle/notes/closes_falsifier).
 *  Same dumb-pipe convention as propose-adr: --input-json is the canonical
 *  shape; --adr / --slice / --status / --commit are shorthand. */
export async function shipSlice(args: Record<string, string | undefined>, opts: OutputOpts) {
  const slug = args._;
  if (!slug) fail('project ship-slice: missing SLUG (e.g. soul project ship-slice naseej --adr 007 --slice S3 --status shipped)');

  let body: Record<string, unknown> = {};
  if (args.adr) body.adr = args.adr;
  if (args.slice) body.slice_id = args.slice;
  if (args.status) body.status = args.status;
  if (args.commit) body.commit = args.commit;
  if (args.notes) body.notes = args.notes;
  if (args['closes-falsifier']) body.closes_falsifier = args['closes-falsifier'];
  if (args['input-json']) {
    try {
      const merged = JSON.parse(args['input-json']);
      if (typeof merged !== 'object' || merged === null) {
        fail('project ship-slice: --input-json must be a JSON object');
      }
      body = { ...body, ...(merged as Record<string, unknown>) };
    } catch (err) {
      fail(`project ship-slice: --input-json invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (Object.keys(body).length === 0) {
    fail('project ship-slice: provide --input-json \'{...}\' OR --adr X --slice S<N> --status STATUS');
  }

  const url = args['dry-run']
    ? `/api/vault/projects/${slug}/ship-slice?dry-run=true`
    : `/api/vault/projects/${slug}/ship-slice`;

  if (args['dry-run']) {
    // The endpoint supports server-side dry-run via ?dry-run=true (returns
    // computed preview without writing). Honour the global --dry-run flag
    // by routing to that. Different from label-shape's local dry-run because
    // ship-slice's preview computation needs server state.
    const data = await apiPost<WriteResultLike>(url, body);
    emit(data, opts, (d: WriteResultLike) =>
      d.success === false
        ? `✗ ${d.error ?? 'ship-slice dry-run failed'}`
        : `DRY RUN — ${slug} ship-slice preview:\n${JSON.stringify((d as any).preview ?? {}, null, 2)}`,
    );
    exitIfApiFailure(data);
    return;
  }

  const data = await apiPost<WriteResultLike>(url, body);
  emit(data, opts, (d: WriteResultLike) =>
    d.success === false
      ? `✗ ${d.error ?? 'ship-slice failed'}`
      : `✓ shipped ${slug}  applied=${JSON.stringify((d as any).applied ?? {})}`,
  );
  exitIfApiFailure(data);
}
