#!/usr/bin/env node
// Soul Hub health check. Cross-platform. Read-only.
// Run after bootstrap, or any time something feels off.

import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);

const checks = [];
const add = (label, status, detail) => checks.push({ label, status, detail });

const HOME = homedir();
const SOUL_HUB_HOME = process.env.SOUL_HUB_HOME
  ? resolve(process.env.SOUL_HUB_HOME.replace(/^~/, HOME))
  : join(HOME, '.soul-hub');

console.log(bold('Soul Hub doctor'));
console.log(dim(`platform: ${platform()}  home: ${SOUL_HUB_HOME}`));
console.log();

// ── 1. Node version ────────────────────────────────────────────
{
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 20) add('Node.js', 'ok', `v${process.versions.node}`);
  else add('Node.js', 'fail', `v${process.versions.node} — need 20+`);
}

// ── 2. node-pty loads ──────────────────────────────────────────
try {
  const { default: pty } = await import('node-pty');
  if (typeof pty.spawn !== 'function') throw new Error('spawn() missing');
  add('node-pty', 'ok', 'loads');
} catch (e) {
  add('node-pty', 'fail', e.message.split('\n')[0]);
}

// ── 3. better-sqlite3 loads ────────────────────────────────────
try {
  const Database = (await import('better-sqlite3')).default;
  const tmp = new Database(':memory:');
  tmp.exec('CREATE TABLE t (n INTEGER)');
  tmp.close();
  add('better-sqlite3', 'ok', 'opens in-memory db');
} catch (e) {
  add('better-sqlite3', 'fail', e.message.split('\n')[0]);
}

// ── 4. ~/.soul-hub writable ────────────────────────────────────
try {
  if (!existsSync(SOUL_HUB_HOME)) {
    add('~/.soul-hub', 'fail', `missing — run: bash scripts/bootstrap.sh`);
  } else {
    accessSync(SOUL_HUB_HOME, constants.W_OK);
    add('~/.soul-hub', 'ok', SOUL_HUB_HOME);
  }
} catch {
  add('~/.soul-hub', 'fail', `not writable: ${SOUL_HUB_HOME}`);
}

// ── 5. settings.json ───────────────────────────────────────────
const SETTINGS = join(SOUL_HUB_HOME, 'settings.json');
let settings = null;
try {
  if (!existsSync(SETTINGS)) {
    add('settings.json', 'fail', `missing at ${SETTINGS}`);
  } else {
    settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    add('settings.json', 'ok', SETTINGS);
  }
} catch (e) {
  add('settings.json', 'fail', `invalid JSON: ${e.message}`);
}

// ── 6. SOUL_HUB_SECRET ─────────────────────────────────────────
{
  const envFile = join(SOUL_HUB_HOME, '.env');
  let hasSecret = false;
  if (process.env.SOUL_HUB_SECRET) hasSecret = true;
  else if (existsSync(envFile)) {
    hasSecret = readFileSync(envFile, 'utf8').split(/\r?\n/).some((l) => /^SOUL_HUB_SECRET=.+/.test(l));
  }
  if (hasSecret) add('SOUL_HUB_SECRET', 'ok', 'present');
  else add('SOUL_HUB_SECRET', 'warn', 'unset — required for Unified Inbox only');
}

// ── 6b. SOUL_HUB_PUBLIC_URL (ADR-055) ──────────────────────────
{
  const envFile = join(SOUL_HUB_HOME, '.env');
  let hasPublicUrl = !!process.env.SOUL_HUB_PUBLIC_URL;
  if (!hasPublicUrl && existsSync(envFile)) {
    hasPublicUrl = readFileSync(envFile, 'utf8').split(/\r?\n/).some((l) => /^SOUL_HUB_PUBLIC_URL=.+/.test(l));
  }
  if (hasPublicUrl) add('SOUL_HUB_PUBLIC_URL', 'ok', 'set');
  else add('SOUL_HUB_PUBLIC_URL', 'warn', 'unset — deeplinks default to http://localhost:2400 (set in ~/.soul-hub/.env for remote access)');
}

