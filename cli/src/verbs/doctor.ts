import { apiGet, baseUrl, ApiError } from '../api.ts';
import { emit, type OutputOpts } from '../output.ts';
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

interface CatalogIndexFreshness {
  exists: boolean;
  fresh: boolean;
  indexPath: string;
  indexMtime: string | null;
  newestSource: string | null;
  newestSourceMtime: string | null;
  ageSeconds: number | null;
}

interface InboxAccountHealth {
  id: string;
  email: string;
  status: string;
  lastSync: number | null;
  ageMs: number | null;
  stale: boolean;
}
interface InboxHealth {
  accounts: InboxAccountHealth[];
  stale_count: number;
}

interface ClaudeConfigHealth {
  configRoot: string;            // resolved path of ~/.claude (target of the symlink, or itself)
  unexpectedDead: Array<{ path: string; target: string }>;
  allowlistedDead: number;       // count — informational, not a finding
  allowlistMissing: boolean;     // .symlink-allowlist file absent on disk
}

interface DoctorReport {
  ok: boolean;
  baseUrl: string;
  api: { reachable: boolean; status?: number | string };
  cli: { version: string; path: string };
  hooks: { writeGuard: boolean; bashGuard: boolean; soulCliGuard: boolean; vaultWriteSkill: boolean };
  claudeConfig: ClaudeConfigHealth | { probed: false; reason: string };
  catalogIndex: CatalogIndexFreshness | { probed: false; reason: string };
  inbox: InboxHealth | { probed: false; reason: string };
  notes: string[];
}

const INBOX_STALE_THRESHOLD_MS = 30 * 60 * 1000;

function ageShort(epochMs: number | null | undefined): string {
  if (!epochMs) return 'never';
  const ms = Date.now() - epochMs;
  if (ms < 0) return '0s ago';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pkgVersion(): string {
  try {
    const p = join(import.meta.dirname ?? '', '..', '..', 'package.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version ?? '?';
  } catch {}
  return '?';
}

// Recursive symlink walker for claudeConfigCheck. Skips heavyweight + irrelevant
// dirs (.git, node_modules, .venv, __pycache__) so a single doctor invocation
// stays sub-second even on a deep config tree.
const WALK_SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
function walkForDeadSymlinks(root: string, current: string, out: Array<{ path: string; target: string }>): void {
  let entries;
  try {
    // `encoding: 'utf8'` picks the string-flavored Dirent overload so
    // `entry.name` is a string (default is Buffer, which won't accept string ops).
    entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;                                // unreadable dir — skip silently
  }
  for (const entry of entries) {
    if (WALK_SKIP.has(entry.name)) continue;
    const full = join(current, entry.name);
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) {
      // `existsSync` follows the symlink — returns false on dead targets.
      if (!existsSync(full)) {
        let target = '';
        try { target = readlinkSync(full); } catch {}
        out.push({ path: relative(root, full), target });
      }
    } else if (stat.isDirectory()) {
      walkForDeadSymlinks(root, full, out);
    }
  }
}

// Mirror of the pre-push gate's .symlink-allowlist reader. Each non-empty,
// non-comment line is a repo-relative path that the operator has declared
// expected-dead-on-this-machine (e.g. aspirational ~/.agents/skills/X).
function loadSymlinkAllowlist(configRoot: string): { entries: Set<string>; missing: boolean } {
  const allowlistPath = join(configRoot, '.symlink-allowlist');
  if (!existsSync(allowlistPath)) return { entries: new Set(), missing: true };
  const entries = new Set<string>();
  for (const raw of readFileSync(allowlistPath, 'utf8').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line) entries.add(line);
  }
  return { entries, missing: false };
}

