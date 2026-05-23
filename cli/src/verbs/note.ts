import { apiPost, apiPut } from '../api.ts';
import { emit, fail, exitIfApiFailure, type OutputOpts } from '../output.ts';

interface WriteResp {
  success?: boolean;
  path?: string;
  error?: string;
  warnings?: unknown[];
  stubs_created?: unknown[];
}

function parseMetaJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail('--meta-json must parse to a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    fail(`--meta-json: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function dryRunEmit(method: string, path: string, body: unknown, opts: OutputOpts) {
  emit({ dryRun: true, method, path, body }, opts, (d: any) => {
    const lines = [
      `DRY RUN — would ${d.method} ${d.path}`,
      'Body:',
      JSON.stringify(d.body, null, 2)
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n'),
    ];
    return lines.join('\n');
  });
}

export async function create(args: Record<string, string | undefined>, opts: OutputOpts) {
  if (!args.zone) fail('note create: --zone is required');
  if (!args.filename) fail('note create: --filename is required');
  if (!args.content) fail('note create: --content is required');

  const meta = parseMetaJson(args['meta-json']);
  // CLI shorthand: --type X promotes to meta.type if not already in --meta-json.
  if (args.type && !meta.type) meta.type = args.type;

  const body = {
    zone: args.zone,
    filename: args.filename,
    meta,
    content: args.content,
  };

  if (args['dry-run']) return dryRunEmit('POST', '/api/vault/notes', body, opts);

  const data = await apiPost<WriteResp>('/api/vault/notes', body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false
      ? `✗ ${d.error ?? 'unknown error'}`
      : `✓ created ${d.path ?? '(unknown path)'}`,
  );
  exitIfApiFailure(data);
}

export async function update(args: Record<string, string | undefined>, opts: OutputOpts) {
  const path = args._;
  if (!path) fail('note update: missing PATH (e.g. soul note update projects/foo/index.md)');

  const meta = args['meta-json'] ? parseMetaJson(args['meta-json']) : undefined;
  const content = args.content;

  if (meta === undefined && content === undefined) {
    fail('note update: at least one of --meta-json or --content is required');
  }

  const body: Record<string, unknown> = {};
  if (meta !== undefined) body.meta = meta;
  if (content !== undefined) body.content = content;

  if (args['dry-run']) return dryRunEmit('PUT', `/api/vault/notes/${path}`, body, opts);

  const data = await apiPut<WriteResp>(`/api/vault/notes/${path}`, body);
  emit(data, opts, (d: WriteResp) =>
    d.success === false
      ? `✗ ${d.error ?? 'unknown error'}`
      : `✓ updated ${d.path ?? path}`,
  );
  exitIfApiFailure(data);
}
