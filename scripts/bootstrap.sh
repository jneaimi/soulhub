#!/usr/bin/env bash
# Soul Hub bootstrap — Mac / Linux / WSL2 Ubuntu.
# Idempotent: safe to re-run. Does not overwrite existing config.

set -euo pipefail

# ── colors (only when TTY) ────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YLW=$(printf '\033[33m'); BLU=$(printf '\033[34m')
  RST=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi

step() { printf "%s==>%s %s\n" "$BLU$BOLD" "$RST" "$1"; }
ok()   { printf "  %s✓%s %s\n"   "$GRN" "$RST" "$1"; }
warn() { printf "  %s!%s %s\n"   "$YLW" "$RST" "$1"; }
err()  { printf "  %s✗%s %s\n"   "$RED" "$RST" "$1" >&2; }
die()  { err "$1"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SOUL_HUB_HOME="${SOUL_HUB_HOME:-$HOME/.soul-hub}"
VAULT_DIR_DEFAULT="$HOME/vault"
DEV_DIR_DEFAULT="$HOME/dev"

# ── ADR-024 — opt-in install flags for TikTok transcription deps ─
WITH_TIKTOK=auto  # auto | yes | no
for arg in "$@"; do
  case "$arg" in
    --with-tiktok) WITH_TIKTOK=yes ;;
    --no-tiktok)   WITH_TIKTOK=no  ;;
  esac
done

printf "%sSoul Hub bootstrap%s\n" "$BOLD" "$RST"
printf "%sRepo:%s %s\n" "$DIM" "$RST" "$REPO_ROOT"
printf "%sHome:%s %s\n\n" "$DIM" "$RST" "$SOUL_HUB_HOME"

# ── 1. Node ≥ 20 ──────────────────────────────────────────────────
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  die "node not found. Install Node 20+ from https://nodejs.org or via your package manager."
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node $(node -v) is too old. Soul Hub needs Node 20+."
fi
ok "Node $(node -v)"

# ── 2. Claude CLI ─────────────────────────────────────────────────
step "Checking Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  CLAUDE_PATH=$(command -v claude)
  ok "claude → $CLAUDE_PATH"
else
  CLAUDE_PATH=""
  warn "claude not on PATH — install from https://docs.anthropic.com/en/docs/claude-code"
  warn "You can finish bootstrap now and configure paths.claudeBinary later."
fi

# ── 2b. Honor .nvmrc if nvm is available ─────────────────────────
# Native modules (better-sqlite3, node-pty) compile against ONE Node
# major version. PM2 runs the project under whatever Node it was
# launched with. If the user's shell drifted (brew updated Node, or
# they're on a different nvm version), `npm install`/`npm rebuild`
# below would build for the wrong ABI and silently break PM2's
# running process. `nvm use` (when nvm is present) aligns the shell
# to .nvmrc before any install/rebuild.
step "Aligning Node version to .nvmrc"
if [ -f "$REPO_ROOT/.nvmrc" ]; then
  PINNED_NODE=$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    \. "$HOME/.nvm/nvm.sh"
    if nvm use --silent >/dev/null 2>&1 ; then
      ok "nvm switched to $(node -v) (pinned: $PINNED_NODE)"
    else
      warn "nvm couldn't activate Node $PINNED_NODE — try: nvm install $PINNED_NODE"
    fi
  else
    SHELL_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "?")
    if [ "$SHELL_MAJOR" = "$PINNED_NODE" ]; then
      ok "shell Node v$SHELL_MAJOR matches .nvmrc"
    else
      warn "shell Node v$SHELL_MAJOR differs from .nvmrc ($PINNED_NODE) — install nvm or switch Node manually"
    fi
  fi
else
  ok "no .nvmrc — skipping pin"
fi

# ── 3. npm install ────────────────────────────────────────────────
step "Installing npm dependencies (this also rebuilds node-pty)"
npm install --no-audit --no-fund

# Verify both native modules load. If either fails (commonly because
# the lockfile-cached binaries were built against a different Node
# major version — e.g. user upgraded from Node 22 to Node 25), run
# `npm rebuild` to recompile against the current Node ABI, then
# re-verify. Only surface the build-tools-missing error if the
# rebuild itself fails.
verify_native() {
  node -e "require('node-pty'); require('better-sqlite3')" 2>/dev/null
}

