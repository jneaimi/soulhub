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

export async function list(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.project) fail('adr list: --project SLUG is required');
  const params: Record<string, string> = {
    project: args.project,
    type: 'decision',
    limit: args.limit ?? '100',
  };
  if (args.status) params.status = args.status;
  const data = await apiGet<SearchResp>('/api/vault/notes', params);
  emit(data, opts, (d: SearchResp) =>
    d.results.length === 0
      ? '(no ADRs)'
      : d.results
          .map((r) => {
            const status = (r.status ?? '?').padEnd(9);
            const file = (r.path.split('/').pop() ?? r.path).padEnd(60);
            return `${status} ${file}  ${r.title ?? ''}`;
          })
          .join('\n')
  );
}

interface WriteResp { success?: boolean; path?: string; newStatus?: string; error?: string }

function dryRun(method: string, path: string, body: unknown, opts: OutputOpts) {
  emit({ dryRun: true, method, path, body }, opts, (d: any) =>
    `DRY RUN — ${d.method} ${d.path}\nBody:\n${JSON.stringify(d.body, null, 2).split('\n').map((l) => '  ' + l).join('\n')}`,
  );
}

export async function propose(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.project) fail('adr propose: --project SLUG is required');
  if (!args.slug) fail('adr propose: --slug (e.g. adr-003-some-name) is required');
  if (!args.title) fail('adr propose: --title is required');
  const rawContent = resolveContent(args);
  if (rawContent === undefined) fail('adr propose: one of --content / --content-file / --content - is required');

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
    : `# ${args.title}\n\n## Status\n\nProposed ${today}\n\n## Context\n\n${rawContent}\n\n## Decision\n\n(fill in)\n\n## Consequences\n\n(fill in)\n`;
  if (!/^#\s+\S/m.test(content)) {
    content = `# ${args.title}\n\n${content.replace(/^\s+/, '')}`;
  }

  const filename = args.slug.endsWith('.md') ? args.slug : `${args.slug}.md`;
  const body = { zone: `projects/${args.project}`, filename, meta, content };

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
export const ship   = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('ship', args, opts);
export const park   = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('park', args, opts);
export const reject = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('reject', args, opts);
