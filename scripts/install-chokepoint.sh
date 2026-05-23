#!/usr/bin/env bash
# scripts/install-chokepoint.sh — ADR-050 vault chokepoint installer.
#
# Wires the four out-of-repo artifacts of the vault-write defense stack:
#   L1  Claude Code Write/Edit/NotebookEdit hook  (ADR-046 Pass 1)
#   L2  Claude Code Bash hook                     (ADR-046 Pass 2)
#   /vault-write skill                            (ADR-046 redirect target)
#   L4  Vault pre-commit hook                     (ADR-048)
#
# L3 (link validator) and L5 (scaffold_stubs) ship in the soul-hub code —
# no install step here. They run as soon as the soul-hub server boots.
#
# Idempotent. macOS + Linux. Bails on Windows-native (use WSL2). Called
# standalone or from bootstrap.sh.
#
# Usage:
#   bash scripts/install-chokepoint.sh           # symlink (recommended)
#   bash scripts/install-chokepoint.sh --copy    # copy instead
#   bash scripts/install-chokepoint.sh --verify  # smoke-test all 5 layers
#   bash scripts/install-chokepoint.sh --quiet   # minimal output (for bootstrap)

set -euo pipefail

# ── colors ──────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YLW=$(printf '\033[33m'); BLU=$(printf '\033[34m')
  RST=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi

QUIET=0
step() { [ "$QUIET" = "1" ] || printf "%s==>%s %s\n" "$BLU$BOLD" "$RST" "$1"; }
ok()   { [ "$QUIET" = "1" ] || printf "  %s✓%s %s\n"   "$GRN" "$RST" "$1"; }
warn() {                       printf "  %s!%s %s\n"   "$YLW" "$RST" "$1"; }
err()  {                       printf "  %s✗%s %s\n"   "$RED" "$RST" "$1" >&2; }
die()  { err "$1"; exit 1; }

# ── args ────────────────────────────────────────────────────────
MODE=symlink
VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --copy)    MODE=copy ;;
    --symlink) MODE=symlink ;;
    --verify)  VERIFY=1 ;;
    --quiet)   QUIET=1 ;;
    -h|--help)
      sed -n '2,21p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown flag: $arg" ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="$REPO_ROOT/install"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
VAULT_DIR="${VAULT_DIR:-$HOME/vault}"

# ── 0. OS + prerequisites ───────────────────────────────────────
step "Checking platform + prerequisites"

case "$(uname -s)" in
  Darwin|Linux) ok "OS: $(uname -s)" ;;
  MINGW*|MSYS*|CYGWIN*)
    die "Windows native is not supported. Use WSL2 (Ubuntu) — see INSTALL.md."
    ;;
  *) warn "Unrecognised OS: $(uname -s) — proceeding optimistically" ;;
esac

for cmd in python3 git jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "missing prerequisite: $cmd"
  fi
done
ok "python3 $(python3 --version 2>&1 | awk '{print $2}'), git $(git --version | awk '{print $3}'), jq $(jq --version)"

# Sanity: install/ tree exists
for f in \
  "$INSTALL_DIR/hooks/vault-write-guard.sh" \
  "$INSTALL_DIR/hooks/vault-write-guard-bash.sh" \
  "$INSTALL_DIR/hooks/soul-cli-guard.sh" \
  "$INSTALL_DIR/hooks/vault-pre-commit" \
  "$INSTALL_DIR/hooks/vault-pre-commit-install.sh" \
  "$INSTALL_DIR/skills/vault-write/SKILL.md" \
  "$INSTALL_DIR/claude-settings.snippet.json"
do
  [ -f "$f" ] || die "canonical source missing: $f"
done
ok "install/ tree complete"

# ── 1. Deploy L1 + L2 hooks into ~/.claude/hooks ────────────────
step "Deploying Claude Code hooks (L1 + L2)"
mkdir -p "$CLAUDE_HOME/hooks"

deploy() {
  # $1 = source under install/, $2 = target name under ~/.claude/
  local src="$INSTALL_DIR/$1"
  local target="$CLAUDE_HOME/$2"

  if [ "$MODE" = "symlink" ]; then
    # Idempotent symlink — replace if it points elsewhere
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$src" ]; then
      ok "$2 (symlink already current)"
      return
    fi
    if [ -e "$target" ] || [ -L "$target" ]; then
      mv "$target" "$target.bak.$(date +%s)"
      warn "$2 backed up → $target.bak.<ts>"
    fi
    ln -s "$src" "$target"
    ok "$2 → $src (symlinked)"
  else
    # Copy mode — overwrite if content differs
    if [ -f "$target" ] && cmp -s "$src" "$target"; then
      ok "$2 (copy already current)"
      return
    fi
    if [ -e "$target" ] && [ ! -f "$target" ]; then
      die "$target exists and is not a regular file — refusing to overwrite"
    fi
    cp "$src" "$target"
    chmod +x "$target"
    ok "$2 ← $src (copied)"
  fi
}

