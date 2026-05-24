#!/usr/bin/env node
// Soul Hub updater. Pulls the latest release, installs, builds, and (only if a
// production process is already online) reloads it with zero downtime.
//
//   npm run update              # pull + install + build, reload if running
//   npm run update -- --no-reload   # never touch a running process
//   node scripts/update.mjs --verify-remote https://github.com/jneaimi/soulhub
//                               # abort unless origin matches (used by the
//                               # ADR-011 one-click update endpoint)
//
// Safe to run on a dev checkout (no PM2 process → it just pulls + builds).
// It NEVER starts a process that wasn't already running, so it can't surprise
// you with a server you didn't ask for.

import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Update status signal (ADR-011) — the endpoint spawns this script detached,
// so the browser can't see stdout. Write each phase to a small JSON file the
// server surfaces via GET /api/system/version, so the UI shows live progress
// ("Pulling…/Building…/Reloading…") and an EXPLICIT failure reason instead of
// waiting out the 120s version-poll timeout. Honors SOUL_HUB_HOME. Best-effort:
// a write failure never derails the update.
function statusPath() {
  const envHome = process.env.SOUL_HUB_HOME;
  const home = envHome
    ? (envHome.startsWith('~') ? resolve(homedir(), envHome.slice(1).replace(/^\/+/, '')) : resolve(envHome))
    : resolve(homedir(), '.soul-hub');
  const dir = resolve(home, 'data');
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return resolve(dir, 'update-status.json');
}
const STATUS_PATH = statusPath();
const STARTED_AT = new Date().toISOString();
function writeStatus(phase, extra = {}) {
  try {
    writeFileSync(
      STATUS_PATH,
      JSON.stringify({ phase, startedAt: STARTED_AT, updatedAt: new Date().toISOString(), ...extra }, null, 2) + '\n',
      'utf-8',
    );
  } catch { /* best-effort — never derail the update on a status-write error */ }
}
// Any unhandled throw (a failing execSync at pull/install/build) records a
// `failed` status with the message, so the UI surfaces it instead of timing out.
process.on('uncaughtException', (err) => {
  writeStatus('failed', { error: String((err && err.message) || err) });
  console.error(red(String((err && err.stack) || err)));
  process.exit(1);
});

const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const dim = (s) => c('2', s);

const noReload = process.argv.includes('--no-reload');

