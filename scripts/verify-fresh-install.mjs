#!/usr/bin/env node
// Soul Hub fresh-install verifier. Read-only.
//
// Run AFTER `npm run setup` to confirm a clean machine is wired correctly:
//   - ~/.soul-hub/ home, data dir, settings.json, secret
//   - ~/.claude/ vault chokepoint (CLAUDE.md block, rules, hooks, settings, skill)
//   - the `soul` CLI symlink
//   - DB migration state (each SQLite DB self-migrates on first feature use)
//
// Pass --probe to also smoke-test a server already running on :2400 (hits
// /api/system/version + /api/system/health). It never starts a server and
// never writes anything.
//
//   node scripts/verify-fresh-install.mjs            # static checks
//   node scripts/verify-fresh-install.mjs --probe    # + live :2400 smoke

import { existsSync, readFileSync, lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const blue = (s) => c('34', s);

const HOME = homedir();
const SOUL_HUB_HOME = process.env.SOUL_HUB_HOME
  ? resolve(process.env.SOUL_HUB_HOME.replace(/^~/, HOME))
  : join(HOME, '.soul-hub');
const CLAUDE_HOME = join(HOME, '.claude');
const DATA_DIR = join(SOUL_HUB_HOME, 'data');
const PROBE = process.argv.includes('--probe');
const PORT = process.env.SOUL_HUB_PORT || '2400';

let pass = 0, warn = 0, fail = 0;
const section = (s) => console.log(`\n${blue(bold('▸ ' + s))}`);
const ok = (label, detail) => { pass++; console.log(`  ${green('✓')} ${label}${detail ? dim('  ' + detail) : ''}`); };
const wa = (label, detail) => { warn++; console.log(`  ${yellow('!')} ${label}${detail ? dim('  ' + detail) : ''}`); };
const no = (label, detail) => { fail++; console.log(`  ${red('✗')} ${label}${detail ? dim('  ' + detail) : ''}`); };
const info = (label, detail) => console.log(`  ${dim('·')} ${label}${detail ? dim('  ' + detail) : ''}`);

function exists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}
function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

console.log(bold('Soul Hub fresh-install verifier'));
console.log(dim(`home: ${SOUL_HUB_HOME}   claude: ${CLAUDE_HOME}   probe: ${PROBE ? 'on' : 'off'}`));

// ── 1. ~/.soul-hub structure ──────────────────────────────────────
section('~/.soul-hub state');
exists(SOUL_HUB_HOME) ? ok('home dir', SOUL_HUB_HOME) : no('home dir missing', 'run: npm run setup');
exists(DATA_DIR) ? ok('data dir', DATA_DIR) : no('data dir missing', `${DATA_DIR}`);

const settingsPath = join(SOUL_HUB_HOME, 'settings.json');
if (!exists(settingsPath)) {
  no('settings.json missing', settingsPath);
} else {
  const s = readJson(settingsPath);
  if (!s) no('settings.json is not valid JSON', settingsPath);
  else {
    ok('settings.json valid', `port ${s.server?.port ?? '(default 2400)'}`);
    const f = s.features;
    if (f) info('features', `naseej=${f.naseej} workspaces=${f.workspaces} playbook=${f.playbook}`);
    else info('features', 'no override → all default true (operator instance)');
  }
}

const envPath = join(SOUL_HUB_HOME, '.env');
if (!exists(envPath)) {
  wa('.env missing', 'SOUL_HUB_SECRET will be absent — re-run setup');
} else {
  const env = readFileSync(envPath, 'utf8');
  /^SOUL_HUB_SECRET=.+/m.test(env)
    ? ok('SOUL_HUB_SECRET set', dim('(value not shown)'))
    : wa('SOUL_HUB_SECRET not set', 'inbox/session features need it');
}

// ── 2. ~/.claude vault chokepoint wiring ──────────────────────────
section('~/.claude vault chokepoint (ADR-046)');
const claudeMd = join(CLAUDE_HOME, 'CLAUDE.md');
if (exists(claudeMd) && readFileSync(claudeMd, 'utf8').includes('<!-- soul-hub:start -->'))
  ok('CLAUDE.md soul-hub block present');
else wa('CLAUDE.md soul-hub block missing', 'vault read-context not wired');

exists(join(CLAUDE_HOME, 'rules', 'vault.md'))
  ? ok('rules/vault.md present')
  : wa('rules/vault.md missing', 'write-side vault discipline not seeded');

for (const h of ['vault-write-guard.sh', 'vault-write-guard-bash.sh', 'soul-cli-guard.sh']) {
  const p = join(CLAUDE_HOME, 'hooks', h);
  if (!exists(p)) { no(`hook ${h} missing`, 'chokepoint NOT enforced — run install-chokepoint.sh'); continue; }
  const link = lstatSync(p).isSymbolicLink();
  ok(`hook ${h}`, link ? 'symlinked' : 'copied');
}

