import { apiGet, apiPost } from '../api.ts';
import { emit, fail, todayIso, exitIfApiFailure, type OutputOpts } from '../output.ts';
import { resolveContent } from '../content-input.ts';
import { emitRelocate, type RelocateResp } from './note.ts';

interface AdrHit {
  path: string;
  title?: string;
  type?: string;
  status?: string;
  project?: string;
  tags?: string[];
  snippet?: string;
}
interface SearchResp { results: AdrHit[]; total?: number; }

// ADR-013 D1 — parse the ADR number from a filename. Anchored on `adr-` so a
// note whose name merely *mentions* an ADR (e.g. a dated
// `2026-05-19-adr-009-postship-smoke-decision.md` or a non-ADR decision note)
// returns null rather than a bogus number. Leading zeros are stripped
// (`adr-009` → 9) so the value is a true integer for sorting.
function adrNumberFromPath(path: string): number | null {
  const file = path.split('/').pop() ?? '';
  const m = /^adr-0*(\d+)/.exec(file);
  return m ? Number(m[1]) : null;
}

/** Auto-prefix a raw slug with `adr-NNN-` by computing the next free ordinal
 *  for the given project.  If the slug already starts with `adr-NNN-`, it is
 *  returned as-is (operator override).  Returns { slug, ordinal } so callers
 *  can also prefix the H1 title with `ADR-NNN — `. */
async function resolveNextAdrSlug(
  project: string,
  rawSlug: string,
): Promise<{ slug: string; ordinal: number }> {
  const cleaned = rawSlug.replace(/\.md$/, '');
  const explicit = /^adr-0*(\d+)-(.+)$/i.exec(cleaned);
  if (explicit) {
    // Operator passed the prefix explicitly; honor it verbatim.
    return { slug: cleaned, ordinal: Number(explicit[1]) };
  }
  // List existing ADRs for the project to find the highest ordinal.
  const data = await apiGet<SearchResp>('/api/vault/notes', {
    project,
    type: 'decision',
    limit: '500',
  });
  let highest = 0;
  for (const r of data.results) {
    const n = adrNumberFromPath(r.path);
    if (n !== null && n > highest) highest = n;
  }
  const ordinal = highest + 1;
  const padded = String(ordinal).padStart(3, '0');
  return { slug: `adr-${padded}-${cleaned}`, ordinal };
}

// ADR-013 D1/D3 — the projected ADR list row. Carries the parsed `number`
// (D1) and drops the search-only `score`/`snippet` fields that leak from the
// `/api/vault/notes` projection (D3); `adr list` never sends a text query, so a
// snippet is always noise here.
interface AdrRow {
  number: number | null;
  status: string;
  path: string;
  title: string;
  tags: string[];
}

export async function list(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.project) fail('adr list: --project SLUG is required');
  const params: Record<string, string> = {
    project: args.project,
    type: 'decision',
    limit: args.limit ?? '100',
  };
  if (args.status) params.status = args.status;
  const data = await apiGet<SearchResp>('/api/vault/notes', params);

  // ADR-013 D2 — sort ascending by ADR number; non-`adr-NNN` decision notes
  // (number === null) sort last so the canonical sequence reads top-to-bottom
  // and "the next free number" is a glance, not a regex. Applied to the shared
  // row array so --json and the human table agree.
  const rows: AdrRow[] = data.results
    .map((r) => ({
      number: adrNumberFromPath(r.path),
      status: r.status ?? '?',
      path: r.path,
      title: r.title ?? '',
      tags: r.tags ?? [],
    }))
    .sort((a, b) => {
      if (a.number === null && b.number === null) return 0;
      if (a.number === null) return 1;
      if (b.number === null) return -1;
      return a.number - b.number;
    });

  const out = { results: rows, total: data.total ?? rows.length };
  emit(out, opts, (d: typeof out) =>
    d.results.length === 0
      ? '(no ADRs)'
      : d.results
          .map((r) => {
            const num = (r.number === null ? '—' : String(r.number)).padStart(3);
            const status = r.status.padEnd(9);
            const file = (r.path.split('/').pop() ?? r.path).padEnd(60);
            return `${num}  ${status} ${file}  ${r.title}`;
          })
          .join('\n')
  );
}

interface WriteResp { success?: boolean; path?: string; newStatus?: string; error?: string }