// Resolve ~/.claude to its real path. The expected layout is ~/.claude →
// ~/claude-config, but defensive callers can pass any directory as override
// (kept simple — no env-var support until someone asks).
function resolveClaudeConfigRoot(): string | null {
  const candidate = join(homedir(), '.claude');
  if (!existsSync(candidate)) return null;
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

export async function doctor(_args: Record<string, string | undefined>, opts: OutputOpts) {
  const report: DoctorReport = {
    ok: true,
    baseUrl: baseUrl(),
    api: { reachable: false },
    cli: { version: pkgVersion(), path: process.argv[1] ?? '?' },
    hooks: {
      writeGuard: existsSync(join(homedir(), '.claude/hooks/vault-write-guard.sh')),
      bashGuard: existsSync(join(homedir(), '.claude/hooks/vault-write-guard-bash.sh')),
      soulCliGuard: existsSync(join(homedir(), '.claude/hooks/soul-cli-guard.sh')),
      vaultWriteSkill: existsSync(join(homedir(), '.claude/skills/vault-write/SKILL.md')),
    },
    claudeConfig: { probed: false, reason: 'not probed' },
    catalogIndex: { probed: false, reason: 'not probed' },
    inbox: { probed: false, reason: 'not probed' },
    notes: [],
  };

  // Claude-config dead-symlink scan — out-of-band counterpart to the
  // ~/claude-config pre-push gate (.githooks/pre-push). Catches dead
  // links between commits so you don't only discover them on push.
  // Note-only: never flips report.ok (the pre-push gate is enforcement).
  const configRoot = resolveClaudeConfigRoot();
  if (configRoot === null) {
    report.claudeConfig = { probed: false, reason: '~/.claude not found' };
  } else {
    const { entries: allowlist, missing: allowlistMissing } = loadSymlinkAllowlist(configRoot);
    const allDead: Array<{ path: string; target: string }> = [];
    walkForDeadSymlinks(configRoot, configRoot, allDead);
    const unexpectedDead: typeof allDead = [];
    let allowlistedDead = 0;
    for (const d of allDead) {
      if (allowlist.has(d.path)) allowlistedDead++;
      else unexpectedDead.push(d);
    }
    report.claudeConfig = { configRoot, unexpectedDead, allowlistedDead, allowlistMissing };
    if (allowlistMissing && allDead.length > 0) {
      report.notes.push(
        `claude-config: .symlink-allowlist missing (${allDead.length} dead symlink(s) will all surface as unexpected on next push).`,
      );
    }
    for (const d of unexpectedDead) {
      report.notes.push(`claude-config: dead symlink ${d.path} → ${d.target} (target missing).`);
    }
  }

  try {
    await apiGet('/api/system/health');
    report.api = { reachable: true, status: 'ok' };
  } catch (err) {
    report.api = {
      reachable: false,
      status: err instanceof ApiError ? err.status : 'network-error',
    };
    report.ok = false;
    report.notes.push(`API unreachable at ${baseUrl()} — start soul-hub (\`pnpm prod:start\` or \`npm run dev\`).`);
  }

  // ADR-027 P2.2 — catalog-index freshness. Only probe if API is reachable;
  // the freshness endpoint reads disk state inside the soul-hub repo, which
  // the CLI can't reach without the API. A 5xx here is non-fatal — surfaces
  // as a note, doesn't flip overall ok.
  if (report.api.reachable) {
    try {
      const freshness = (await apiGet('/api/components/index/freshness')) as CatalogIndexFreshness;
      report.catalogIndex = freshness;
      if (!freshness.exists) {
        report.notes.push(
          'catalog-index.json missing — fetch `GET /api/components/index` once to materialise it.',
        );
      } else if (!freshness.fresh) {
        const age = freshness.ageSeconds !== null ? `${Math.abs(freshness.ageSeconds)}s behind` : 'stale';
        const source = freshness.newestSource ?? 'a catalog source';
        report.notes.push(
          `catalog-index stale (${age} vs ${source}) — fetch \`GET /api/components/index\` or re-publish the changed component/recipe.`,
        );
      }
    } catch (err) {
      report.catalogIndex = {
        probed: false,
        reason: err instanceof ApiError ? `api ${err.status}` : 'network-error',
      };
    }
  }

  // ADR-005 — inbox sync-staleness. Same reachable-gate + non-fatal-note
  // pattern as catalog-index above: a stale account is a note, not a failure,
  // and a failed fetch surfaces as a note too (doesn't flip overall ok).
  if (report.api.reachable) {
    try {
      const data = (await apiGet('/api/inbox/accounts')) as { accounts: Array<{ id: string; email?: string; label?: string; status?: string; lastSync?: number | null }> };
      const now = Date.now();
      const accts: InboxAccountHealth[] = data.accounts.map((a) => {
        const lastSync = a.lastSync ?? null;
        const ageMs = lastSync ? now - lastSync : null;
        const stale = a.status === 'connected' && ageMs !== null && ageMs > INBOX_STALE_THRESHOLD_MS;
        return { id: a.id, email: a.email ?? a.label ?? a.id, status: a.status ?? '?', lastSync, ageMs, stale };
      });
      const stale_count = accts.filter((x) => x.stale).length;
      report.inbox = { accounts: accts, stale_count };
      for (const a of accts) {
        if (a.stale) report.notes.push(`inbox: ${a.email} connected but last sync ${ageShort(a.lastSync)} (stale)`);
      }
    } catch (err) {
      report.inbox = {
        probed: false,
        reason: err instanceof ApiError ? `api ${err.status}` : 'network-error',
      };
    }
  }

  if (!report.hooks.writeGuard || !report.hooks.bashGuard) {
    report.notes.push('Vault write-guard hook(s) missing — run `bash scripts/install-chokepoint.sh` from soul-hub.');
  }
  if (!report.hooks.soulCliGuard) {
    report.notes.push('soul-cli-guard hook missing (ADR-003 Phase 3b) — run `bash scripts/install-chokepoint.sh`. Mode controlled by SOUL_CLI_GUARD_MODE env (warn|block|off, default warn).');
  }
  if (!report.hooks.vaultWriteSkill) {
    report.notes.push('/vault-write skill missing — run `bash scripts/install-chokepoint.sh`.');
  }
  if (!report.api.reachable || !report.hooks.writeGuard) report.ok = false;

  emit(report, opts, (r: DoctorReport) => {
    const lines: string[] = [];
    lines.push(`soul ${r.cli.version}  ${r.cli.path}`);
    lines.push(`Base: ${r.baseUrl}`);
    lines.push(`API:  ${r.api.reachable ? '✓ reachable' : `✗ ${r.api.status}`}`);
    lines.push(`Hooks:`);
    lines.push(`  vault-write-guard.sh       ${r.hooks.writeGuard ? '✓' : '✗'}`);
    lines.push(`  vault-write-guard-bash.sh  ${r.hooks.bashGuard ? '✓' : '✗'}`);
    lines.push(`  soul-cli-guard.sh          ${r.hooks.soulCliGuard ? '✓' : '✗'}  (mode: ${process.env.SOUL_CLI_GUARD_MODE ?? 'warn'})`);
    lines.push(`  /vault-write skill         ${r.hooks.vaultWriteSkill ? '✓' : '✗'}`);
    lines.push(`Claude-config:`);
    if ('probed' in r.claudeConfig && r.claudeConfig.probed === false) {
      lines.push(`  symlink integrity          —  (${r.claudeConfig.reason})`);
    } else {
      const cc = r.claudeConfig as ClaudeConfigHealth;
      const allowNote = cc.allowlistMissing ? ', no allowlist' : `, ${cc.allowlistedDead} allowlisted`;
      if (cc.unexpectedDead.length === 0) {
        lines.push(`  symlink integrity          ✓  (${cc.configRoot}${allowNote})`);
      } else {
        lines.push(`  symlink integrity          ⚠  ${cc.unexpectedDead.length} unexpected dead link(s)${allowNote}`);
        for (const d of cc.unexpectedDead.slice(0, 5)) {
          lines.push(`    ${d.path} → ${d.target}`);
        }
        if (cc.unexpectedDead.length > 5) {
          lines.push(`    … and ${cc.unexpectedDead.length - 5} more (see JSON / .symlink-allowlist).`);
        }
      }
    }
    lines.push(`Catalog-index:`);
    if ('probed' in r.catalogIndex && r.catalogIndex.probed === false) {
      lines.push(`  freshness                  ✗  (${r.catalogIndex.reason})`);
    } else {
      const ci = r.catalogIndex as CatalogIndexFreshness;
      if (!ci.exists) {
        lines.push(`  catalog-index.json         ✗  missing`);
      } else if (ci.fresh) {
        const ageStr = ci.ageSeconds !== null && ci.ageSeconds >= 0 ? `+${ci.ageSeconds}s ahead` : 'no sources';
        lines.push(`  catalog-index.json         ✓  fresh (${ageStr})`);
      } else {
        const ageStr = ci.ageSeconds !== null ? `${Math.abs(ci.ageSeconds)}s behind` : 'stale';
        lines.push(`  catalog-index.json         ⚠  stale (${ageStr})`);
        if (ci.newestSource) lines.push(`    newest source            ${ci.newestSource}`);
      }
    }
    lines.push(`Inbox:`);
    if ('probed' in r.inbox && r.inbox.probed === false) {
      lines.push(`  accounts                   ✗  (${r.inbox.reason})`);
    } else {
      const inb = r.inbox as InboxHealth;
      if (inb.accounts.length === 0) {
        lines.push(`  accounts                   —  (none configured)`);
      } else {
        for (const a of inb.accounts) {
          const mark = a.stale ? '⚠' : '✓';
          lines.push(`  ${(a.email ?? a.id).padEnd(27)}${mark}  ${a.status} (${ageShort(a.lastSync)})`);
        }
      }
    }
    if (r.notes.length > 0) {
      lines.push('');
      lines.push('Notes:');
      for (const n of r.notes) lines.push(`  - ${n}`);
    }
    lines.push('');
    lines.push(r.ok ? '✓ doctor: ok' : '✗ doctor: issues found');
    return lines.join('\n');
  });

  if (!report.ok) process.exit(1);
}
