import { apiGet, apiPost } from '../api.ts';
import { emit, fail, ageDays, type OutputOpts } from '../output.ts';

interface Hit { path: string; title?: string; score?: number; meta?: Record<string, unknown>; }
interface SearchResp { results: Hit[]; total?: number; }

export async function search(args: Record<string, string | undefined>, opts: OutputOpts) {
  const q = args.q ?? args._;
  if (!q && !args.zone && !args.project && !args.type) {
    fail('vault search: need at least one of -q QUERY, --zone, --project, --type');
  }
  const data = await apiGet<SearchResp>('/api/vault/notes', {
    q,
    zone: args.zone,
    project: args.project,
    type: args.type,
    limit: args.limit ?? '20',
  });
  emit(data, opts, (d: SearchResp) =>
    d.results.length === 0
      ? '(no matches)'
      : d.results.map((h) => `${h.path}  —  ${h.title ?? ''}`).join('\n')
  );
}

interface NoteDetail { path: string; title?: string; content?: string; meta?: Record<string, unknown>; }

export async function get(args: Record<string, string | undefined>, opts: OutputOpts) {
  const path = args._;
  if (!path) fail('vault get: missing PATH (e.g. soul vault get projects/foo/index.md)');
  const data = await apiGet<NoteDetail>(`/api/vault/notes/${path}`);
  emit(data, opts, (d: NoteDetail) => {
    const head = `# ${d.title ?? d.path}`;
    const body = d.content ?? '(no content)';
    return `${head}\n\n${body}`;
  });
}

interface RecentResp { notes: Array<{ path: string; title?: string; mtime?: number }>; }

export async function recent(args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<RecentResp>('/api/vault/recent', { limit: args.limit ?? '20' });
  emit(data, opts, (d: RecentResp) =>
    d.notes.map((n) => `${n.path}  —  ${n.title ?? ''}`).join('\n')
  );
}

/** ADR-003 Phase 3a — vault hygiene rollup. GET /api/vault/hygiene.
 *  No query params; returns the full report. Pretty mode collapses to
 *  the violation counts; --json passes the raw report through for jq. */
interface HygieneReport {
  generatedAt?: string;
  totals?: { orphans?: number; brokenLinks?: number; staleInbox?: number; violations?: number };
  violations?: Array<{ path?: string; rule?: string; message?: string }>;
  [k: string]: unknown;
}

export async function hygiene(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<HygieneReport & { totals?: Record<string, number>; healthScore?: number }>(
    '/api/vault/hygiene',
  );
  emit(data, opts, (d) => {
    const t = (d.totals ?? {}) as Record<string, number>;
    const lines = [
      `Vault hygiene  (health=${d.healthScore ?? '—'})`,
      d.generatedAt ? `Generated: ${d.generatedAt}` : '',
      '',
      `  indexed                ${t.indexed ?? 0}`,
      `  orphans                ${t.orphans ?? 0}`,
      `  unresolved links       ${t.unresolved ?? 0}`,
      `  stale inbox            ${t.staleInbox ?? 0}`,
      `  status contradictions  ${t.statusContradictions ?? 0}`,
      `  governance violations  ${t.governanceViolations ?? 0}`,
      `  misplaced notes        ${t.misplacedNotes ?? 0}`,
    ].filter(Boolean);
    return lines.join('\n');
  });
}

/** ADR-003 Phase 3a — force a full vault reindex. POST /api/vault/reindex,
 *  no body. Used after bulk edits to wait out the watcher debounce. */
interface ReindexResp { stats?: Record<string, unknown>; error?: string }

export async function reindex(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiPost<ReindexResp>('/api/vault/reindex', {});
  emit(data, opts, (d: ReindexResp) =>
    d.error ? `✗ ${d.error}` : `✓ reindex complete  ${JSON.stringify(d.stats ?? {})}`,
  );
}

/** ADR-003 Phase 3a — agent write audit log. GET /api/vault/writes.
 *  Query: agent? (exact), actor_prefix? (prefix), zone?, limit? (1..200). */
interface WriteEntry {
  path: string;
  agent?: string;
  zone?: string;
  action?: string;
  context?: string;
  /** ISO-8601 string (e.g. "2026-05-19T21:33:28.201Z"). The engine emits
   *  string timestamps; we parse to epoch ms for ageDays(). */
  timestamp?: string | number;
  [k: string]: unknown;
}
interface WritesResp { entries: WriteEntry[]; total: number }

export async function writes(args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<WritesResp>('/api/vault/writes', {
    agent: args.agent,
    actor_prefix: args['actor-prefix'],
    zone: args.zone,
    limit: args.limit ?? '50',
  });
  emit(data, opts, (d: WritesResp) => {
    if (d.entries.length === 0) return '(no writes in window)';
    return d.entries
      .map((e) => {
        const epoch = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : e.timestamp;
        const age = ageDays(epoch ?? null);
        const agent = (e.agent ?? '—').padEnd(20);
        const action = (e.action ?? '').padEnd(8);
        return `${age.padEnd(10)} ${action} ${agent} ${e.path}`;
      })
      .join('\n');
  });
}

/** ADR-003 Phase 3a — wikilinks that don't resolve to any note.
 *  GET /api/vault/unresolved — no query params, returns the full set. */
/** Engine returns one row per (source, raw-link) pair — not a count per
 *  unique link. We group client-side so the pretty output shows the link
 *  once with its incoming-source list. --json forwards the raw rows. */
interface UnresolvedRow { source: string; raw: string }
interface UnresolvedResp { unresolved: UnresolvedRow[] }

export async function unresolved(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const data = await apiGet<UnresolvedResp>('/api/vault/unresolved');
  emit(data, opts, (d: UnresolvedResp) => {
    const rows = d.unresolved ?? [];
    if (rows.length === 0) return '(no unresolved links)';
    const grouped = new Map<string, string[]>();
    for (const r of rows) {
      const list = grouped.get(r.raw) ?? [];
      list.push(r.source);
      grouped.set(r.raw, list);
    }
    return [...grouped.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([raw, sources]) => `${raw.padEnd(60)} ${sources.length}× ${sources[0]}`)
      .join('\n');
  });
}