// ── 7. Vault dir ──────────────────────────────────────────────
{
  const expand = (p) => (p?.startsWith('~/') ? join(HOME, p.slice(2)) : p);
  const vaultDir = expand(settings?.paths?.vaultDir) || join(HOME, 'vault');
  if (existsSync(vaultDir)) {
    try {
      accessSync(vaultDir, constants.W_OK);
      add('vault dir', 'ok', vaultDir);
    } catch {
      add('vault dir', 'fail', `not writable: ${vaultDir}`);
    }
  } else {
    add('vault dir', 'warn', `missing: ${vaultDir} — created on first vault access`);
  }
}

// ── 8. Claude CLI ──────────────────────────────────────────────
{
  const expand = (p) => (p?.startsWith('~/') ? join(HOME, p.slice(2)) : p);
  const configured = expand(settings?.paths?.claudeBinary);
  let resolved = null;

  if (configured && existsSync(configured)) resolved = configured;
  else {
    try {
      const probe = platform() === 'win32' ? 'where claude' : 'command -v claude';
      resolved = execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
    } catch {
      resolved = null;
    }
  }

  if (resolved) add('claude CLI', 'ok', resolved);
  else add('claude CLI', 'fail', 'not found — install + set paths.claudeBinary in settings.json');
}

// ── 9. ~/.claude/CLAUDE.md vault block ─────────────────────────
{
  const claudeMd = join(HOME, '.claude', 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    add('CLAUDE.md', 'warn', `missing — run: npm run setup`);
  } else {
    const txt = readFileSync(claudeMd, 'utf8');
    if (txt.includes('<!-- soul-hub:start -->') && txt.includes('<!-- soul-hub:end -->')) {
      add('CLAUDE.md', 'ok', 'soul-hub block present');
    } else {
      add('CLAUDE.md', 'warn', `no soul-hub block — run: npm run setup`);
    }
  }
}

