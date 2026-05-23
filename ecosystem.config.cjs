const { resolve } = require('path');
const { homedir } = require('os');
const fs = require('fs');

const SOUL_HUB_HOME = process.env.SOUL_HUB_HOME || resolve(homedir(), '.soul-hub');
const LOG_DIR = resolve(SOUL_HUB_HOME, 'logs');
const SECRETS_FILE = resolve(SOUL_HUB_HOME, '.env');

// Pin the Node interpreter to the version in .nvmrc (currently v24).
// Without this, PM2's daemon falls back to PATH resolution and may pick
// /opt/homebrew/bin/node (Homebrew's Node) instead of nvm's, which causes
// native-addon ABI mismatches against better-sqlite3 — symptom:
// "NODE_MODULE_VERSION N. This version of Node.js requires NODE_MODULE_VERSION M."
// Override via PM2_NODE_BIN if your install lives elsewhere.
function resolveNvmNodeBin() {
  let want;
  try { want = fs.readFileSync(resolve(__dirname, '.nvmrc'), 'utf8').trim(); }
  catch { return null; }
  if (!want) return null;
  const nvmDir = resolve(homedir(), '.nvm/versions/node');
  if (!fs.existsSync(nvmDir)) return null;
  // Exact match first ("v24.14.0"), then major-prefix match ("24" → highest v24.*).
  const candidates = fs.readdirSync(nvmDir).filter(d => d.startsWith('v'));
  const exact = `v${want.replace(/^v/, '')}`;
  const ranked = candidates
    .filter(v => v === exact || v.startsWith(`v${want.replace(/^v/, '')}.`))
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number);
      const pb = b.slice(1).split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
  if (!ranked.length) return null;
  const bin = resolve(nvmDir, ranked[0], 'bin/node');
  return fs.existsSync(bin) ? bin : null;
}
const PINNED_NODE = process.env.PM2_NODE_BIN || resolveNvmNodeBin() || 'node';

module.exports = {
  apps: [
    {
      name: 'soul-hub',
      script: './server.js',
      interpreter: PINNED_NODE,
      // PM2 reads ~/.soul-hub/.env at start so child processes (Claude CLI,
      // pipeline blocks) inherit the same secrets the app writes via the
      // settings UI. The app itself ALSO loads them via src/lib/secrets.ts,
      // so values written after launch take effect without a restart for
      // Soul Hub itself; restart is only needed when external children must
      // see new keys.
      env_file: SECRETS_FILE,
      env: {
        PORT: 2400,
        NODE_ENV: 'production',
        // Pin the Claude CLI — scheduled jobs (peer-brief, etc.) spawn `claude`,
        // which auto-updates on launch by default. A silent 2.1.145→2.1.146 update
        // on 2026-05-21 changed `--allowedTools Write()` permission behavior and
        // broke peer-brief-daily (see knowledge/debugging/2026-05-21-claude-cli-2146-...).
        // Disabling the auto-updater under the scheduler stops that recurring; bump
        // the CLI deliberately + re-test the headless-write smoke after. Takes effect
        // on `pm2 restart` (env change — not picked up by a plain reload).
        DISABLE_AUTOUPDATER: '1',
        // ADR-009 Phase 8 (2026-05-07) — v1 dead code deleted. The
        // orchestrator is now v2-only; no env switch needed.
        // ADR-009 Phase 6 / decision-log 2026-05-06 — manual weekly rotation
        // for the 3-way A/B. Sticky-per-conversationKey would have pinned
        // the single user to one branch for the full 14 days, defeating
        // the test. Set to one of `glm-4.6` / `sonnet-4.6` / `minimax-m2`;
        // rotate weekly via:
        //   pm2 reload ecosystem.config.cjs --update-env
        // after editing this line. Telemetry rows already track the active
        // branch, so analytics queries remain valid across rotations.
        // Week 1 (2026-05-06 → 2026-05-13): glm-4.6 (cheapest; validates
        // cost projections first).
        ORCHESTRATOR_V2_BRANCH_OVERRIDE: 'glm-4.6',
        // SvelteKit Node adapter caps request bodies at 512KB by default.
        // Lift to 30MB so our 25MB-per-file upload cap (in /api/files) works
        // through the browser; multipart overhead needs the extra headroom.
        BODY_SIZE_LIMIT: '30000000',
        // SOUL_HUB_PUBLIC_URL is sourced exclusively from ~/.soul-hub/.env
        // (loaded by src/lib/secrets.ts at boot — ADR-055). Not injected here:
        // a fresh clone defaults to http://localhost:2400 in code; self-hosters
        // set their domain in ~/.soul-hub/.env. No trailing slash.
        // Pipeline env vars — inherited from shell as a fallback when env_file
        // doesn't carry them yet (during migration). Once a key is in
        // ~/.soul-hub/.env, the env_file value wins.
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || '',
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
        APIDIRECT_API_KEY: process.env.APIDIRECT_API_KEY || '',
        YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || '',
      },
      // Restart policy.
      // Bumped 512M → 1024M → 1536M on 2026-05-10. The 1024M cap still
      // SIGKILL'd post-vault-save at 21:38, suggesting Node v8 was hitting
      // its default --max-old-space-size limit (~1.5GB on 64-bit) and
      // dying internally before we could capture the peak. Diagnostic
      // bump to 1536M + NODE_OPTIONS=--max-old-space-size=1536 (set in
      // env block below) lets V8 actually use the full headroom and lets
      // the in-process memory log capture the real peak.
      max_memory_restart: '1536M',
      node_args: '--max-old-space-size=1536',
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '5s',
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 8000,
      shutdown_with_message: true,
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: resolve(LOG_DIR, 'error.log'),
      out_file: resolve(LOG_DIR, 'out.log'),
      merge_logs: true,
      // Don't watch files (we restart manually)
      watch: false,
    },
    {
      name: 'soul-hub-tunnel',
      script: 'cloudflared',
      args: 'tunnel run soul-hub',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
      exp_backoff_restart_delay: 1000,
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: resolve(LOG_DIR, 'tunnel-error.log'),
      out_file: resolve(LOG_DIR, 'tunnel-out.log'),
      merge_logs: true,
      watch: false,
    },
    {
      // WhatsApp gateway runs in its own PM2 app for crash isolation —
      // a Baileys WS / decryption blowup only takes down the worker,
      // PM2 restarts it, and the main soul-hub app stays serving.
      // Activated when channels.whatsapp.worker.enabled is true in
      // ~/.soul-hub/settings.json. Otherwise the worker comes up but
      // does nothing (the in-process adapter handles WhatsApp instead).
      // The TS source lives in scripts/whatsapp-worker.ts and is bundled
      // into build/whatsapp-worker.js by `npm run build`.
      name: 'soul-hub-whatsapp',
      script: 'build/whatsapp-worker.js',
      interpreter: PINNED_NODE,
      env_file: SECRETS_FILE,
      env: {
        NODE_ENV: 'production',
        SOUL_HUB_WHATSAPP_WORKER_PORT: '2401',
        SOUL_HUB_MAIN_APP_URL: 'http://127.0.0.1:2400',
        // Provider keys for voice transcription — main app loads the
        // same .env file so the values live in one place.
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      },
      // Steady state ~80–120MB; a leak should restart fast.
      max_memory_restart: '256M',
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '5s',
      kill_timeout: 8000,
      listen_timeout: 6000,
      shutdown_with_message: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: resolve(LOG_DIR, 'whatsapp-error.log'),
      out_file: resolve(LOG_DIR, 'whatsapp-out.log'),
      merge_logs: true,
      watch: false,
    },
  ],
};