if ! verify_native ; then
  warn "Native module ABI mismatch detected — running 'npm rebuild' (Node $(node -v) ABI)"
  if npm rebuild --no-audit --no-fund >/dev/null 2>&1 && verify_native ; then
    ok "Rebuilt native modules against $(node -v)"
  else
    err "Native modules failed to load after rebuild."
    if [ "$(uname -s)" = "Darwin" ]; then
      err "Run: xcode-select --install   (then re-run this script)"
    elif grep -qi microsoft /proc/version 2>/dev/null; then
      err "On WSL: sudo apt install -y build-essential python3"
    else
      err "On Linux: sudo apt install -y build-essential python3   (or your distro equivalent)"
    fi
    exit 1
  fi
fi
ok "node-pty + better-sqlite3 load"

# ── 4. ~/.soul-hub and ~/vault ────────────────────────────────────
step "Preparing user directories"
mkdir -p "$SOUL_HUB_HOME" "$SOUL_HUB_HOME/data" "$SOUL_HUB_HOME/logs"
ok "$SOUL_HUB_HOME"

if [ ! -d "$VAULT_DIR_DEFAULT" ]; then
  mkdir -p "$VAULT_DIR_DEFAULT"
  ok "$VAULT_DIR_DEFAULT (created)"
else
  ok "$VAULT_DIR_DEFAULT (already exists)"
fi

if [ ! -d "$DEV_DIR_DEFAULT" ]; then
  mkdir -p "$DEV_DIR_DEFAULT"
  ok "$DEV_DIR_DEFAULT (created)"
fi

# ── 5. settings.json ──────────────────────────────────────────────
step "Configuring settings.json"
SETTINGS_FILE="$SOUL_HUB_HOME/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  ok "$SETTINGS_FILE (already exists — left untouched)"
else
  # Substitute <REPO_ROOT> placeholder so seeded scheduler tasks (e.g.
  # vault-backup-daily) point at the correct on-disk repo location.
  # sed -i works portably on macOS + Linux with this in-place form.
  node - "$REPO_ROOT/settings.example.json" "$SETTINGS_FILE" "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const [, , src, dst, repoRoot] = process.argv;
const txt = fs.readFileSync(src, 'utf8').replace(/<REPO_ROOT>/g, repoRoot);
fs.writeFileSync(dst, txt);
NODE
  ok "Wrote $SETTINGS_FILE from settings.example.json"

  # Patch claudeBinary if we found one and it's not the default location
  if [ -n "$CLAUDE_PATH" ] && [ "$CLAUDE_PATH" != "$HOME/.local/bin/claude" ]; then
    node - "$SETTINGS_FILE" "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');
const [, , file, p] = process.argv;
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
j.paths = j.paths || {};
j.paths.claudeBinary = p;
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
NODE
    ok "Patched paths.claudeBinary → $CLAUDE_PATH"
  fi
fi

# ── 6. ~/.soul-hub/.env with SOUL_HUB_SECRET ─────────────────────
step "Configuring secrets file"
ENV_FILE="$SOUL_HUB_HOME/.env"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

if grep -q "^SOUL_HUB_SECRET=" "$ENV_FILE" 2>/dev/null; then
  ok "$ENV_FILE (SOUL_HUB_SECRET already set)"
else
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  printf "SOUL_HUB_SECRET=%s\n" "$SECRET" >> "$ENV_FILE"
  ok "Generated SOUL_HUB_SECRET in $ENV_FILE"
fi

# ── 7. ~/.claude/CLAUDE.md vault block ────────────────────────────
step "Wiring vault into ~/.claude/CLAUDE.md"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
mkdir -p "$CLAUDE_DIR"
[ -f "$CLAUDE_MD" ] || touch "$CLAUDE_MD"

ACTION=$(node - "$CLAUDE_MD" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const START = '<!-- soul-hub:start -->';
const END = '<!-- soul-hub:end -->';

const block = `${START}
## Soul Hub — Knowledge Context

Before non-trivial work (feature builds, debugging, architecture decisions),
check the vault for prior learnings via the Soul Hub vault API:

\`\`\`bash
# Full-text search (MiniSearch) over every note
curl -s "http://localhost:2400/api/vault/notes?q=your+topic&limit=5"

# Filter by project / type / tag
curl -s "http://localhost:2400/api/vault/notes?project=soul-hub&type=decision&limit=10"

# Note details (frontmatter, body, outgoing links)
curl -s "http://localhost:2400/api/vault/notes/<path>"

# Structural questions (graph, links, neighbors)
curl -s "http://localhost:2400/api/vault/graph?node=<path>"
\`\`\`

**When to check:** before debugging (someone may have hit it before), before
architecture decisions (an ADR may exist), before building features in Soul Hub
or your projects (project-specific patterns may already be documented).

**When to skip:** quick questions, recipe searches, media generation, or when
the user says to skip. Also skip if Soul Hub isn't running on \`:2400\` — the
API needs the server up.
${END}`;

const txt = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const s = txt.indexOf(START);
const e = txt.indexOf(END);

let next, action;
if (s !== -1 && e !== -1 && e > s) {
  next = txt.slice(0, s) + block + txt.slice(e + END.length);
  action = next === txt ? 'unchanged' : 'updated';
} else {
  const sep = txt.length === 0 ? '' : (txt.endsWith('\n\n') ? '' : (txt.endsWith('\n') ? '\n' : '\n\n'));
  next = txt + sep + block + '\n';
  action = 'added';
}

if (next !== txt) fs.writeFileSync(file, next);
process.stdout.write(action);
NODE
)

