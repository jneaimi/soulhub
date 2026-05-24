// ADR-008 (soul-hub-cli) — `soul logs`: tail the PM2 log files DIRECTLY from
// disk. The deliberate non-API verb: logs are needed most when the server is
// down, exactly when an `/api/*`-backed verb is useless. Read-only diagnostics,
// no governance surface — so reading local files respects ADR-001's intent
// (writes through chokepoints, no forked logic) while relaxing its literal
// "everything is /api/*". Paths are deterministic per ecosystem.config.cjs.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emit, fail, type OutputOpts } from '../output.ts';

/** SERVICE → log-filename prefix (matches ecosystem.config.cjs LOG_DIR layout). */
const SERVICE_PREFIX: Record<string, string> = {
  'soul-hub': '',
  whatsapp: 'whatsapp-',
  tunnel: 'tunnel-',
};

const LOG_DIR = join(homedir(), '.soul-hub', 'logs');

interface LogsResp {
  service: string;
  file: string;
  lines: string[];
}

export async function logs(args: Record<string, string | undefined>, opts: OutputOpts) {
  const service = args._0 ?? 'soul-hub';
  if (!(service in SERVICE_PREFIX)) {
    fail(`logs: unknown service "${service}". Valid: ${Object.keys(SERVICE_PREFIX).join(', ')}`);
  }
  const prefix = SERVICE_PREFIX[service];
  const file = join(LOG_DIR, `${prefix}${args.errors ? 'error' : 'out'}.log`);

  if (!existsSync(file)) {
    fail(`logs: file not found: ${file} (is the "${service}" service configured?)`);
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    fail(`logs: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // trailing newline

  // --grep applied BEFORE --tail, so `--grep X --tail 20` = "last 20 X lines".
  if (args.grep) {
    const needle = args.grep.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(needle));
  }

  const n = args.tail !== undefined ? Math.max(0, Number.parseInt(args.tail, 10) || 0) : 50;
  lines = lines.slice(-n);

  emit({ service, file, lines } satisfies LogsResp, opts, (d: LogsResp) =>
    d.lines.length === 0 ? `(no matching lines in ${d.file})` : d.lines.join('\n'),
  );
}
