// Output helpers. Default: terse pretty text for humans. --json: raw API JSON
// for pipe composition. Exit codes 0 on success, non-zero on any error.

export interface OutputOpts {
  json: boolean;
}

export function emit(value: unknown, opts: OutputOpts, prettyFn?: (v: any) => string): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(value) + '\n');
    return;
  }
  if (prettyFn) {
    process.stdout.write(prettyFn(value) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function fail(msg: string, code = 1): never {
  process.stderr.write(`soul: ${msg}\n`);
  process.exit(code);
}

// API write endpoints return HTTP 200 with `{success: false, error: ...}` on
// validation failure (not 4xx). Surface that as a non-zero exit so bash
// `&&` chains halt correctly.
export function exitIfApiFailure(data: unknown): void {
  if (data && typeof data === 'object' && (data as { success?: boolean }).success === false) {
    process.exit(1);
  }
}

// Local-time YYYY-MM-DD (matches /api/vault/decisions/transition's todayIso()
// so dates set by the CLI and by the API don't drift across timezones).
export function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function ageDays(epoch: number | null | undefined): string {
  if (!epoch) return '—';
  const days = Math.floor((Date.now() - epoch) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}