// ADR-042 D4 — note detail shape for fetching phases frontmatter before ship.
interface NoteDetail { path?: string; title?: string; meta?: Record<string, unknown>; error?: string }

// ADR-042 D4 — merge-partial response shape.
interface MergePartialResp {
  success?: boolean;
  phase?: string;
  lastPhase?: boolean;
  merged?: boolean;
  branch?: string;
  path?: string;
  alreadyShipped?: boolean;
  message?: string;
  newShippedPhases?: string[];
  newStatus?: string;
  error?: string;
}

function dryRun(method: string, path: string, body: unknown, opts: OutputOpts) {
  emit({ dryRun: true, method, path, body }, opts, (d: any) =>
    `DRY RUN — ${d.method} ${d.path}\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
  );
}

export async function propose(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.project) fail('adr propose: --project SLUG is required');
  if (!args.slug) fail('adr propose: --slug (e.g. structural-dispatch-scope-enforcement) is required');
  if (!args.title) fail('adr propose: --title is required');
  const rawContent = resolveContent(args);
  if (rawContent === undefined) fail('adr propose: one of --content / --content-file / --content - is required');

  // Auto-prefix the slug with `adr-NNN-` if the operator didn't include it.
  // Reads existing ADRs in the project to compute the next free ordinal.
  // Operator can still pass an explicit `adr-NNN-foo` to override.
  const { slug: resolvedSlug, ordinal } = await resolveNextAdrSlug(args.project, args.slug);
  // Mirror the prefix on the H1 title so the rendered note reads
  // `# ADR-NNN — Title` consistently with the vault convention.
  const adrPaddedNum = String(ordinal).padStart(3, '0');
  const titleHasAdrPrefix = /^ADR-\d+\s*[—-]/i.test(args.title);
  const resolvedTitle = titleHasAdrPrefix ? args.title : `ADR-${adrPaddedNum} — ${args.title}`;

  const today = todayIso();
  const meta: Record<string, unknown> = {
    type: 'decision',
    status: 'proposed',
    created: today,
    project: args.project,
    tags: ['decision', 'adr', args.project],
    source_agent: 'soul-cli',
  };
  if (args['meta-json']) {
    try {
      Object.assign(meta, JSON.parse(args['meta-json']));
    } catch (err) {
      fail(`--meta-json: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Compose a minimal decision-template skeleton if the caller didn't supply
  // the section structure. Either way, guarantee the template H1 (# ADR-N —
  // Title): a fully-authored body that starts at "## Status" passes the
  // skeleton check but lacks the H1, and the project graph then renders it as
  // an ugly slug-derived label (the ADR-012 symptom). Fail-closed mirror lives
  // in the vault template validator (requiresH1).
  let content = /^##\s*Status/m.test(rawContent)
    ? rawContent
    : `# ${resolvedTitle}\n\n## Status\n\nProposed ${today}\n\n## Context\n\n${rawContent}\n\n## Decision\n\n(fill in)\n\n## Consequences\n\n(fill in)\n`;
  if (!/^#\s+\S/m.test(content)) {
    content = `# ${resolvedTitle}\n\n${content.replace(/^\s+/, '')}`;
  }

  const filename = resolvedSlug.endsWith('.md') ? resolvedSlug : `${resolvedSlug}.md`;
  const body = { zone: `projects/${args.project}`, filename, meta, content };

  // ADR-044 P2 — fail-closed lint pre-flight on the candidate note shape.
  // Operator can pass `--skip-lint "reason"` to bypass (audited).  See
  // src/lib/vault/adr-lint.ts for the R5/R9/R11 rules.
  if (!args['skip-lint']) {
    const candidatePath = `projects/${args.project}/${filename}`;
    try {
      const lintResp = await apiPost<{ findings?: { rule: string; severity: string; message: string }[]; highSeverityCount?: number }>(
        '/api/vault/adr-lint',
        { candidate: { path: candidatePath, meta, content } },
      );
      const high = (lintResp.findings ?? []).filter((f) => f.severity === 'high');
      if (high.length > 0) {
        emit(
          { success: false, error: 'lint-failed', findings: lintResp.findings },
          opts,
          () => {
            const lines = [`✗ adr propose: refused — ${high.length} high-severity lint finding${high.length === 1 ? '' : 's'}:`];
            for (const f of high) lines.push(`  ✗ [${f.rule}] ${f.message}`);
            lines.push('');
            lines.push('Fix the findings in the body / meta-json, or pass `--skip-lint "<reason>"` to override (audited).');
            return lines.join('\n');
          },
        );
        process.exit(1);
      }
    } catch (err) {
      // Lint endpoint unreachable (Soul Hub down?) — fall through with a warning.
      // We don't fail-closed here because the propose may be running in a
      // disaster-recovery context.  The dispatcher chokepoint will catch it
      // later anyway.
      process.stderr.write(`⚠  adr propose: lint pre-flight skipped (${err instanceof Error ? err.message : String(err)})\n`);
    }
  } else {
    process.stderr.write(`⚠  adr propose: lint bypassed via --skip-lint "${args['skip-lint']}"\n`);
  }

  if (args['dry-run']) return dryRun('POST', '/api/vault/notes', body, opts);

  const data = await apiPost<WriteResp>('/api/vault/notes', body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false ? `✗ ${d.error ?? 'unknown error'}` : `✓ proposed ${d.path ?? filename}`,
  );
  exitIfApiFailure(data);
}

async function transition(action: 'accept' | 'reject' | 'park' | 'ship', args: Record<string, string | undefined>, opts: OutputOpts) {
  const path = args._;
  if (!path) fail(`adr ${action}: missing PATH (e.g. soul adr ${action} projects/foo/adr-001-bar.md)`);
  if (action === 'reject' && !args.reason) fail('adr reject: --reason is required');
  if (action === 'park' && !args['review-after']) fail('adr park: --review-after YYYY-MM-DD is required');

  // ADR-044 P2 — lint pre-flight on accept (the gateway to dispatch).
  // Skipped for park/reject (terminal-but-non-dispatch states) and ship
  // (already past dispatch).  Operator can override with --skip-lint.
  if (action === 'accept' && !args['skip-lint']) {
    try {
      const lintResp = await apiPost<{ findings?: { rule: string; severity: string; message: string }[]; highSeverityCount?: number }>(
        '/api/vault/adr-lint',
        { path },
      );
      const high = (lintResp.findings ?? []).filter((f) => f.severity === 'high');
      if (high.length > 0) {
        emit(
          { success: false, error: 'lint-failed', findings: lintResp.findings },
          opts,
          () => {
            const lines = [`✗ adr accept: refused — ${high.length} high-severity lint finding${high.length === 1 ? '' : 's'}:`];
            for (const f of high) lines.push(`  ✗ [${f.rule}] ${f.message}`);
            lines.push('');
            lines.push(`Fix the findings in ${path}, or re-run with \`--skip-lint "<reason>"\` to override (audited).`);
            return lines.join('\n');
          },
        );
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(`⚠  adr accept: lint pre-flight skipped (${err instanceof Error ? err.message : String(err)})\n`);
    }
  } else if (action === 'accept' && args['skip-lint']) {
    process.stderr.write(`⚠  adr accept: lint bypassed via --skip-lint "${args['skip-lint']}"\n`);
  }

  const body: Record<string, unknown> = { path, action };
  if (args.reason) body.reason = args.reason;
  if (args['review-after']) body.reviewAfter = args['review-after'];

  if (args['dry-run']) return dryRun('POST', '/api/vault/decisions/transition', body, opts);

  const data = await apiPost<WriteResp>('/api/vault/decisions/transition', body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false
      ? `✗ ${d.error ?? 'unknown error'}`
      : `✓ ${path} → ${d.newStatus ?? action + 'ed'}`,
  );
  exitIfApiFailure(data);
}

/** soul adr move <src> --project <p> [--rename <new-filename>] [--dry-run]
 *  ADR-aware convenience over `note move`: relocates an ADR into another
 *  project's zone (projects/<p>), link-safe. Renumbering the in-body
 *  `# ADR-NNN` heading is deferred to a follow-up (v1 moves + rewrites links). */
export async function move(args: Record<string, string | undefined>, opts: OutputOpts) {
  const src = args._0;
  if (!src) fail('adr move: usage: soul adr move <src-path> --project <slug> [--rename <new-filename>] [--dry-run]');
  if (!args.project) fail('adr move: --project SLUG is required');
  const body: Record<string, unknown> = {
    src,
    targetZone: `projects/${args.project}`,
    dryRun: !!args['dry-run'],
  };
  if (args.rename) body.newFilename = args.rename;
  const data = await apiPost<RelocateResp>('/api/vault/notes/move', body);
  emitRelocate(data, opts);
  exitIfApiFailure(data);
}

export const accept = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('accept', args, opts);
export const park   = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('park', args, opts);
export const reject = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('reject', args, opts);

/** ADR-042 D4 — enhanced `soul adr ship`.
 *
 *  When the ADR has `phases:` set and unshipped phases remain, prints a
 *  structured warning and exits 1 unless `--force-final` is passed.
 *  This prevents accidentally running a full `ship` (status → shipped) on an
 *  ADR that still has phases in flight; use `soul adr merge-partial` instead.
 *
 *  `--force-final` bypasses the check (operator override for when all phases
 *  are actually done and the status just needs flipping). */
export async function ship(args: Record<string, string | undefined>, opts: OutputOpts) {
  const path = args._;
  if (!path) fail('adr ship: missing PATH (e.g. soul adr ship projects/foo/adr-001-bar.md)');

  // Phase-guard: fetch the note's frontmatter, warn if unshipped phases exist.
  if (!args['force-final']) {
    try {
      const note = await apiGet<NoteDetail>(`/api/vault/notes/${path}`);
      if (note && !note.error) {
        const meta = note.meta ?? {};
        const phases = Array.isArray(meta.phases) ? (meta.phases as unknown[]).filter((p): p is string => typeof p === 'string') : [];
        const shipped = Array.isArray(meta.shipped_phases) ? (meta.shipped_phases as unknown[]).filter((p): p is string => typeof p === 'string') : [];
        if (phases.length > 0 && shipped.length < phases.length) {
          const unshipped = phases.filter((p) => !shipped.includes(p));
          emit(
            {
              success: false,
              warning: 'unshipped-phases',
              phases,
              shipped_phases: shipped,
              unshipped_phases: unshipped,
              hint: `ADR has unshipped phases: ${unshipped.map((p) => `\`${p}\``).join(', ')} — use \`soul adr merge-partial\` for in-progress phases, or re-run with \`--force-final\` to skip remaining.`,
            },
            opts,
            (d: { hint?: string }) =>
              `⚠  ${d.hint ?? 'Unshipped phases exist. Use --force-final to skip this check.'}`,
          );
          process.exit(1);
        }
      }
    } catch {
      // If the fetch fails (e.g. Soul Hub down), fall through to the normal
      // transition call — the user gets the API error there.
    }
  }

  return transition('ship', args, opts);
}

/** ADR-044 P1 — `soul adr lint [PATH | --project SLUG | --all]`
 *
 *  Author-time and CI-time pre-flight for the structural-misroute class of
 *  ADR bugs (R5 / R9 / R11 — see `src/lib/vault/adr-lint.ts` for rules).
 *
 *  Modes:
 *    - PATH given: lint a single ADR
 *    - --project SLUG: lint every ADR under projects/<slug>/
 *    - --all: lint every ADR in the vault (slow; CI mode)
 *
 *  Exit codes:
 *    0 — no high-severity findings (medium/low may still print)
 *    1 — at least one ADR has high-severity findings (or fetch errors)
 *
 *  --json flag emits structured output for CI / scripting.  Implemented
 *  via the global --json switch consumed by `emit` in output.ts. */
interface LintResp {
  success?: boolean;
  path?: string;
  findings?: { rule: string; severity: 'high' | 'medium' | 'low'; message: string }[];
  highSeverityCount?: number;
  error?: string;
}

export async function lint(args: Record<string, string | undefined>, opts: OutputOpts) {
  const singlePath = args._;
  const project = args.project;
  const all = !!args['all'];
  if (!singlePath && !project && !all) {
    fail('adr lint: missing PATH or --project SLUG or --all\n  e.g. soul adr lint projects/foo/adr-001.md');
  }

  // Collect target paths
  const paths: string[] = [];
  if (singlePath) {
    paths.push(singlePath);
  } else {
    // Page through /api/vault/notes filtered by type=decision
    let offset = 0;
    for (;;) {
      const q: Record<string, string | number> = { type: 'decision', limit: 100, offset };
      if (project) q.project = project;
      const page = await apiGet<{ results?: { path?: string }[] }>('/api/vault/notes', q);
      const hits = (page.results ?? []).filter((r) => typeof r.path === 'string' && /\/adr-\d+/.test(r.path)).map((r) => r.path!);
      paths.push(...hits);
      if ((page.results ?? []).length < 100) break;
      offset += 100;
    }
  }

  if (paths.length === 0) {
    emit({ success: true, results: [], highSeverityTotal: 0 }, opts, () => '✓ no ADRs matched the filter');
    return;
  }

  // Lint each in parallel chunks of 10 to keep the server happy.
  type Hit = { path: string; findings: LintResp['findings']; highSeverityCount: number; error?: string };
  const results: Hit[] = [];
  const chunkSize = 10;
  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    const lintedChunk = await Promise.all(chunk.map(async (p): Promise<Hit> => {
      try {
        const r = await apiPost<LintResp>('/api/vault/adr-lint', { path: p });
        if (r.success === false) {
          return { path: p, findings: [], highSeverityCount: 0, error: r.error ?? 'unknown' };
        }
        return { path: p, findings: r.findings ?? [], highSeverityCount: r.highSeverityCount ?? 0 };
      } catch (err) {
        return { path: p, findings: [], highSeverityCount: 0, error: err instanceof Error ? err.message : String(err) };
      }
    }));
    results.push(...lintedChunk);
  }

  const highSeverityTotal = results.reduce((s, r) => s + r.highSeverityCount, 0);
  const dirty = results.filter((r) => (r.findings ?? []).length > 0 || r.error);

  emit(
    { success: highSeverityTotal === 0, results: dirty, highSeverityTotal, totalScanned: results.length },
    opts,
    () => {
      const lines: string[] = [];
      lines.push(`Scanned ${results.length} ADR${results.length === 1 ? '' : 's'}; ${dirty.length} with findings, ${highSeverityTotal} high-severity total.`);
      for (const r of dirty) {
        lines.push('');
        lines.push(`▸ ${r.path}`);
        if (r.error) {
          lines.push(`  ✗ ${r.error}`);
          continue;
        }
        for (const f of (r.findings ?? [])) {
          const icon = f.severity === 'high' ? '✗' : f.severity === 'medium' ? '⚠' : 'ℹ';
          lines.push(`  ${icon} [${f.rule}] ${f.message}`);
        }
      }
      if (highSeverityTotal === 0 && dirty.length === 0) {
        lines.push('✓ clean');
      }
      return lines.join('\n');
    },
  );

  if (highSeverityTotal > 0) process.exit(1);
}

/** ADR-042 D4 — `soul adr merge-partial <path> --phase <id> [--dry-run]`
 *
 *  Merges the ADR's worktree branch into main for a single declared phase,
 *  updates `shipped_phases: [...existing, <id>]`, and leaves `status: accepted`
 *  for subsequent phases.  When the last phase is merged, auto-promotes the
 *  status to `shipped` and cleans up the worktree.
 *
 *  Idempotent: re-running with an already-shipped phase prints a notice and
 *  exits 0 without any git or vault changes. */
export async function mergePartial(args: Record<string, string | undefined>, opts: OutputOpts) {
  const path = args._;
  const phase = args.phase;
  if (!path) fail('adr merge-partial: missing PATH (e.g. soul adr merge-partial projects/foo/adr-001-bar.md --phase D2)');
  if (!phase) fail('adr merge-partial: --phase PHASE_ID is required (e.g. --phase D2)');

  const body = { path, phase };

  if (args['dry-run']) return dryRun('POST', '/api/agents/merge-partial', body, opts);

  const data = await apiPost<MergePartialResp>('/api/agents/merge-partial', body);
  emit(data, opts, (d: MergePartialResp) => {
    if (d.success === false) return `✗ ${d.error ?? 'unknown error'}`;
    if (d.alreadyShipped) return `ℹ  ${d.message ?? `Phase '${d.phase}' already shipped — no changes.`}`;
    const mergeNote = d.merged ? `merged branch ${d.branch}` : 'branch already on main';
    const statusNote = d.lastPhase
      ? ` · status → shipped (last phase)`
      : ` · status stays accepted`;
    return `✓ phase ${d.phase} — ${mergeNote}${statusNote}\n  shipped_phases: [${(d.newShippedPhases ?? []).join(', ')}]`;
  });
  exitIfApiFailure(data);
}
