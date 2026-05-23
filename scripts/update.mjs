#!/usr/bin/env node
// Soul Hub updater. Pulls the latest release, installs, builds, and (only if a
// production process is already online) reloads it with zero downtime.
//
//   npm run update              # pull + install + build, reload if running
//   npm run update -- --no-reload   # never touch a running process
//
// Safe to run on a dev checkout (no PM2 process → it just pulls + builds).
// It NEVER starts a process that wasn't already running, so it can't surprise
// you with a server you didn't ask for.

import { execSync, spawnSync } from 'node:child_process';

const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const dim = (s) => c('2', s);

const noReload = process.argv.includes('--no-reload');

const step = (s) => console.log(`${bold('==>')} ${s}`);
const ok = (s) => console.log(`  ${green('✓')} ${s}`);
const warn = (s) => console.log(`  ${yellow('!')} ${s}`);

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

// ── 0. Refuse on a dirty tree — never clobber local changes ────────
const dirty = capture('git status --porcelain');
if (dirty) {
  console.error(red('\nWorking tree has uncommitted changes — refusing to pull.'));
  console.error(dim('Commit or stash them first, then re-run `npm run update`.'));
  process.exit(1);
}

const before = capture('git rev-parse --short HEAD');

// ── 1. Pull ────────────────────────────────────────────────────────
step('Pulling latest from origin');
run('git pull --ff-only');
const after = capture('git rev-parse --short HEAD');
if (before && before === after) {
  ok(`already up to date (${after})`);
} else {
  ok(`updated ${before} → ${after}`);
}

// ── 2. Install (honours .npmrc legacy-peer-deps) ────────────────────
step('Installing dependencies');
run('npm install');
ok('dependencies installed');

// ── 3. Build ────────────────────────────────────────────────────────
step('Building');
run('npm run build');
ok('build complete');

// ── 4. Reload only if a production process is already online ────────
if (noReload) {
  warn('--no-reload set — not touching any running process');
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
  run('npm run prod:reload');
  ok('soul-hub reloaded');
  console.log(`\n${green('Update complete and live.')}`);
} else {
  warn('no online `soul-hub` process found — skipping reload');
  console.log(`\n${green('Update complete.')} Start it with ${bold('npm run prod:start')} (production) or ${bold('npm run dev')}.`);
}