case "$ACTION" in
  added)     ok "$CLAUDE_MD (soul-hub block added)" ;;
  updated)   ok "$CLAUDE_MD (soul-hub block updated)" ;;
  unchanged) ok "$CLAUDE_MD (soul-hub block already current)" ;;
  *)         warn "Could not patch $CLAUDE_MD (action: ${ACTION:-unknown})" ;;
esac

# ── 7b. ~/.claude/rules/vault.md — vault write-side rule ────────
# The read-side rule lives in CLAUDE.md (step 7 above). The write-side
# rule — what to save to vault vs memory-only, the pointer pattern, the
# template list — lives in ~/.claude/rules/vault.md so Claude Code loads
# it as an always-loaded rule (mirrors rules/testing.md + rules/git.md).
# Soul Hub ships the canonical copy at scripts/templates/claude-rules-vault.md.
step "Seeding ~/.claude/rules/vault.md (write-side vault discipline)"
RULES_DIR="$CLAUDE_DIR/rules"
RULES_VAULT="$RULES_DIR/vault.md"
TEMPLATE_VAULT="$REPO_ROOT/scripts/templates/claude-rules-vault.md"
mkdir -p "$RULES_DIR"
if [ ! -f "$TEMPLATE_VAULT" ]; then
  warn "Template missing: $TEMPLATE_VAULT (skipped)"
elif [ -f "$RULES_VAULT" ]; then
  # File exists — only overwrite if Soul Hub manages it (header marker
  # present). Hand-edited rule files are left alone so operators can
  # customize without losing their work on re-bootstrap.
  if grep -q "^# Vault-first long-term memory$" "$RULES_VAULT"; then
    if cmp -s "$TEMPLATE_VAULT" "$RULES_VAULT"; then
      ok "$RULES_VAULT (already current)"
    else
      cp "$TEMPLATE_VAULT" "$RULES_VAULT"
      ok "$RULES_VAULT (updated to current template)"
    fi
  else
    warn "$RULES_VAULT exists and looks hand-edited — left untouched"
  fi
else
  cp "$TEMPLATE_VAULT" "$RULES_VAULT"
  ok "$RULES_VAULT (installed)"
fi

# ── 8. Vault git history (ADR-019) ───────────────────────────────
step "Initializing vault git repo"
if [ -d "$VAULT_DIR_DEFAULT/.git" ]; then
  ok "$VAULT_DIR_DEFAULT/.git (already initialized)"
else
  # Write .gitignore first — six rules cover the whole vault.
  cat > "$VAULT_DIR_DEFAULT/.gitignore" <<'GITIGNORE'
# Soul Hub vault metadata — regenerated, machine-local
.vault/mtime-cache.json

# macOS noise
.DS_Store
**/.DS_Store

# Vault trash zone — already-deleted notes
.trash/

# Retired Obsidian workspace (defensive — kept ignored in case of re-install)
.obsidian/

