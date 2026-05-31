import { readFileSync } from 'node:fs';
import { apiPost, apiPut, apiDelete } from '../api.ts';
import { emit, fail, exitIfApiFailure, type OutputOpts } from '../output.ts';
import { resolveContent } from '../content-input.ts';

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
  const content = resolveContent(args);
  if (content === undefined) fail('note create: one of --content / --content-file / --content - is required');

  const meta = parseMetaJson(args['meta-json']);
  // CLI shorthand: --type X promotes to meta.type if not already in --meta-json.
  if (args.type && !meta.type) meta.type = args.type;

  const body = {
    zone: args.zone,
    filename: args.filename,
    meta,
    content,
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
  const content = resolveContent(args);

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

// ── ADR-004 — link-safe relocation (move / rename) ──────────────────

export interface RelocateResp {
  success?: boolean;
  error?: string;
  dryRun?: boolean;
  moves?: { src: string; dst: string }[];
  rewrites?: { path: string; bodyCount: number; metaCount: number }[];
}

export function emitRelocate(data: RelocateResp, opts: OutputOpts) {
  emit(data, opts, (d: RelocateResp) => {
    if (d.success === false) return `✗ ${d.error ?? 'move failed'}`;
    const lines: string[] = [];
    const moveVerb = d.dryRun ? 'DRY RUN — would move' : '✓ moved';
    for (const m of d.moves ?? []) lines.push(`${moveVerb}  ${m.src}  →  ${m.dst}`);
    const rw = d.rewrites ?? [];
    const body = rw.reduce((s, r) => s + r.bodyCount, 0);
    const meta = rw.reduce((s, r) => s + r.metaCount, 0);
    lines.push(`${d.dryRun ? 'would rewrite' : 'rewrote'} links in ${rw.length} note(s)  (${body} body, ${meta} frontmatter)`);
    for (const r of rw) lines.push(`    ${r.path}  (${r.bodyCount}b ${r.metaCount}f)`);
    return lines.join('\n');
  });
}

/** soul note move <src-path> <dst-zone> [--rename <new-filename>] [--dry-run] */
export async function move(args: Record<string, string | undefined>, opts: OutputOpts) {
  const src = args._0;
  const toZone = args._1;
  if (!src || !toZone) {
    fail('note move: usage: soul note move <src-path> <dst-zone> [--rename <new-filename>] [--dry-run]');
  }
  const body: Record<string, unknown> = { src, targetZone: toZone, dryRun: !!args['dry-run'] };
  if (args.rename) body.newFilename = args.rename;
  const data = await apiPost<RelocateResp>('/api/vault/notes/move', body);
  emitRelocate(data, opts);
  exitIfApiFailure(data);
}

/** soul note rename <src-path> <new-filename> [--dry-run] */
export async function rename(args: Record<string, string | undefined>, opts: OutputOpts) {
  const src = args._0;
  const newName = args._1;
  if (!src || !newName) {
    fail('note rename: usage: soul note rename <src-path> <new-filename> [--dry-run]');
  }
  const data = await apiPost<RelocateResp>('/api/vault/notes/move', {
    src,
    newFilename: newName,
    dryRun: !!args['dry-run'],
  });
  emitRelocate(data, opts);
  exitIfApiFailure(data);
}

/** soul note delete <path> [--dry-run]
 *
 *  Archive a vault note (the server-side delete is "archive to archive/", not
 *  permanent destruction).  Convenient for cleaning up CLI typos / mistaken
 *  proposes — e.g. an ADR slug landed without the `adr-NNN-` prefix and was
 *  rejected by `soul adr list`.  Permanent removal still requires direct
 *  `rm` on the archived file in `~/vault/archive/...`. */
export async function deleteNote(args: Record<string, string | undefined>, opts: OutputOpts) {
  const path = args._;
  if (!path) fail('note delete: usage: soul note delete <path> [--dry-run]');
  if (args['dry-run']) {
    emit(
      { dryRun: true, method: 'DELETE', path: `/api/vault/notes/${path}` },
      opts,
      (d: { method: string; path: string }) => `DRY RUN — ${d.method} ${d.path}`,
    );
    return;
  }
  const data = await apiDelete<{ success?: boolean; error?: string; archivedTo?: string }>(
    `/api/vault/notes/${path}`,
  );
  emit(data, opts, (d) =>
    d.success === false
      ? `✗ ${d.error ?? 'delete failed'}`
      : `✓ archived ${path}${d.archivedTo ? ` → ${d.archivedTo}` : ''}`,
  );
  exitIfApiFailure(data);
}

/** soul note move-batch (--moves-json '[...]' | --moves-file PATH) [--dry-run]
 *  Each element: { src, targetZone?, newFilename? }. Moves the whole set in one
 *  pass — mutually-referencing notes relocate without a forward-ref failure. */
export async function moveBatch(args: Record<string, string | undefined>, opts: OutputOpts) {
  let raw = args['moves-json'];
  if (!raw && args['moves-file']) {
    try {
      raw = readFileSync(args['moves-file'], 'utf8');
    } catch (err) {
      fail(`note move-batch: --moves-file: cannot read ${args['moves-file']}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!raw) fail('note move-batch: --moves-json JSON or --moves-file PATH is required');
  let moves: unknown;
  try {
    moves = JSON.parse(raw);
  } catch (err) {
    fail(`note move-batch: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(moves)) fail('note move-batch: moves must be a JSON array of { src, targetZone?, newFilename? }');
  const data = await apiPost<RelocateResp>('/api/vault/notes/move', { moves, dryRun: !!args['dry-run'] });
  emitRelocate(data, opts);
  exitIfApiFailure(data);
}