// ── 10. Vault git history (ADR-019) ────────────────────────────
{
  const expand = (p) => (p?.startsWith('~/') ? join(HOME, p.slice(2)) : p);
  const vaultDir = expand(settings?.paths?.vaultDir) || join(HOME, 'vault');
  const gitDir = join(vaultDir, '.git');
  if (!existsSync(vaultDir)) {
    add('vault git', 'warn', 'vault dir missing — run: bash scripts/bootstrap.sh');
  } else if (!existsSync(gitDir)) {
    add('vault git', 'warn', `${gitDir} missing — run: bash scripts/bootstrap.sh (re-run is idempotent)`);
  } else {
    try {
      const sha = execSync(`git -C "${vaultDir}" rev-parse HEAD`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      add('vault git', 'ok', `HEAD ${sha.slice(0, 7)}`);
    } catch {
      add('vault git', 'warn', 'repo initialized but no commits — set git config user.{name,email} and re-run setup');
    }
  }
}

// ── 11. vault-backup-daily scheduler task (ADR-019) ────────────
{
  const tasks = settings?.scheduler?.tasks ?? [];
  const found = Array.isArray(tasks) && tasks.some((t) => t?.id === 'vault-backup-daily');
  if (found) add('vault-backup task', 'ok', 'scheduler task registered');
  else add('vault-backup task', 'warn', 'not in settings.json — re-run: bash scripts/bootstrap.sh, or copy from settings.example.json');
}

// ── 11.5 soul-hub-backup-daily scheduler task ──────────────────
// Sibling of #11: pushes committed-but-unpushed main commits to
// origin nightly. Push-only (no auto-stage) since soul-hub is
// operator-driven, unlike vault's event-driven commit pattern.
{
  const tasks = settings?.scheduler?.tasks ?? [];
  const found = Array.isArray(tasks) && tasks.some((t) => t?.id === 'soul-hub-backup-daily');
  if (found) add('soul-hub-backup task', 'ok', 'scheduler task registered');
  else add('soul-hub-backup task', 'warn', 'not in settings.json — copy soul-hub-backup-daily entry from settings.example.json');
}

// ── 12. TikTok transcription deps (ADR-024) ──────────────────
{
  const tiktokEnabled = settings?.channels?.whatsapp?.tiktok?.enabled ?? true;
  if (!tiktokEnabled) {
    add('tiktok-fetch deps', 'ok', 'tool disabled in settings');
  } else {
    const hasBin = (cmd) => {
      try {
        execSync(`command -v ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'], shell: '/bin/bash' });
        return true;
      } catch {
        return false;
      }
    };
    const hasYtDlp = hasBin('yt-dlp');
    const hasFfmpeg = hasBin('ffmpeg');
    const hasWhisperCli = hasBin('whisper-cli');
    let hasCurlCffi = false;
    try {
      execSync('python3 -c "import curl_cffi"', { stdio: 'ignore' });
      hasCurlCffi = true;
    } catch {
      hasCurlCffi = false;
    }
    const modelDir = process.env.WHISPER_MODEL_BASE_DIR
      ? process.env.WHISPER_MODEL_BASE_DIR.replace(/^~/, HOME)
      : join(HOME, '.cache', 'whisper-cpp');
    const hasModel = existsSync(join(modelDir, 'ggml-base.bin'));

    const missing = [];
    if (!hasYtDlp) missing.push('yt-dlp');
    if (!hasFfmpeg) missing.push('ffmpeg');
    if (!hasWhisperCli) missing.push('whisper-cli');
    if (!hasModel) missing.push('ggml-base.bin');

    if (missing.length === 0) {
      const detail = `yt-dlp + ffmpeg + whisper-cli + model${hasCurlCffi ? ' + curl_cffi' : ' (curl_cffi missing — fragile)'}`;
      add('tiktok-fetch deps', 'ok', detail);
    } else {
      add(
        'tiktok-fetch deps',
        'warn',
        `missing: ${missing.join(', ')} — run: bash scripts/install-tiktok-deps.sh`,
      );
    }
  }
}

// ── 13. Node ABI parity between shell and running PM2 process ─
// Native modules (better-sqlite3, node-pty) compile against ONE
// Node major. If the shell's Node differs from PM2's Node, the
// next `npm rebuild` will fix one and silently break the other.
// Catch the drift before it causes a runtime 500.
{
  try {
    const pmPid = execSync('pgrep -f "node.*soul-hub/server.js" 2>/dev/null | head -1', {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/bash',
    })
      .toString()
      .trim();
    if (!pmPid) {
      add('Node ABI parity', 'warn', 'soul-hub not running — no PM2 process to compare against');
    } else {
      const pmNodeBin = execSync(
        `lsof -p ${pmPid} 2>/dev/null | awk '$NF ~ /node$/ && $4=="txt" {print $NF; exit}'`,
        { stdio: ['ignore', 'pipe', 'ignore'], shell: '/bin/bash' },
      )
        .toString()
        .trim();
      if (!pmNodeBin) {
        add('Node ABI parity', 'warn', 'unable to detect PM2 Node binary via lsof');
      } else {
        const pmVersion = execSync(`"${pmNodeBin}" -v`, {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        const shellVersion = `v${process.versions.node}`;
        const sameMajor = pmVersion.split('.')[0] === shellVersion.split('.')[0];
        if (sameMajor) {
          add('Node ABI parity', 'ok', `shell ${shellVersion} + PM2 ${pmVersion} on same major`);
        } else {
          add(
            'Node ABI parity',
            'fail',
            `shell ${shellVersion} ≠ PM2 ${pmVersion} — DO NOT rebuild from this shell. See feedback_node_version_alignment.md`,
          );
        }
      }
    }
  } catch {
    add('Node ABI parity', 'warn', 'parity check skipped (pgrep/lsof unavailable)');
  }
}

// ── 13b. macOS boot-time FD limit (node-pty posix_spawnp trap) ─
// node-pty opens a pty pair + spawn-helper per terminal session. A PM2 daemon
// launched at boot inherits launchd's default 256-FD soft limit and eventually
// fails posix_spawn with the opaque "posix_spawnp failed." (in-app Terminal →
// 422). Interactive-shell starts inherit ~1M so they don't hit it — which is
// why the failure only shows up after a reboot. `start_prod.sh startup` injects
// SoftResourceLimits into the pm2 plist to escape this; warn if that's missing.
if (platform() === 'darwin') {
  try {
    const raw = execSync('launchctl limit maxfiles', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    // e.g. "\tmaxfiles    256            unlimited"
    const m = raw.match(/maxfiles\s+(\d+)/);
    const soft = m ? parseInt(m[1], 10) : null;

    // Find a pm2 boot plist (LaunchAgent = user, LaunchDaemon = system).
    let plist = null;
    let patched = false;
    const globDirs = [
      join(HOME, 'Library', 'LaunchAgents'),
      '/Library/LaunchDaemons',
    ];
    for (const dir of globDirs) {
      try {
        const hit = execSync(`ls ${dir}/pm2.*.plist 2>/dev/null | head -1`, {
          stdio: ['ignore', 'pipe', 'ignore'],
          shell: '/bin/bash',
        }).toString().trim();
        if (hit) { plist = hit; break; }
      } catch { /* none */ }
    }
    if (plist) {
      try {
        patched = readFileSync(plist, 'utf8').includes('SoftResourceLimits');
      } catch { /* unreadable */ }
    }

    if (!plist) {
      add('macOS FD limit', 'ok', `launchctl soft=${soft ?? '?'}; no PM2 boot persistence (shell starts inherit a high limit)`);
    } else if (patched) {
      add('macOS FD limit', 'ok', 'PM2 boot plist carries SoftResourceLimits');
    } else if (soft !== null && soft <= 1024) {
      add(
        'macOS FD limit',
        'warn',
        `PM2 boots with launchd soft=${soft} — node-pty Terminal will fail after reboot. Run: bash scripts/start_prod.sh startup`,
      );
    } else {
      add('macOS FD limit', 'ok', `launchctl soft=${soft}`);
    }
  } catch {
    add('macOS FD limit', 'warn', 'unable to read launchctl limit maxfiles');
  }
}

// ── 14. Vault chokepoint (ADR-046 / 048 / 050) ────────────────
// Verifies the four out-of-repo artifacts are deployed. L3 + L5 are
// code-resident and don't have a doctor check (they're either present
// because the soul-hub binary exists, or they aren't).
{
  const CLAUDE_HOME = process.env.CLAUDE_HOME
    ? resolve(process.env.CLAUDE_HOME.replace(/^~/, HOME))
    : join(HOME, '.claude');
  const VAULT_DIR = process.env.VAULT_DIR
    ? resolve(process.env.VAULT_DIR.replace(/^~/, HOME))
    : join(HOME, 'vault');
  const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
  const INSTALL_DIR = join(REPO_ROOT, 'install');

  // L1 + L2 hooks deployed
  for (const name of ['vault-write-guard.sh', 'vault-write-guard-bash.sh']) {
    const target = join(CLAUDE_HOME, 'hooks', name);
    if (!existsSync(target)) {
      add(`chokepoint/${name}`, 'fail', 'missing — run: bash scripts/install-chokepoint.sh');
    } else {
      try { accessSync(target, constants.X_OK); }
      catch { add(`chokepoint/${name}`, 'fail', 'not executable'); continue; }
      add(`chokepoint/${name}`, 'ok', 'deployed');
    }
  }

  // settings.json has both PreToolUse entries
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  if (!existsSync(settingsPath)) {
    add('chokepoint/settings.json', 'fail', 'missing');
  } else {
    try {
      const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
      const hooks = s?.hooks?.PreToolUse ?? [];
      const allCommands = hooks.flatMap((h) => (h.hooks ?? []).map((x) => x.command ?? ''));
      const hasP1 = allCommands.some((c) => c.includes('vault-write-guard.sh'));
      const hasP2 = allCommands.some((c) => c.includes('vault-write-guard-bash.sh'));
      if (hasP1 && hasP2) add('chokepoint/settings.json', 'ok', 'both PreToolUse matchers registered');
      else add('chokepoint/settings.json', 'fail', `missing matchers — P1:${hasP1} P2:${hasP2}`);
    } catch (e) {
      add('chokepoint/settings.json', 'fail', `invalid JSON: ${e.message}`);
    }
  }

  // /vault-write skill deployed
  const skillSkill = join(CLAUDE_HOME, 'skills', 'vault-write', 'SKILL.md');
  if (!existsSync(skillSkill)) {
    add('chokepoint/vault-write skill', 'fail', 'missing — run: bash scripts/install-chokepoint.sh');
  } else {
    add('chokepoint/vault-write skill', 'ok', 'deployed');
  }

  // L4 vault pre-commit (only check if vault exists)
  if (existsSync(VAULT_DIR)) {
    const hookPath = join(VAULT_DIR, '.git', 'hooks', 'pre-commit');
    if (!existsSync(hookPath)) {
      add('chokepoint/L4 pre-commit', 'fail', 'missing — run ~/vault/.vault/hooks/install.sh');
    } else {
      add('chokepoint/L4 pre-commit', 'ok', 'installed');
    }
  } else {
    add('chokepoint/L4 pre-commit', 'warn', 'vault dir missing — skipped');
  }

  // Canonical sources present in repo
  const canonicals = [
    'hooks/vault-write-guard.sh',
    'hooks/vault-write-guard-bash.sh',
    'hooks/vault-pre-commit',
    'skills/vault-write/SKILL.md',
    'claude-settings.snippet.json',
  ];
  const missing = canonicals.filter((f) => !existsSync(join(INSTALL_DIR, f)));
  if (missing.length === 0) {
    add('chokepoint/install sources', 'ok', `${canonicals.length} canonicals present`);
  } else {
    add('chokepoint/install sources', 'fail', `missing in install/: ${missing.join(', ')}`);
  }
}

// ── 14b. Soul Hub CLI (ADR-001, soul-hub-cli) ─────────────────
// Phase 1 read CLI. Symlinked into ~/.local/bin/soul by
// install/cli/install.sh; the canonical source lives in cli/soul.
{
  const REPO_ROOT_CLI = resolve(new URL('..', import.meta.url).pathname);
  const cliSrc = join(REPO_ROOT_CLI, 'cli', 'soul');
  const cliBin = join(homedir(), '.local', 'bin', 'soul');

  if (!existsSync(cliSrc)) {
    add('soul-cli/source', 'fail', `missing canonical: ${cliSrc}`);
  } else {
    add('soul-cli/source', 'ok', 'cli/soul present');
  }

  if (!existsSync(cliBin)) {
    add('soul-cli/installed', 'fail', 'not installed — run: bash install/cli/install.sh');
  } else {
    try {
      accessSync(cliBin, constants.X_OK);
      // Try to invoke --version cheaply
      try {
        const ver = execSync(`"${cliBin}" --version`, { encoding: 'utf8', timeout: 5000 }).trim();
        add('soul-cli/installed', 'ok', ver);
      } catch (e) {
        add('soul-cli/installed', 'warn', `installed but --version failed: ${(e && e.message) || e}`);
      }
    } catch {
      add('soul-cli/installed', 'fail', `${cliBin} not executable`);
    }
  }
}

// ── 15. Platform sanity ────────────────────────────────────────
if (platform() === 'win32') {
  add('platform', 'fail', 'native Windows is unsupported. Use WSL2 (Ubuntu). See INSTALL.md.');
} else if (platform() === 'linux') {
  // Detect WSL — informational only
  try {
    const v = readFileSync('/proc/version', 'utf8');
    if (/microsoft/i.test(v)) add('platform', 'ok', 'Linux (WSL2)');
    else add('platform', 'ok', 'Linux');
  } catch {
    add('platform', 'ok', 'Linux');
  }
} else {
  add('platform', 'ok', platform());
}

// ── render ─────────────────────────────────────────────────────
const labelW = Math.max(...checks.map((c) => c.label.length));
let failed = 0;
let warned = 0;
for (const ch of checks) {
  const pad = ch.label.padEnd(labelW);
  const tag = ch.status === 'ok' ? green('  OK  ') : ch.status === 'warn' ? yellow(' WARN ') : red(' FAIL ');
  console.log(`  ${tag}  ${pad}  ${dim(ch.detail)}`);
  if (ch.status === 'fail') failed++;
  if (ch.status === 'warn') warned++;
}
console.log();
if (failed) {
  console.log(red(bold(`${failed} failed`)) + (warned ? `, ${yellow(`${warned} warning${warned > 1 ? 's' : ''}`)}` : ''));
  process.exit(1);
}
console.log(green(bold('All checks passed.')) + (warned ? `  (${yellow(`${warned} warning${warned > 1 ? 's' : ''}`)})` : ''));