// ADR-011 §2d — remote pin. When the one-click update endpoint spawns this
// script it passes `--verify-remote <url>`; the pull is then refused unless
// `origin` matches, so a hijacked local remote can't make the RCE path execute
// arbitrary code. Argument-driven (NOT hardcoded) so manual `npm run update`
// stays portable across the canonical repo (jneaimi/soul-hub) and forks.
function argValue(flag) {
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const verifyRemote = argValue('--verify-remote');

const step = (s) => console.log(`${bold('==>')} ${s}`);
const ok = (s) => console.log(`  ${green('✓')} ${s}`);
const warn = (s) => console.log(`  ${yellow('!')} ${s}`);

// Normalize a git remote URL for comparison: drop a trailing `.git`, a trailing
// slash, and case. `https://github.com/jneaimi/soulhub.git` == `…/soulhub`.
const normRemote = (u) => String(u || '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts });
}
function capture(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

console.log(bold('Soul Hub updater'));
writeStatus('started');

// ── 0. Refuse on a dirty tree — never clobber local changes ────────
// EXCEPT package-lock.json: a plain `npm install` rewrites its version field,
// so it drifts on essentially every install. That drift is safe to discard —
// the `npm install` step below regenerates it. Refuse only on REAL local edits;
// auto-discard lockfile-only drift so the one-click update isn't permanently
// blocked by a file the operator never touched. (Caught on a live install
// 2026-05-24.)
const dirty = capture('git status --porcelain');
if (dirty) {
  const lines = dirty.split('\n').filter(Boolean);
  const nonLock = lines.filter((l) => !l.endsWith('package-lock.json'));
  if (nonLock.length === 0) {
    warn('discarding package-lock.json drift (npm regenerates it)');
    run('git checkout -- package-lock.json');
  } else {
    console.error(red('\nWorking tree has uncommitted changes — refusing to pull.'));
    console.error(dim('Commit or stash them first, then re-run `npm run update`.'));
    console.error(dim(nonLock.join('\n')));
    writeStatus('aborted', { error: 'Uncommitted changes in the working tree', files: nonLock.map((l) => l.replace(/^\s*\S+\s+/, '')) });
    process.exit(1);
  }
}

// ── 0b. Remote pin (ADR-011 F4) — only when --verify-remote is passed ──
if (verifyRemote) {
  const origin = capture('git remote get-url origin');
  if (normRemote(origin) !== normRemote(verifyRemote)) {
    console.error(red('\nRemote pin check FAILED — refusing to pull.'));
    console.error(dim(`  expected origin: ${verifyRemote}`));
    console.error(dim(`  actual origin:   ${origin || '(none)'}`));
    console.error(dim('  A mismatched remote could execute arbitrary code under your account.'));
    writeStatus('aborted', { error: `Remote pin mismatch (expected ${verifyRemote}, got ${origin || 'none'})` });
    process.exit(2);
  }
  ok(`remote pin verified (origin → ${origin})`);
}

const before = capture('git rev-parse --short HEAD');

// ── 1. Pull ────────────────────────────────────────────────────────
step('Pulling latest from origin');
writeStatus('pulling');
run('git pull --ff-only');
const after = capture('git rev-parse --short HEAD');
if (before && before === after) {
  ok(`already up to date (${after})`);
} else {
  ok(`updated ${before} → ${after}`);
}

// ── 2. Install (honours .npmrc legacy-peer-deps) ────────────────────
// `--include=dev` is REQUIRED: the one-click update endpoint (ADR-011) spawns
// this script from the server process, which runs under NODE_ENV=production.
// Under that env `npm install` omits devDependencies — including vite and
// svelte-kit, which step 3's `npm run build` needs — so the build would fail
// with "vite: command not found". Forcing the dev group keeps the build able
// to run regardless of the inherited NODE_ENV. (Caught by live one-click test
// 2026-05-24.)
step('Installing dependencies (incl. dev — build needs vite/svelte-kit)');
writeStatus('installing', { version: after });
run('npm install --include=dev');
ok('dependencies installed');

// ── 3. Build ────────────────────────────────────────────────────────
step('Building');
writeStatus('building', { version: after });
run('npm run build');
ok('build complete');

// ── 3b. Re-sync the out-of-repo chokepoint artifacts (ADR-006 step 9 /
//        ADR-011 F3). install-chokepoint.sh re-copies the /vault-write skill +
//        hooks from THIS checkout into ~/.claude/, so the copied SKILL.md does
//        not go stale on a pull. Idempotent; non-fatal — a failed resync warns
//        but never blocks the update (the running server matters more). ───────
step('Re-syncing vault-write chokepoint (skill + hooks)');
writeStatus('resyncing', { version: after });
const resync = spawnSync('bash', ['scripts/install-chokepoint.sh', '--quiet'], { stdio: 'inherit' });
if (resync.status === 0) {
  ok('chokepoint re-synced to this checkout');
} else {
  warn(`chokepoint resync exited ${resync.status ?? 'null'} — vault-write skill may be stale; run scripts/install-chokepoint.sh manually`);
}

// ── 4. Reload only if a production process is already online ────────
if (noReload) {
  warn('--no-reload set — not touching any running process');
  writeStatus('done', { version: after, reloaded: false });
  console.log(`\n${green('Update complete.')} Run ${bold('npm run prod:reload')} to apply.`);
  process.exit(0);
}

const pm2List = spawnSync('npx', ['pm2', 'jlist'], { encoding: 'utf8' });
let online = false;
if (pm2List.status === 0) {
  try {
    const procs = JSON.parse(pm2List.stdout || '[]');
    online = procs.some((p) => p.name === 'soul-hub' && p?.pm2_env?.status === 'online');
  } catch {
    /* ignore parse errors — treat as not online */
  }
}

if (online) {
  step('Reloading running production process (zero-downtime)');
  writeStatus('reloading', { version: after });
  run('npm run prod:reload');
  ok('soul-hub reloaded');
  writeStatus('done', { version: after, reloaded: true });
  console.log(`\n${green('Update complete and live.')}`);
} else {
  warn('no online `soul-hub` process found — skipping reload');
  writeStatus('done', { version: after, reloaded: false });
  console.log(`\n${green('Update complete.')} Start it with ${bold('npm run prod:start')} (production) or ${bold('npm run dev')}.`);
}