const claudeSettings = join(CLAUDE_HOME, 'settings.json');
const cs = readJson(claudeSettings);
const pre = cs?.hooks?.PreToolUse ?? [];
const registered = pre.some((e) => (e.hooks ?? []).some((h) => (h.command ?? '').includes('vault-write-guard')));
if (!exists(claudeSettings)) no('~/.claude/settings.json missing', 'hooks not registered');
else if (registered) ok('PreToolUse hook registered', `${pre.length} matcher(s)`);
else no('vault-write-guard not registered in settings.json', 'hooks present but inert');

exists(join(CLAUDE_HOME, 'skills', 'vault-write', 'SKILL.md'))
  ? ok('/vault-write skill installed')
  : wa('/vault-write skill missing', 'agent vault writes will be blocked with no path through');

// ── 3. soul CLI ───────────────────────────────────────────────────
section('soul CLI');
const soulBin = join(HOME, '.local', 'bin', 'soul');
if (exists(soulBin)) ok('~/.local/bin/soul', lstatSync(soulBin).isSymbolicLink() ? 'symlinked' : 'copied');
else wa('soul CLI not installed', 'run: bash install/cli/install.sh --symlink');

// ── 4. DB migration state ─────────────────────────────────────────
// Each DB self-migrates on first feature use (lazy singleton + user_version).
// This check is passive: absent = "pending until you use the feature".
section('DB migrations (self-migrating on first use)');
let Database = null;
try { ({ default: Database } = await import('better-sqlite3')); }
catch { wa('better-sqlite3 not loadable', 'run npm install / npm rebuild — skipping DB checks'); }

function checkDb(path, label, feature, expectVersioned) {
  if (!exists(path)) { info(`${label}`, `pending — created on first use (${feature})`); return; }
  if (!Database) return;
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const ver = db.pragma('user_version', { simple: true });
    const tables = db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n;
    if (expectVersioned) {
      ver > 0
        ? ok(`${label}`, `migrated at user_version=${ver}, ${tables} tables`)
        : wa(`${label}`, `user_version=0 but file exists — migration may not have run`);
    } else {
      tables > 0 ? ok(`${label}`, `${tables} tables`) : wa(`${label}`, 'file exists but no tables');
    }
  } catch (e) {
    no(`${label} unreadable`, e.message);
  } finally {
    db?.close();
  }
}

checkDb(join(DATA_DIR, 'inbox.db'), 'inbox.db', 'open /inbox', true);
checkDb(join(DATA_DIR, 'crm.db'), 'crm.db', 'open /crm or a CRM chat command', true);
checkDb(join(DATA_DIR, 'fetch_page.db'), 'fetch_page.db', 'fetch a URL via chat', true);

// WhatsApp heartbeat lives in a per-account subdir.
const waDir = join(DATA_DIR, 'whatsapp');
if (exists(waDir)) {
  let found = false;
  for (const acct of readdirSync(waDir)) {
    const hb = join(waDir, acct, 'heartbeat.db');
    if (exists(hb)) { found = true; checkDb(hb, `whatsapp/${acct}/heartbeat.db`, 'link WhatsApp + send a message', true); }
  }
  if (!found) info('whatsapp heartbeat', 'pending — created on first WhatsApp activity');
} else {
  info('whatsapp heartbeat', 'pending — created on first WhatsApp activity');
}

// ── 5. Optional live :2400 probe ──────────────────────────────────
if (PROBE) {
  section(`live server probe (:${PORT})`);
  const base = `http://localhost:${PORT}`;
  async function hit(path) {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(4000) });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) { return { error: e.message }; }
  }
  const ver = await hit('/api/system/version');
  if (ver.error) no('GET /api/system/version', `${ver.error} — is the server running? (npm run dev / prod:start)`);
  else if (ver.status === 200 && ver.body?.version) ok('GET /api/system/version', `${ver.body.name} v${ver.body.version}`);
  else no('GET /api/system/version', `HTTP ${ver.status}`);

  const health = await hit('/api/system/health');
  if (health.error) wa('GET /api/system/health', health.error);
  else if (health.status === 200 || health.status === 503) ok('GET /api/system/health', `HTTP ${health.status}`);
  else wa('GET /api/system/health', `HTTP ${health.status}`);
} else {
  info('live probe skipped', 'pass --probe with the server running to smoke-test :2400');
}

// ── Summary ───────────────────────────────────────────────────────
console.log(`\n${bold('Summary')}  ${green(pass + ' ok')}  ${yellow(warn + ' warn')}  ${red(fail + ' fail')}`);
if (fail > 0) {
  console.log(red('\nFresh-install verification FAILED — address the ✗ items above.'));
  process.exit(1);
}
console.log(green('\nFresh-install verification passed.') + dim(' (warnings are non-blocking — features not yet exercised.)'));