deploy "hooks/vault-write-guard.sh"      "hooks/vault-write-guard.sh"
deploy "hooks/vault-write-guard-bash.sh" "hooks/vault-write-guard-bash.sh"
deploy "hooks/soul-cli-guard.sh"         "hooks/soul-cli-guard.sh"

# Source files must be executable regardless of mode (symlink target also
# needs +x because the runtime invokes the linked path).
chmod +x "$INSTALL_DIR/hooks/vault-write-guard.sh" \
         "$INSTALL_DIR/hooks/vault-write-guard-bash.sh" \
         "$INSTALL_DIR/hooks/soul-cli-guard.sh"

# ── 2. Merge PreToolUse block into ~/.claude/settings.json ──────
step "Registering hooks in ~/.claude/settings.json"

SETTINGS="$CLAUDE_HOME/settings.json"

python3 - "$SETTINGS" "$INSTALL_DIR/claude-settings.snippet.json" <<'PY'
import json, os, sys, shutil, time
settings_path, snippet_path = sys.argv[1], sys.argv[2]
try:
    s = json.load(open(settings_path))
    original = json.dumps(s, sort_keys=True)
    existed = True
except FileNotFoundError:
    s = {}
    original = None
    existed = False
except json.JSONDecodeError as e:
    print(f"ERROR: {settings_path} is not valid JSON: {e}", file=sys.stderr)
    sys.exit(1)

snippet = json.load(open(snippet_path))
needed = snippet.get("hooks", {}).get("PreToolUse", [])

s.setdefault("hooks", {}).setdefault("PreToolUse", [])
existing = s["hooks"]["PreToolUse"]

added = []
for entry in needed:
    target_cmd = entry["hooks"][0]["command"]
    if any(target_cmd in (h.get("command", "") for h in (e.get("hooks") or []))
           for e in existing):
        continue
    existing.append(entry)
    added.append(entry["matcher"])

if added or not existed:
    if existed:
        shutil.copy(settings_path, f"{settings_path}.bak.{int(time.time())}")
    with open(settings_path, "w") as f:
        json.dump(s, f, indent=2)
        f.write("\n")
    if added:
        print(f"  added matchers: {', '.join(added)} (backup written)")
    else:
        print("  created new settings.json")
else:
    print("  all matchers already registered (no write)")
PY

ok "settings.json merge complete"

# ── 3. Deploy /vault-write skill ────────────────────────────────
step "Deploying /vault-write skill"
mkdir -p "$CLAUDE_HOME/skills"

SKILL_TARGET="$CLAUDE_HOME/skills/vault-write"
SKILL_SRC="$INSTALL_DIR/skills/vault-write"

if [ "$MODE" = "symlink" ]; then
  if [ -L "$SKILL_TARGET" ] && [ "$(readlink "$SKILL_TARGET")" = "$SKILL_SRC" ]; then
    ok "vault-write (symlink already current)"
  else
    if [ -e "$SKILL_TARGET" ] || [ -L "$SKILL_TARGET" ]; then
      mv "$SKILL_TARGET" "$SKILL_TARGET.bak.$(date +%s)"
      warn "vault-write backed up"
    fi
    ln -s "$SKILL_SRC" "$SKILL_TARGET"
    ok "vault-write → $SKILL_SRC (symlinked)"
  fi
else
  # Copy mode — replace dir each time (skill is small + self-contained)
  if [ -e "$SKILL_TARGET" ] && [ ! -d "$SKILL_TARGET" ]; then
    die "$SKILL_TARGET exists and is not a directory"
  fi
  rm -rf "$SKILL_TARGET"
  cp -R "$SKILL_SRC" "$SKILL_TARGET"
  ok "vault-write ← $SKILL_SRC (copied)"
fi

chmod +x "$INSTALL_DIR/skills/vault-write/scripts/vault-write.sh"

# ── 4. Vault pre-commit hook (L4) ───────────────────────────────
step "Installing vault pre-commit hook"

if [ ! -d "$VAULT_DIR" ]; then
  warn "$VAULT_DIR does not exist — skipping L4 (re-run after vault is created)"
elif [ ! -d "$VAULT_DIR/.git" ]; then
  warn "$VAULT_DIR is not a git repo — skipping L4 (init the vault first)"
