# Installation Guide

## Quick Start

For most users, the bootstrap script handles every setup step:

```bash
git clone https://github.com/jneaimi/soul-hub.git
cd soul-hub
npm run setup        # runs scripts/bootstrap.sh
npm run doctor       # verify everything is wired up
npm run dev          # http://localhost:5173
```

The bootstrap is **idempotent** — safe to re-run after pulling updates. It will not overwrite an existing `~/.soul-hub/settings.json` or `~/.soul-hub/.env`.

## Prerequisites

| Requirement | Version | Required | Install |
|------------|---------|----------|---------|
| **Node.js** | 20+ | Yes | [nodejs.org](https://nodejs.org/) or `brew install node` |
| **npm** | 10+ | Yes | Comes with Node.js |
| **Git** | 2.30+ | Yes | `brew install git` or `apt install git` |
| **Claude Code** | Latest | Yes | [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code) |
| **uv** | Latest | For Python pipelines | [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/) |
| **PM2** | 5+ | For production | Included as dev dependency |
| **yt-dlp + ffmpeg + whisper.cpp** | Latest | Optional — TikTok transcription (ADR-024) | `npm run setup -- --with-tiktok` or `bash scripts/install-tiktok-deps.sh` |

### Supported Platforms

- **macOS** (Intel + Apple Silicon) — runs natively
- **Linux** (Ubuntu 20.04+, Debian 11+, Fedora 38+) — runs natively
- **Windows 10/11** — runs inside **WSL2 (Ubuntu)**. See the [Windows section](#windows-via-wsl2) below.

## Platform Setup

### macOS

```bash
xcode-select --install                          # build tools (one-time)
git clone https://github.com/jneaimi/soul-hub.git
cd soul-hub
npm run setup
npm run dev
```

### Linux (Debian / Ubuntu)

```bash
sudo apt install -y build-essential python3 git curl
git clone https://github.com/jneaimi/soul-hub.git
cd soul-hub
npm run setup
npm run dev
```

For Fedora: `sudo dnf groupinstall "Development Tools" && sudo dnf install python3 git`.

### Windows (via WSL2)

Soul Hub spawns POSIX shells, native PTY sessions, and assumes a Unix filesystem. **Don't try to run it natively on Windows** — use WSL2 instead. From a Windows perspective it still feels like one tool: localhost in your Windows browser, files in Windows Explorer (under `\\wsl$\Ubuntu\home\<you>\soul-hub`).

1. **Install WSL2 + Ubuntu** (one-time, in PowerShell as Administrator):

   ```powershell
   wsl --install -d Ubuntu
   ```

   Restart Windows when prompted, then open the Ubuntu app and finish first-run setup (set a username + password).

2. **Install build tools inside Ubuntu** (one-time):

   ```bash
   sudo apt update
   sudo apt install -y build-essential python3 git curl
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

3. **Clone into your Linux home** — **not** under `/mnt/c/`. Crossing the WSL/Windows filesystem boundary breaks file watchers and is 5–10× slower:

   ```bash
   cd ~
   git clone https://github.com/jneaimi/soul-hub.git
   cd soul-hub
   npm run setup
   npm run dev
   ```

4. **Open the browser on Windows.** WSL2 forwards `localhost` automatically — go to `http://localhost:5173`. No extra config.

5. **Install Claude Code inside WSL** (it must be on the same side as Soul Hub). Follow the official install instructions from inside the Ubuntu shell, then re-run `npm run doctor`.

> Optional: from a Windows PowerShell prompt you can run `powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1` — it just confirms WSL2 is installed and prints the steps above.

> Don't store the repo on `/mnt/c/Users/...` even if it works. Chokidar misses events, `npm install` is sluggish, and `node-pty`'s native binary crosses a filesystem boundary on every spawn.

## What `npm run setup` Does

The bootstrap script (`scripts/bootstrap.sh`) is a thin shell script that:

1. Verifies Node ≥ 20 and reports the path of `claude` if it's on PATH.
2. If `nvm` is installed and the project has a `.nvmrc`, switches to the pinned Node version before any install or rebuild. The project pins Node 24 (current LTS). This guarantees `npm install` and `npm rebuild` build native modules against the same Node version PM2 uses — the alternative (shell on a different Node than PM2) silently breaks the long-running process even though `npm run doctor` reports green from the shell.
3. Runs `npm install` (which rebuilds `node-pty` natively).
4. Verifies both native modules (`node-pty` + `better-sqlite3`) actually load. If either fails — commonly because you upgraded Node since the last install and the cached binaries target the old ABI — runs `npm rebuild` to recompile against the current Node version, then re-verifies. Only fails loudly with the build-tools install hint if the rebuild itself can't compile.
4. Creates `~/.soul-hub/`, `~/.soul-hub/data/`, `~/.soul-hub/logs/`, `~/vault/`, `~/dev/`.
5. Copies `settings.example.json` → `~/.soul-hub/settings.json` (skipped if it already exists). If it found `claude` on PATH at a non-default location, it patches `paths.claudeBinary` for you.
6. Creates `~/.soul-hub/.env` with a freshly generated `SOUL_HUB_SECRET` (only if the file is missing or the key isn't set). Sets the file mode to `0600`.
7. Injects a managed block into `~/.claude/CLAUDE.md` between `<!-- soul-hub:start -->` / `<!-- soul-hub:end -->` markers. The block tells Claude Code (in any directory) to query the local vault API at `http://localhost:2400/api/vault/notes` before non-trivial work. The block is idempotent — re-running bootstrap replaces it in place and never duplicates. Existing content in your `CLAUDE.md` is preserved.
8. Initializes a local git repo at `~/vault/.git/` per [ADR-019](https://github.com/jneaimi/soul-hub/blob/main/CONTRIBUTING.md#adr-019). Writes `~/vault/.gitignore`, runs `git init -b main`, and creates an initial commit if your global `git config user.{name,email}` is set (otherwise warns and skips the commit so you can fix and re-run). The repo is local-only (no remote) and is the version-history layer underneath the vault writer module — every successful write through the engine produces a labelled commit, and the seeded `vault-backup-daily` scheduler task captures direct filesystem edits as a daily safety net.

It does **not**:
- Initialize the SQLite databases. Those auto-migrate on the first server start (`getInboxDb()` and `getHeartbeatDb()` create + version their schemas in-process).
- Seed any data. There is no seed step in Soul Hub — every store self-initializes from migrations.
- Configure Claude Code. Install + log in to Claude Code yourself; the doctor will then find it.

## Verifying the Install (`npm run doctor`)

`npm run doctor` runs `scripts/doctor.mjs` — a read-only health check. It validates:

| Check | Pass condition |
|------|----------------|
| Node.js | version ≥ 20 |
| node-pty | `require('node-pty')` succeeds |
| better-sqlite3 | opens an in-memory database |
| `~/.soul-hub/` | exists and is writable |
| `settings.json` | parses as valid JSON |
| `SOUL_HUB_SECRET` | present (warns if missing — only required for Unified Inbox) |
| Vault dir | `paths.vaultDir` from settings exists and is writable |
| Claude CLI | `paths.claudeBinary` from settings, or `claude` on PATH, resolves |
| Vault git | `~/vault/.git/` exists and has at least 1 commit (warn-level — local history is recommended, not required) |
| `vault-backup-daily` task | scheduler task is registered in `settings.json` (warn-level) |
| Node ABI parity | shell Node major matches the running PM2 process's Node major (fail-level — drift here means the next `npm rebuild` will silently break PM2; align via `nvm use` before rebuilding) |
| Platform | macOS / Linux / WSL2 — fails on native Windows |

Exit code is non-zero if any check fails, so you can wire it into CI.

## Manual Setup (no bootstrap script)

If you want to avoid `npm run setup` and do everything by hand, the equivalent steps are:

```bash
# 1. Install dependencies
npm install

# 2. Create user dirs
mkdir -p ~/.soul-hub/data ~/.soul-hub/logs ~/vault ~/dev

# 3. Settings
cp settings.example.json ~/.soul-hub/settings.json
# (edit paths.claudeBinary if `which claude` differs from ~/.local/bin/claude)

# 4. Secret
touch ~/.soul-hub/.env && chmod 600 ~/.soul-hub/.env
echo "SOUL_HUB_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" >> ~/.soul-hub/.env
```

## Vault chokepoint (ADR-046 / 047 / 048 / 049)

The vault has a five-layer write defense stack. Three of the layers live
**outside this repo** — in `~/.claude/` (Claude Code's user-global config)
and in the vault's own git repo at `~/vault/`. They don't ship with
`npm run setup` today. The canonical sources are bundled in `install/` and
this section walks through wiring them up. (Automated installer: ADR-050,
planned — until it ships, the manual steps below are the path.)

### Layer reference

| Layer | Lives at | Purpose |
|---|---|---|
| **L1** (ADR-046 Pass 1) | `~/.claude/hooks/vault-write-guard.sh` | Block direct `Write`/`Edit`/`NotebookEdit` on vault paths |
| **L2** (ADR-046 Pass 2) | `~/.claude/hooks/vault-write-guard-bash.sh` | Block `Bash` shell-redirect / `tee` / `cp` / `sed -i` / `touch` on vault paths |
| **L3** (ADR-047) | `src/lib/vault/link-validator.ts` (already in this repo) | REFUSE auto-memory + bare-slug wikilinks at the API; WARN unresolved |
| **L4** (ADR-048) | `~/vault/.vault/hooks/pre-commit` | Re-run L3 REFUSE rules at git-commit time (catches inline-interpreter bypasses) |
| **L5** (ADR-049) | `src/lib/vault/index.ts` (already in this repo) | Opt-in `scaffold_stubs: true` materialises empty stub notes for forward refs |

L3 and L5 ship with the soul-hub code itself — no install step. L1, L2, L4
are what this section adds. The `/vault-write` skill (ADR-046's redirect
target) also lives in `~/.claude/skills/` and is part of the same wiring.

### Step 1 — Install the Claude Code hooks (L1 + L2)

```bash
mkdir -p ~/.claude/hooks
cp install/hooks/vault-write-guard.sh      ~/.claude/hooks/
cp install/hooks/vault-write-guard-bash.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/vault-write-guard*.sh
```

**Recommended for active development — symlink instead of copy:**

```bash
ln -sf "$(pwd)/install/hooks/vault-write-guard.sh"      ~/.claude/hooks/vault-write-guard.sh
ln -sf "$(pwd)/install/hooks/vault-write-guard-bash.sh" ~/.claude/hooks/vault-write-guard-bash.sh
```

### Step 2 — Register the hooks in `~/.claude/settings.json`

The canonical block is at `install/claude-settings.snippet.json`. Merge it
into your existing settings (do NOT clobber other hooks you have):

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%s) 2>/dev/null || true

python3 <<'PY'
import json, os
p = os.path.expanduser('~/.claude/settings.json')
try: s = json.load(open(p))
except FileNotFoundError: s = {}
s.setdefault('hooks', {}).setdefault('PreToolUse', [])
needed = [
    {"matcher":"Write|Edit|NotebookEdit","hooks":[{"type":"command","command":"bash ~/.claude/hooks/vault-write-guard.sh","timeout":5,"statusMessage":"Vault-write chokepoint (ADR-046)..."}]},
    {"matcher":"Bash","hooks":[{"type":"command","command":"bash ~/.claude/hooks/vault-write-guard-bash.sh","timeout":5,"statusMessage":"Vault-write chokepoint Bash (ADR-046 Pass 2)..."}]},
]
existing = s['hooks']['PreToolUse']
for entry in needed:
    cmd = entry['hooks'][0]['command']
    if not any(cmd in (h.get('command','') for h in (e.get('hooks') or [])) for e in existing):
        existing.append(entry); print('added:', entry['matcher'])
    else:
        print('already present:', entry['matcher'])
open(p, 'w').write(json.dumps(s, indent=2))
PY
```

### Step 3 — Install the `/vault-write` skill

```bash
mkdir -p ~/.claude/skills
cp -R install/skills/vault-write ~/.claude/skills/
chmod +x ~/.claude/skills/vault-write/scripts/vault-write.sh
```

**Or symlink:**

```bash
ln -sfn "$(pwd)/install/skills/vault-write" ~/.claude/skills/vault-write
```

### Step 4 — Install the vault pre-commit hook (L4)

The hook source is versioned **inside the vault itself** at
`~/vault/.vault/hooks/pre-commit`. On an existing vault clone it should
already be present; if it isn't, get it from soul-hub:

```bash
mkdir -p ~/vault/.vault/hooks

# If your vault is already cloned with the hook, skip this. Otherwise:
test -f ~/vault/.vault/hooks/pre-commit || {
  echo "Seed the hook from soul-hub's bundled copy:"
  cp install/hooks/vault-pre-commit            ~/vault/.vault/hooks/pre-commit 2>/dev/null || true
  cp install/hooks/vault-pre-commit-install.sh ~/vault/.vault/hooks/install.sh 2>/dev/null || true
  chmod +x ~/vault/.vault/hooks/pre-commit ~/vault/.vault/hooks/install.sh
}

# Install the symlink into the vault's .git/hooks/
~/vault/.vault/hooks/install.sh
# expect: "installed: pre-commit → /Users/<you>/vault/.vault/hooks/pre-commit"
```

> The bundled-from-soul-hub copy is not yet shipped in `install/hooks/` —
> see ADR-050 (planned) for the seed-script that brings them under this
> repo so a fresh vault doesn't have a chicken-and-egg.

### Step 5 — Verify all five layers

```bash
TODAY=$(date +%Y-%m-%d)

# L1 — In a Claude Code session, try Write under ~/vault/. Expect: blocked.
# L2 — In a Claude Code session, try:  echo x > ~/vault/test.md. Expect: blocked.

# L3 — auto-memory link must be REFUSED at the API:
curl -s -X POST http://localhost:2400/api/vault/notes \
  -H 'Content-Type: application/json' \
  -d "{\"zone\":\"inbox\",\"filename\":\"l3-test.md\",\"meta\":{\"type\":\"note\",\"created\":\"$TODAY\",\"tags\":[\"test\",\"auto-generated\"],\"source_agent\":\"install-test\"},\"content\":\"# L3\n[[feedback_xyz]]\"}" \
  | jq '.error'
# expect: "Wikilink validation failed: Wikilinks to auto-memory filenames are forbidden..."

# L4 — interpreter bypass + pre-commit:
python3 -c "open('$HOME/vault/inbox/adr-048-smoke.md','w').write('''---
type: note
created: $TODAY
tags: [test]
---
# Smoke
[[feedback_evil]]
''')"
cd ~/vault && git add inbox/adr-048-smoke.md && .git/hooks/pre-commit
echo "exit=$?"   # expect 1 + auto-memory violation
git reset HEAD inbox/adr-048-smoke.md && rm ~/vault/inbox/adr-048-smoke.md

# L5 — scaffold_stubs:
curl -s -X POST http://localhost:2400/api/vault/notes \
  -H 'Content-Type: application/json' \
  -d "{\"zone\":\"inbox\",\"filename\":\"l5-test.md\",\"meta\":{\"type\":\"note\",\"created\":\"$TODAY\",\"tags\":[\"test\",\"auto-generated\"],\"scaffold_stubs\":true,\"source_agent\":\"install-test\"},\"content\":\"# L5\n[[l5-scaffold-target]]\"}" \
  | jq '.stubs_created'
# expect: array with inbox/l5-scaffold-target.md

# Cleanup
curl -s -X DELETE "http://localhost:2400/api/vault/notes/inbox/l5-test.md" -o /dev/null
curl -s -X DELETE "http://localhost:2400/api/vault/notes/inbox/l5-scaffold-target.md" -o /dev/null
```

If all five fire as expected, the chokepoint is fully installed.

### Editing the hooks

Edit the canonical source in `install/hooks/` and re-deploy:

- **If you symlinked** in Step 1 / Step 3: edits are live immediately on
  the next tool invocation. No re-deploy.
- **If you copied:** re-run Step 1 to overwrite, or just re-copy the
  changed file.

`~/.claude/hooks/*` should be treated as **derived state**, not source.
Anyone editing those directly is fighting the install model.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| L1/L2 didn't block; Write went through | settings.json not loaded | restart your Claude Code session |
| `Permission denied` running hook | chmod missing | `chmod +x ~/.claude/hooks/vault-write-guard*.sh` |
| L4 exit 0 on a bad note | symlink not installed | re-run `~/vault/.vault/hooks/install.sh` |
| L4 exit 0 + `[vault-pre-commit] skipped` | `VAULT_SKIP_LINK_CHECK=1` set in env | unset it |
| L3/L5 returns connection error | soul-hub not running | start it (`npm run dev` or PM2) |

## Optional: TikTok transcription (ADR-024)

The `tiktokFetch` orchestrator tool turns a TikTok URL pasted into WhatsApp/Telegram into structured metadata + speech transcript + (optional) Gemini summary. It is **off by default on fresh installs** because it requires ~250 MB of additional dependencies. The bootstrap prompts at install time; pass `--with-tiktok` for non-interactive installs or `--no-tiktok` to skip.

When the deps are missing, the `tiktokFetch` tool is **dropped from the orchestrator entirely** by the runtime capability probe — the LLM never sees a tool it can't call, so a TikTok URL pasted into a non-TikTok install replies with a clean "TikTok transcription is not enabled on this server" message rather than a stack trace.

**One-shot install (any time after bootstrap):**

```bash
bash scripts/install-tiktok-deps.sh                # English-only (~250 MB)
bash scripts/install-tiktok-deps.sh --with-arabic  # also adds ggml-small for AR (~720 MB total)
```

**Per-platform deps** (the script handles all of these — listed for transparency):

```
macOS:    brew install yt-dlp ffmpeg whisper-cpp && pip3 install --user curl-cffi
Ubuntu:   sudo apt install -y yt-dlp ffmpeg && pip3 install --user curl-cffi
          (whisper.cpp built from source — script handles it)
WSL2:     same as Ubuntu
Model:    ggml-base.bin (~142 MB) → ~/.cache/whisper-cpp/  (auto-downloaded)
```

**Verify:**

```bash
npm run doctor      # look for the "tiktok-fetch deps" row — should be OK
```

**Disable cleanly:** set `channels.whatsapp.tiktok.enabled = false` in `~/.soul-hub/settings.json`. The capability probe also auto-disables when binaries are missing — no settings edit needed for opt-out.

**Cost / privacy:** Tier A (yt-dlp metadata) and Tier B (local whisper) are free and run entirely on the host. Tier C (Gemini summary) is optional, capped per-day, and only fires when the user explicitly asks for a summary. No transcripts leave the host unless the user invokes `mode='summary'`.

## Optional: Gmail Inbox (OAuth2)

The Inbox feature can sync Gmail accounts via IMAP using OAuth2. This requires
a one-time Google Cloud Console setup to issue OAuth credentials for your
self-hosted Soul Hub. Skip this section if you only use iCloud / Custom IMAP.

**Why OAuth, not an app password:** as of May 1, 2025 Google removed password-
based access for Workspace IMAP. OAuth (XOAUTH2) is now the only path. For
personal `@gmail.com` accounts, app passwords still technically work but Soul
Hub does not implement that path — OAuth gives you proper token refresh and a
revocation surface in your Google Account.

### Setup

1. Open [Google Cloud Console](https://console.cloud.google.com) and create
   a new project (e.g. "Soul Hub Inbox").
2. Search for **Gmail API** in the top bar → **Enable**.
3. Left nav → **APIs & Services → OAuth consent screen**:
   - User Type: **External** (the only option without a Workspace org)
   - App name: `Soul Hub` · support + developer email: your email
   - Scopes: add `openid`, `.../auth/userinfo.email`, and the restricted
     scope `https://mail.google.com/`. You will see a warning on the
     restricted scope — expected.
   - Test users: add the Gmail address you want to sync.
   - **Leave Publishing status as "Testing"** — do NOT click "Publish App".
     Publishing the `mail.google.com` scope triggers Google's CASA security
     assessment, which is paid and weeks long. Testing mode is the right
     choice for a single-user self-hosted tool.
4. Left nav → **APIs & Services → Credentials → + Create Credentials →
   OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs — add **both**:
     - `http://localhost:2400/api/inbox/oauth/callback`
     - `https://<your-public-url>/api/inbox/oauth/callback` (e.g. your
       Cloudflare tunnel domain)
   - Copy the **Client ID** and **Client Secret** from the dialog.
5. In the Soul Hub UI, open **Settings → Platform Environment**, then set the
   two new fields:
   - `GOOGLE_CLIENT_ID` → the value from Google Cloud Console
   - `GOOGLE_CLIENT_SECRET` → the value from Google Cloud Console

   Soul Hub stores both encrypted in `~/.soul-hub/.env` (0600) and updates
   `process.env` in-memory, so the new values take effect on the next
   request — **no `pm2 restart` needed.** The Add Gmail screen will detect
   the new credentials automatically.
6. In the Inbox UI → **Add Account** → Gmail → **Sign in with Google**.
   Grant consent in the popup. The callback creates the account row and
   starts the sync worker.

### Token rotation (7-day Testing-mode limit)

While the OAuth consent screen is in Testing status, Google forcibly expires
refresh tokens after **7 days**. When that happens the sync worker will
error with `invalid_grant` and stop syncing.

Recovery: open the account in the Inbox settings modal → expand
**Reauthorize** → click **Reauthorize with Google**. This redirects through
the consent flow again, updates the existing account's encrypted tokens in
place, and restarts the sync worker. No data is lost.

You can also revoke Soul Hub's access at any time from
[Google Account → Third-party access](https://myaccount.google.com/permissions).

### Troubleshooting

- **Add Gmail screen says "Gmail OAuth isn't configured yet"** — set both
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` under Settings → Platform
  Environment. The detection check runs on the next page load.
- **`redirect_uri_mismatch`** — the redirect URI in your Google Cloud
  Console OAuth client doesn't include the origin you're clicking from.
  Add both `localhost:2400` and your tunnel URL.
- **`access_denied`** — your Gmail address isn't in the Test Users list
  on the OAuth consent screen.
- **Sync stops after ~7 days** — Testing-mode refresh token expired.
  Click Reauthorize. There is no permanent fix while the app is in Testing
  mode (Google policy).

## Optional: Auto-switch Node via nvm on `cd`

The project pins Node 24 (current LTS) in `.nvmrc`. The bootstrap and CI tooling honor it automatically, but your shell does not — by default, `cd ~/dev/soul-hub` keeps whatever Node version your shell was already on. If that drifts (e.g. brew updates global Node behind your back), the next `npm rebuild` you run from this directory builds native modules against the wrong Node ABI and breaks the PM2 process. The doctor's "Node ABI parity" check will catch it after the fact, but the cleanest fix is to never let drift happen in the first place.

Add this hook to `~/.zshrc` (zsh — the default macOS shell). It auto-runs `nvm use` whenever you enter a directory that has a `.nvmrc`:

```bash
# soul-hub-nvm-hook:start
# Auto-switch Node via nvm when entering a directory with .nvmrc.
autoload -U add-zsh-hook
_soul_hub_load_nvmrc() {
  if [[ -f .nvmrc ]] && command -v nvm >/dev/null 2>&1 ; then
    nvm use --silent >/dev/null 2>&1
  fi
}
add-zsh-hook chpwd _soul_hub_load_nvmrc
_soul_hub_load_nvmrc
# soul-hub-nvm-hook:end
```

After adding, open a new terminal (or `source ~/.zshrc`) and verify with `cd ~/dev/soul-hub && node -v` — it should now report the version pinned in `.nvmrc`.

For bash users, the equivalent uses a `PROMPT_COMMAND` hook; see [nvm's deeper-shell-integration docs](https://github.com/nvm-sh/nvm#deeper-shell-integration). For fish, see [nvm.fish](https://github.com/jorgebucaran/nvm.fish).

## Optional: Project-root `.env`

`.env` in the repo root is also loaded, but `~/.soul-hub/.env` wins on conflict. Most users don't need a project `.env` — leave it for development overrides.

```bash
cp .env.example .env       # only if you want repo-local env overrides
```

Edit `.env` to add any API keys you need (Gemini, ElevenLabs, Telegram, etc.). Pipelines that require a specific key will fail gracefully if it's missing.

### Optional — Mac-wide secret store (recommended)

Soul Hub stores platform secrets in `~/.soul-hub/.env` (managed via the Settings UI). To make those same secrets visible to your shell and any tool you run from it, add this one line near the bottom of `~/.zshrc` (or `~/.bashrc`):

```bash
set -a; [ -f "$HOME/.soul-hub/.env" ] && . "$HOME/.soul-hub/.env"; set +a
```

`set -a` exports every variable defined in the file. The `[ -f ... ]` check makes the line a no-op for fresh installs that don't have the file yet. The PM2 config already reads the same file via `env_file`, so child processes spawned by Soul Hub inherit it without the zshrc line — this is just for shell sessions and other tools.

#### launchd cron jobs (advanced)

If you have personal launchd jobs (cron-style background tasks under `~/Library/LaunchAgents/com.*.plist`) that should also see your Soul Hub secrets, wrap their `ProgramArguments` with a `/bin/sh -c` preamble that sources the env file before `exec`-ing the original command:

```xml
<key>ProgramArguments</key>
<array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>set -a; [ -f "$HOME/.soul-hub/.env" ] &amp;&amp; . "$HOME/.soul-hub/.env"; set +a; exec /opt/homebrew/bin/python3 /Users/you/path/to/script.py</string>
</array>
```

Apply with `launchctl bootout gui/$(id -u)/<label> && launchctl bootstrap gui/$(id -u) <plist>`.

#### Diagnose drift

Run the doctor any time to verify all entry points see the same secrets:

```bash
./scripts/doctor-secrets.sh
```

It checks `~/.soul-hub/` modes, the secrets file, the zshrc source line, the PM2 `env_file` declaration, and any user-owned launchd plists. Read-only — never modifies anything. Exits non-zero on FAIL so it can be wired into CI later.

#### Test individual credentials from the UI

Settings → **Platform Environment** renders a **Test** button next to every declared + set credential. Clicking it pings the upstream API with a read-only request and colour-codes the row by outcome (`ok`, `unauthorized`, `invalid`, `ratelimit`, `network`, `unconfigured`, `unsupported`). Built-in coverage:

| Key | What's tested |
|---|---|
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Bot token via `getMe`, chat reachability via `getChat` |
| `GEMINI_API_KEY` | `GET /v1beta/models` |
| `OPENROUTER_API_KEY` | `GET /api/v1/auth/key` |
| `ANTHROPIC_API_KEY` | `GET /v1/models` |
| `ELEVENLABS_API_KEY` | `GET /v1/user` |
| `RESEND_API_KEY` | `GET /api-keys` |
| `YOUTUBE_API_KEY` | `videos.list` (zero quota cost) |
| `LINEAR_API_KEY` | GraphQL `viewer { id }` |
| `HF_API_TOKEN` | `whoami-v2` |
| `GOOGLE_API_KEY` | Geocoding API ping |
| `EODHD_API_KEY` | `user` endpoint |

Add a tester for a new provider by dropping a file in `src/lib/providers/` that exports `provider: ProviderTester` and registering it in `providers/registry.ts`.

#### Test routes from the UI

Settings → **Routes** lists every configured route (primary + failover chain + timeout + retries + live circuit-breaker state) and exposes a per-route **Test** button that runs a small ping through `dispatchRoute()` and reports which provider answered, the latency, and a short transcript snippet. Useful for verifying that a route's failover chain actually fails over — flipping a credential and re-testing instantly shows the next-in-chain taking over.

#### WhatsApp pairing without leaving the browser

Settings → **WhatsApp** carries the full lifecycle: a Link button that triggers `/login` and renders the QR inline (polling for refresh while pairing), allowlist editor, intent map editor (slash commands → routes), and the worker-mode toggle for the crash-isolated PM2 app. Status updates poll fast (1.5s) while pairing and slow (8s) while idle.

## Running

Soul Hub stores all user state outside the repo under `~/.soul-hub/` (settings, secrets, runtime data, logs). Override the location by exporting `SOUL_HUB_HOME`. All paths support `~` expansion.

The vault auto-initializes with governance files and templates on first access — there is nothing to seed manually.

### Development Mode

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Production Mode (PM2)

```bash
# Build the app
npm run build

# Start with PM2 (runs on port 2400)
npm run prod:start
```

Open [http://localhost:2400](http://localhost:2400).

### Production Commands

```bash
npm run prod:start      # Start all processes (app + tunnel)
npm run prod:stop       # Stop all processes
npm run prod:restart    # Zero-downtime reload
npm run prod:status     # Show process status
npm run prod:logs       # Tail logs
npm run prod:startup    # Enable auto-start on boot
```

The PM2 config is in `ecosystem.config.cjs`. It runs two processes:

| Process | Purpose | Port |
|---------|---------|------|
| `soul-hub` | SvelteKit app | 2400 |
| `soul-hub-tunnel` | Cloudflare Tunnel (optional) | - |

Logs are written to `~/.soul-hub/logs/`. The app auto-restarts on crash with exponential backoff, and respects a 512MB memory limit.

## Optional: Linking a WhatsApp Channel

Soul Hub can connect to a personal WhatsApp number via Baileys (unofficial WhatsApp Web library — use a dedicated number to stay clear of Meta's ToS gray zone). Once linked, inbound DMs route through the configurable routes layer (text chat goes to Gemini/OpenRouter/Anthropic; voice notes auto-transcribe via Gemini).

1. **Enable in `~/.soul-hub/settings.json`** — set `channels.whatsapp.enabled: true` and add your own number to the allowlist:

   ```json
   {
     "channels": {
       "whatsapp": {
         "enabled": true,
         "access": { "allowFrom": ["+9715xxxxxxxx"] }
       }
     }
   }
   ```

2. **Trigger pairing** — `curl -X POST http://localhost:2400/api/channels/whatsapp/login`. The QR appears two ways:
   - PNG data URL on `GET /api/channels/whatsapp/status` (rendered in the Settings UI when Phase 5 ships)
   - ANSI block-art QR printed to PM2 stdout (`npm run prod:logs`) when `delivery.printTerminalQr: true` (default)

3. **Scan with the WhatsApp app** → Settings → Linked Devices → Link a Device.

4. **Use it.** Free-form DMs route to `vault-chat`. Voice notes are transcribed and routed the same way. Slash commands map via `intentMap` (`/translate` ships by default → `translate-arabic`). Send a one-off message from code with `sendViaChannel('whatsapp', text, attachPath?)`.

Disconnect with `POST /api/channels/whatsapp/logout` (wipes the auth dir at `~/.soul-hub/data/whatsapp/<account>/` so the next login asks for a fresh QR).

### Crash-isolated worker mode (recommended for prod)

By default WhatsApp runs in-process inside the main `soul-hub` SvelteKit server — simple, but a Baileys WS error or decryption blowup takes the whole web UI with it. To isolate the channel, flip on the dedicated PM2 app `soul-hub-whatsapp`:

```json
{
  "channels": {
    "whatsapp": {
      "enabled": true,
      "worker": {
        "enabled": true,
        "url": "http://127.0.0.1:2401",
        "mainAppUrl": "http://127.0.0.1:2400"
      }
    }
  }
}
```

Then `npm run prod:start` (or `npm run prod:restart`) — PM2 launches `soul-hub-whatsapp` alongside the main app. The main app's WhatsApp adapter switches to HTTP-proxy mode automatically; `/api/channels/whatsapp/{login,status,logout}` keep the same surface. Inbound messages flow back via a callback to `/api/channels/whatsapp/_inbound`. If the worker crashes, only the worker restarts — the SvelteKit server keeps serving.

For non-loopback setups (workers on a different host, or anyone exposing port 2401), set `channels.whatsapp.worker.bearerToken` to a shared secret. Both ends will then require `Authorization: Bearer <token>` on every request.

The worker is bundled into `build/whatsapp-worker.js` by `npm run build`. PM2's `whatsapp-out.log` / `whatsapp-error.log` (under `~/.soul-hub/logs/`) carry its output, including the ASCII pairing QR.

## Configuration Reference

Soul Hub reads `~/.soul-hub/settings.json`. All fields are optional — defaults are shown below:

```json
{
  "terminal": {
    "fontSize": 13,
    "cols": 120,
    "rows": 40,
    "cursorBlink": true
  },
  "interface": {
    "defaultPanel": "code",
    "panelWidth": 260
  },
  "paths": {
    "devDir": "~/dev",
    "vaultDir": "~/vault",
    "catalogDir": "~/dev/soul-hub/catalog",
    "claudeBinary": "~/.local/bin/claude"
  },
  "server": {
    "port": 2400
  },
  "proxy": {
    "enabled": true,
    "allowedPortRange": [1024, 9999],
    "blockedPorts": [2400]
  }
}
```

### Path Resolution

All paths support `~` expansion to your home directory. You can also use absolute paths.

| Path | Default | Purpose |
|------|---------|---------|
| `devDir` | `~/dev` | Where your projects live |
| `vaultDir` | `~/vault` | Knowledge vault (Obsidian-compatible) |
| `catalogDir` | `~/dev/soul-hub/catalog` | Shared blocks and agents |
| `claudeBinary` | `~/.local/bin/claude` | Claude Code CLI binary |

## Setting Up Your First Project

1. Open Soul Hub in your browser
2. Go to the **Projects** page
3. Click **Add Project** on any detected project in `~/dev/`
4. Open the project to launch a Claude Code terminal

## Creating Your First Pipeline

1. Go to the **Pipelines** page
2. Create a new folder in `pipelines/`:
   ```bash
   mkdir -p pipelines/my-pipeline/blocks/my-block
   ```
3. Or use the builder from within a Claude Code session in the `_builder` project

## Remote Access (Optional)

You can access Soul Hub remotely from any device using a Cloudflare Tunnel. This gives you:
- HTTPS access at `soul-hub.yourdomain.com`
- Dev preview proxy at `pXXXX.soul-hub.yourdomain.com`
- Optional email/SSO authentication via Cloudflare Access

See the full setup guide with screenshots: **[docs/tunnel-guide/TUNNEL.md](docs/tunnel-guide/TUNNEL.md)**

## Troubleshooting

### node-pty build fails

```bash
# macOS
xcode-select --install

# Linux (Debian/Ubuntu)
sudo apt install build-essential python3

# Then retry
npm rebuild node-pty
```

### Claude binary not found

Check where Claude Code is installed:
```bash
which claude
```

Update `settings.json` with the correct path.

### Port 2400 already in use

Change the port in `settings.json`:
```json
{ "server": { "port": 3000 } }
```

And set the `PORT` environment variable:
```bash
PORT=3000 npm run dev
```

### Vault not loading

Ensure the vault directory exists and is writable:
```bash
mkdir -p ~/vault
ls -la ~/vault
```

### Pipeline Python blocks fail

Install uv for Python dependency management:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### GitNexus analyze crashes on install

On Node 24 + npm 11, the stable `gitnexus@1.6.2` may fail during install with:

```
npm error Cannot destructure property 'package' of 'node.target' as it is null.
```

This is an npm arborist bug triggered by GitNexus's `tree-sitter-dart` git dependency. Use the 1.6.3 prerelease until it lands stable:

```bash
npx gitnexus@1.6.3-rc.28 analyze
```
