#!/usr/bin/env node
/**
 * Soul Hub local redeployer (ADR-016 + ADR-017).
 *
 * Spawned DETACHED by POST /api/system/redeploy. Executes:
 *   rm -rf build.next → BUILD_OUT_DIR=build.next npm run build
 *     → [success] mv build build.prev, mv build.next build, rm -rf build.prev
 *     → [failure] rm -rf build.next (build/ untouched)
 *   → pm2 reload soul-hub --update-env  (success path only)
 *
 * Critical invariants:
 *   - Build FAIL → write status=failed, DO NOT reload. The live process
 *     survives so the operator can see the failure via the banner.
 *     build/ is left UNTOUCHED — still bootable if pm2 restarts (ADR-017).
 *   - Build SUCCESS → atomic swap (build.next → build), then
 *     write status=reloading → pm2 reload (kills this process tree's parent
 *     server; new server boots with BUILD_SHA == HEAD → deployPending:false
 *     → banner clears).
 *   - NEVER sets NODE_ENV=production before build — devDependencies must
 *     remain resolvable during the Vite build (v2.2.2 lesson).
 *
 * Status file: ~/.soul-hub/data/redeploy-status.json
 * Log file:    ~/.soul-hub/logs/redeploy.log (stdout/stderr via spawn fd)
 */

import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Paths ──────────────────────────────────────────────────────────────────

function soulHubHome() {
  const override = process.env.SOUL_HUB_HOME;
  if (override) {
    return override.startsWith('~')
      ? resolve(homedir(), override.slice(1).replace(/^\/+/, ''))
      : resolve(override);
  }
  return resolve(homedir(), '.soul-hub');
}

const DATA_DIR = resolve(soulHubHome(), 'data');
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

const STATUS_PATH = resolve(DATA_DIR, 'redeploy-status.json');
const STARTED_AT = new Date().toISOString();
const REPO_ROOT = process.cwd();
const PM2_BIN = resolve(REPO_ROOT, 'node_modules', '.bin', 'pm2');

// ── Build-dir paths for atomic swap (ADR-017) ──────────────────────────────
const BUILD_DIR      = resolve(REPO_ROOT, 'build');       // live build (never deleted before success)
const BUILD_NEXT_DIR = resolve(REPO_ROOT, 'build.next');  // new build lands here first
const BUILD_PREV_DIR = resolve(REPO_ROOT, 'build.prev');  // transient during swap, gone within ms

// ── Status helpers ─────────────────────────────────────────────────────────

/** Read existing status file fields (mainly fromSha set by the endpoint). */
function readExistingStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/** Write a status update, preserving fromSha/toSha from the endpoint's write. */
function writeStatus(state, extra = {}) {
  const existing = readExistingStatus();
  try {
    writeFileSync(
      STATUS_PATH,
      JSON.stringify({
        state,
        startedAt: existing.startedAt ?? STARTED_AT,
        updatedAt: new Date().toISOString(),
        fromSha: existing.fromSha,
        toSha: existing.toSha,
        ...extra,
      }, null, 2) + '\n',
      'utf-8',
    );
  } catch (e) {
    console.error('[redeploy] WARNING: could not write status file:', e.message);
  }
}

// ── Global error catcher ───────────────────────────────────────────────────
// Any uncaught exception (failing execSync at build time) records a `failed`
// status so the UI surfaces it instead of timing out.
process.on('uncaughtException', (err) => {
  const msg = String(err?.message ?? err);
  console.error('[redeploy] uncaughtException:', msg);
  writeStatus('failed', { error: msg, finishedAt: new Date().toISOString() });
  process.exit(1);
});

// ── Build + atomic swap (ADR-017) ─────────────────────────────────────────
//
// We NEVER delete build/ before the new build has proven itself. Instead:
//   1. Wipe build.next (any leftover from a prior aborted run).
//   2. Build into build.next via BUILD_OUT_DIR env var.
//   3a. SUCCESS → rename build→build.prev, rename build.next→build, rm build.prev.
//       Two renames on the same filesystem = effectively atomic.
//   3b. FAIL    → rm build.next; leave build/ untouched (still bootable).
//
// IMPORTANT: do NOT set NODE_ENV=production — devDependencies must remain
// resolvable during the Vite build (v2.2.2 lesson). PM2/ecosystem sets it.

writeStatus('building');
console.log('[redeploy] starting build… (output → build.next)');

// Step 1: clean any leftover from a prior aborted run.
rmSync(BUILD_NEXT_DIR, { recursive: true, force: true });

let buildFailed = false;
let buildError = '';

try {
  // Step 2: build into build.next.
  execSync('npm run build', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, BUILD_OUT_DIR: 'build.next' },
  });
  console.log('[redeploy] build succeeded — swapping build.next → build…');

  // Step 3a: atomic swap.
  // move build → build.prev (skip if build/ doesn't yet exist, e.g. first deploy)
  if (existsSync(BUILD_DIR)) {
    renameSync(BUILD_DIR, BUILD_PREV_DIR);
  }
  // move build.next → build  (this is the cut-over; nearly instantaneous)
  renameSync(BUILD_NEXT_DIR, BUILD_DIR);
  // clean up the prev snapshot — short-lived, only exists between the two renames
  rmSync(BUILD_PREV_DIR, { recursive: true, force: true });

  console.log('[redeploy] swap complete — build/ now contains the new artifacts.');
} catch (err) {
  buildFailed = true;
  buildError = String(err?.message ?? err);
  console.error('[redeploy] build FAILED:', buildError);

  // Step 3b: clean up the failed build.next; leave build/ untouched.
  rmSync(BUILD_NEXT_DIR, { recursive: true, force: true });
  console.error('[redeploy] build.next removed; build/ is unchanged and still bootable.');
}

if (buildFailed) {
  writeStatus('failed', { error: buildError, finishedAt: new Date().toISOString() });
  console.error('[redeploy] NOT reloading — live process survives to surface the failure.');
  console.error('[redeploy] See ~/.soul-hub/logs/redeploy.log for the full build output.');
  process.exit(1);
}

// ── Reload ─────────────────────────────────────────────────────────────────

writeStatus('reloading');
console.log('[redeploy] reloading pm2 process (soul-hub)…');

try {
  execFileSync(PM2_BIN, ['reload', 'soul-hub', '--update-env'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  // pm2 reload is graceful — the old process is killed and a new one starts.
  // If we reach here, the reload completed (edge case: pm2 app was offline).
  writeStatus('done', { finishedAt: new Date().toISOString() });
  console.log('[redeploy] done — new process is up with the rebuilt artifacts.');
} catch (err) {
  const msg = String(err?.message ?? err);
  writeStatus('failed', { error: `pm2 reload failed: ${msg}`, finishedAt: new Date().toISOString() });
  console.error('[redeploy] pm2 reload FAILED:', msg);
  process.exit(1);
}