else
  mkdir -p "$VAULT_DIR/.vault/hooks"

  # Always refresh the in-vault canonical from soul-hub's install/. The vault
  # itself is the source-of-truth for the hook AT RUNTIME (because operators
  # may clone the vault separately on another machine), but soul-hub holds
  # the version that gets seeded. cmp avoids needless mtime churn.
  for f in "vault-pre-commit:pre-commit" "vault-pre-commit-install.sh:install.sh"; do
    src_name="${f%:*}"; dest_name="${f#*:}"
    src="$INSTALL_DIR/hooks/$src_name"
    dest="$VAULT_DIR/.vault/hooks/$dest_name"
    if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
      ok "vault $dest_name (already current)"
    else
      cp "$src" "$dest"
      chmod +x "$dest"
      ok "vault $dest_name ← $src"
    fi
  done

  # Run the in-vault installer (it resolves vault root from its own location)
  bash "$VAULT_DIR/.vault/hooks/install.sh" | sed 's/^/    /'
fi

# ── 5. Verification ─────────────────────────────────────────────
if [ "$VERIFY" = "1" ]; then
  step "Smoke-testing all 5 layers"
  TODAY=$(date +%Y-%m-%d)
  API_BASE="${SOUL_HUB_URL:-http://localhost:2400}"
  FAIL=0

  if ! curl -fsS "$API_BASE/api/vault/health" -o /dev/null 2>&1; then
    warn "soul-hub not reachable at $API_BASE — L3/L5 verifications skipped"
  else
    # L3 — auto-memory wikilink → API REFUSE
    body=$(printf '{"zone":"inbox","filename":"chokepoint-smoke-l3.md","meta":{"type":"draft","created":"%s","tags":["smoke-test","auto-generated"],"source_agent":"install-chokepoint"},"content":"# L3 smoke\\n[[feedback_smoke_test]]"}' "$TODAY")
    resp=$(curl -fsS -X POST "$API_BASE/api/vault/notes" -H 'Content-Type: application/json' -d "$body" || true)
    if echo "$resp" | jq -e '.success == false and (.error | contains("auto-memory"))' >/dev/null 2>&1; then
      ok "L3 (API REFUSE auto-memory): blocked as expected"
    else
      err "L3 (API REFUSE): unexpected response: $resp"; FAIL=1
    fi

    # L5 — scaffold_stubs creates a stub
    body=$(printf '{"zone":"inbox","filename":"chokepoint-smoke-l5.md","meta":{"type":"draft","created":"%s","tags":["smoke-test","auto-generated"],"scaffold_stubs":true,"source_agent":"install-chokepoint"},"content":"# L5 smoke\\n[[chokepoint-smoke-target]]"}' "$TODAY")
    resp=$(curl -fsS -X POST "$API_BASE/api/vault/notes" -H 'Content-Type: application/json' -d "$body" || true)
    if echo "$resp" | jq -e '.stubs_created | length == 1' >/dev/null 2>&1; then
      ok "L5 (scaffold_stubs): 1 stub created as expected"
    else
      err "L5 (scaffold_stubs): unexpected response: $resp"; FAIL=1
    fi

    # Cleanup
    curl -fsS -X DELETE "$API_BASE/api/vault/notes/inbox/chokepoint-smoke-l5.md" -o /dev/null 2>&1 || true
    curl -fsS -X DELETE "$API_BASE/api/vault/notes/inbox/chokepoint-smoke-target.md" -o /dev/null 2>&1 || true
  fi

  # L4 — pre-commit hook present + executable
  if [ -L "$VAULT_DIR/.git/hooks/pre-commit" ] || [ -f "$VAULT_DIR/.git/hooks/pre-commit" ]; then
    ok "L4 (pre-commit): installed at $VAULT_DIR/.git/hooks/pre-commit"
  else
    err "L4 (pre-commit): not installed"; FAIL=1
  fi

  # L1+L2 verification requires a live Claude Code session — print guidance
  warn "L1/L2 require a running Claude Code session — see INSTALL.md §Verify all five layers"

  if [ "$FAIL" = "0" ]; then
    printf "\n%s✓ verifiable layers passed%s\n" "$GRN$BOLD" "$RST"
  else
    printf "\n%s✗ one or more layers failed — see errors above%s\n" "$RED$BOLD" "$RST" >&2
    exit 1
  fi
fi

# ── 6. Summary ──────────────────────────────────────────────────
if [ "$QUIET" = "1" ]; then
  exit 0
fi

echo
printf "%sChokepoint installed.%s (mode: %s)\n" "$GRN$BOLD" "$RST" "$MODE"
printf "Layers wired: L1, L2, /vault-write skill, L4. L3 and L5 are code-resident.\n\n"
printf "Verify in a fresh Claude Code session: try to %sWrite%s under %s$VAULT_DIR/%s — expect block.\n" "$BOLD" "$RST" "$DIM" "$RST"
printf "Full gauntlet:  %sbash scripts/install-chokepoint.sh --verify%s\n" "$BOLD" "$RST"