# SQLite runtime artifacts (write-active DBs in project subfolders)
*.db
*.db-wal
*.db-shm
GITIGNORE

  git -C "$VAULT_DIR_DEFAULT" init -b main >/dev/null 2>&1 || \
    git -C "$VAULT_DIR_DEFAULT" init >/dev/null

  # Mirror global git identity into the vault repo if available, so the
  # initial commit (and event-driven commits from src/lib/vault/committer.ts)
  # don't fail with "please tell me who you are".
  GLOBAL_NAME=$(git config --global --get user.name 2>/dev/null || true)
  GLOBAL_EMAIL=$(git config --global --get user.email 2>/dev/null || true)

  if [ -n "$GLOBAL_NAME" ] && [ -n "$GLOBAL_EMAIL" ]; then
    git -C "$VAULT_DIR_DEFAULT" config user.name "$GLOBAL_NAME"
    git -C "$VAULT_DIR_DEFAULT" config user.email "$GLOBAL_EMAIL"
    git -C "$VAULT_DIR_DEFAULT" add -A
    if ! git -C "$VAULT_DIR_DEFAULT" diff --cached --quiet ; then
      git -C "$VAULT_DIR_DEFAULT" commit -m "vault: initial commit" >/dev/null
      ok "$VAULT_DIR_DEFAULT/.git (initialized + initial commit)"
    else
      ok "$VAULT_DIR_DEFAULT/.git (initialized — empty vault, no initial commit)"
    fi
  else
    warn "$VAULT_DIR_DEFAULT/.git initialized but global git identity is unset"
    warn "Set: git config --global user.name '...' && git config --global user.email '...'"
    warn "Then re-run this script — the initial commit will be created."
  fi
fi

# ── 8b. Vault chokepoint (ADR-046 / 047 / 048 / 049 / 050) ──────
# Wires the Claude Code hooks (L1+L2), /vault-write skill, and vault
# pre-commit hook (L4). Idempotent — installer handles already-current
# state internally. L3 + L5 are code-resident (no install step).
step "Installing vault chokepoint"
if bash "$REPO_ROOT/scripts/install-chokepoint.sh" --quiet --symlink; then
  ok "chokepoint installed (L1, L2, /vault-write skill, L4)"
else
  warn "chokepoint installer reported issues — run: bash scripts/install-chokepoint.sh"
fi

# ── 8c. Soul Hub CLI (ADR-001, soul-hub-cli) ────────────────────
# Thin agent-facing bash CLI on top of the API. Symlinked into
# ~/.local/bin/soul. Soft-fail like the chokepoint above.
step "Installing Soul Hub CLI (soul)"
if bash "$REPO_ROOT/install/cli/install.sh" --quiet --symlink; then
  ok "soul CLI installed → ~/.local/bin/soul (try: soul --help)"
else
  warn "soul CLI installer reported issues — run: bash install/cli/install.sh"
fi

# ── 9. Optional: TikTok transcription deps (ADR-024) ────────────
step "Optional: TikTok transcription deps"
if command -v yt-dlp >/dev/null 2>&1 \
  && command -v ffmpeg >/dev/null 2>&1 \
  && command -v whisper-cli >/dev/null 2>&1 \
  && [ -f "${WHISPER_MODEL_BASE_DIR:-$HOME/.cache/whisper-cpp}/ggml-base.bin" ]; then
  ok "TikTok deps already installed (yt-dlp + ffmpeg + whisper-cli + ggml-base.bin)"
else
  case "$WITH_TIKTOK" in
    yes)
      bash "$REPO_ROOT/scripts/install-tiktok-deps.sh"
      ;;
    no)
      ok "Skipped (--no-tiktok)"
      ;;
    auto)
      if [ -t 0 ] && [ -t 1 ] && [ -z "${CI:-}" ]; then
        printf "  TikTok transcription needs ~250 MB of extra deps (yt-dlp, ffmpeg, whisper.cpp, ggml-base.bin).\n"
        printf "  Install now? [y/%sN%s] " "$BOLD" "$RST"
        read -r ans </dev/tty || ans=""
        case "$ans" in
          y|Y|yes|YES) bash "$REPO_ROOT/scripts/install-tiktok-deps.sh" ;;
          *) ok "Skipped — re-run with --with-tiktok later, or: bash scripts/install-tiktok-deps.sh" ;;
        esac
      else
        ok "Skipped (non-interactive — pass --with-tiktok to install, or run: bash scripts/install-tiktok-deps.sh)"
      fi
      ;;
  esac
fi

# ── 10. Final summary ────────────────────────────────────────────
echo
printf "%sBootstrap complete.%s\n\n" "$GRN$BOLD" "$RST"
printf "Next steps:\n"
printf "  %sDev mode:%s         npm run dev          (http://localhost:5173)\n" "$BOLD" "$RST"
printf "  %sProduction mode:%s  npm run build && npm run prod:start  (http://localhost:2400)\n" "$BOLD" "$RST"
printf "  %sHealth check:%s     npm run doctor\n\n" "$BOLD" "$RST"

if [ -z "$CLAUDE_PATH" ]; then
  printf "%sReminder:%s install Claude Code CLI, then run %snpm run doctor%s to verify.\n\n" "$YLW" "$RST" "$BOLD" "$RST"
fi
