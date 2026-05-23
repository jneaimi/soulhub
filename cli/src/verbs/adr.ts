import { apiGet, apiPost } from '../api.ts';
import { emit, fail, todayIso, exitIfApiFailure, type OutputOpts } from '../output.ts';

interface AdrHit {
  path: string;
  title?: string;
  type?: string;
  project?: string;
  tags?: string[];
  snippet?: string;
}
interface SearchResp { results: AdrHit[]; total?: number; }

export async function list(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.project) fail('adr list: --project SLUG is required');
  const data = await apiGet<SearchResp>('/api/vault/notes', {
    project: args.project,
    type: 'decision',
    limit: args.limit ?? '100',
  });
  emit(data, opts, (d: SearchResp) =>
    d.results.length === 0
      ? '(no ADRs)'
      : d.results
          .map((r) => {
            const file = (r.path.split('/').pop() ?? r.path).padEnd(60);
            return `${file}  ${r.title ?? ''}`;
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
  if (!args.content) fail('adr propose: --content is required');

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

  // Compose minimal decision-template skeleton if the caller didn't supply one.
  const content = /^##\s*Status/m.test(args.content)
    ? args.content
    : `# ${args.title}\n\n## Status\n\nProposed ${today}\n\n## Context\n\n${args.content}\n\n## Decision\n\n(fill in)\n\n## Consequences\n\n(fill in)\n`;

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

export const accept = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('accept', args, opts);
export const ship   = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('ship', args, opts);
export const park   = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('park', args, opts);
export const reject = (args: Record<string, string | undefined>, opts: OutputOpts) => transition('reject', args, opts);
