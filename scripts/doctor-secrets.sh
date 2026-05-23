#!/bin/bash
# Soul Hub — secrets doctor
#
# Walks the six entry points that should all see ~/.soul-hub/.env and reports
# any drift. Read-only — never modifies anything. Exits non-zero on any FAIL
# so it can be wired into CI / `npm run check` later.
#
# Usage:
#   ./scripts/doctor-secrets.sh
#   ./scripts/doctor-secrets.sh --quiet   # only print failures
#   SOUL_HUB_HOME=/tmp/test ./scripts/doctor-secrets.sh   # override home

set -u

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

HOME_DIR="${SOUL_HUB_HOME:-$HOME/.soul-hub}"
ENV_FILE="$HOME_DIR/.env"
ENV_BAK="$HOME_DIR/.env.bak"
SETTINGS_FILE="$HOME_DIR/settings.json"
ZSHRC="$HOME/.zshrc"
ECOSYSTEM_FILE=""
# Locate the Soul Hub repo from this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[[ -f "$REPO_DIR/ecosystem.config.cjs" ]] && ECOSYSTEM_FILE="$REPO_DIR/ecosystem.config.cjs"

PASS=0
FAIL=0
WARN=0

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'

ok()    { PASS=$((PASS+1)); [[ $QUIET == 0 ]] && printf "  %sOK%s   %s\n" "$c_grn" "$c_off" "$1"; }
fail()  { FAIL=$((FAIL+1)); printf "  %sFAIL%s %s\n" "$c_red" "$c_off" "$1"; }
warn()  { WARN=$((WARN+1)); [[ $QUIET == 0 ]] && printf "  %sWARN%s %s\n" "$c_yel" "$c_off" "$1"; }
note()  { [[ $QUIET == 0 ]] && printf "  %s%s%s\n" "$c_dim" "$1" "$c_off"; }

section() {
  [[ $QUIET == 0 ]] && printf "\n%s\n" "$1"
}

# ─────────────────────────────────────────────────────────────────────────
section "1. Home directory ($HOME_DIR)"
if [[ -d "$HOME_DIR" ]]; then
  ok "directory exists"
  mode=$(stat -f "%Lp" "$HOME_DIR" 2>/dev/null || stat -c "%a" "$HOME_DIR" 2>/dev/null)
  if [[ "$mode" == "700" ]]; then
    ok "mode is 0700"
  else
    warn "mode is 0$mode (expected 0700) — fix: chmod 700 \"$HOME_DIR\""
  fi
else
  fail "directory missing — run the setup wizard or 'mkdir -p $HOME_DIR'"
fi

# ─────────────────────────────────────────────────────────────────────────
section "2. settings.json ($SETTINGS_FILE)"
if [[ -f "$SETTINGS_FILE" ]]; then
  ok "file exists"
else
  fail "missing — Soul Hub will redirect to /setup until it's created"
fi

# ─────────────────────────────────────────────────────────────────────────
section "3. Secrets file ($ENV_FILE)"
if [[ -f "$ENV_FILE" ]]; then
  ok "file exists"
  mode=$(stat -f "%Lp" "$ENV_FILE" 2>/dev/null || stat -c "%a" "$ENV_FILE" 2>/dev/null)
  if [[ "$mode" == "600" ]]; then
    ok "mode is 0600"
  else
    fail "mode is 0$mode (expected 0600) — fix: chmod 600 \"$ENV_FILE\""
  fi
  count=$(grep -c "^[A-Z][A-Z0-9_]*=" "$ENV_FILE" 2>/dev/null || echo 0)
  note "$count keys defined"
  if [[ -f "$ENV_BAK" ]]; then
    ok ".env.bak rotation present"
  else
    note ".env.bak not yet created (rotates after first setSecret/removeSecret/syncFromShell)"
  fi
else
  warn "no secrets file yet — fine for fresh install; the wizard will create it"
fi

# ─────────────────────────────────────────────────────────────────────────
section "4. Shell wiring ($ZSHRC)"
if [[ -f "$ZSHRC" ]]; then
  if grep -qE '\.\s*"\$HOME/\.soul-hub/\.env"|\.\s*~/\.soul-hub/\.env|source\s+~/\.soul-hub/\.env|source\s+"\$HOME/\.soul-hub/\.env"' "$ZSHRC"; then
    ok "zshrc sources ~/.soul-hub/.env"
  else
    warn "zshrc does NOT source ~/.soul-hub/.env — append this line:"
    note '    set -a; [ -f "$HOME/.soul-hub/.env" ] && . "$HOME/.soul-hub/.env"; set +a'
  fi
else
  warn "$ZSHRC not found"
fi

# ─────────────────────────────────────────────────────────────────────────
section "5. PM2 ($ECOSYSTEM_FILE)"
if [[ -n "$ECOSYSTEM_FILE" && -f "$ECOSYSTEM_FILE" ]]; then
  if grep -q "env_file" "$ECOSYSTEM_FILE" && grep -q "soul-hub/\.env\|SECRETS_FILE" "$ECOSYSTEM_FILE"; then
    ok "ecosystem.config.cjs declares env_file pointing at ~/.soul-hub/.env"
  else
    fail "ecosystem.config.cjs does NOT declare env_file — child processes won't see secrets"
  fi
else
  warn "ecosystem.config.cjs not found at $REPO_DIR — running outside the repo?"
fi

# ─────────────────────────────────────────────────────────────────────────
section "6. launchd plists ($HOME/Library/LaunchAgents)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
USER_HOME_PREFIX="/Users/$USER/"
# Only check plists that run user-owned scripts. Anything that only invokes
# a system/vendor binary (Dropbox, Google updater, Adobe, etc.) is skipped —
# those don't run our pipelines and shouldn't see our secrets.
if [[ -d "$LAUNCH_DIR" ]]; then
  shopt -s nullglob
  active_plists=("$LAUNCH_DIR"/*.plist)
  shopt -u nullglob
  if (( ${#active_plists[@]} == 0 )); then
    note "no .plist files in $LAUNCH_DIR — nothing to check"
  else
    user_owned=0
    for plist in "${active_plists[@]}"; do
      label="$(basename "$plist" .plist)"
      # Heuristic: a "user-owned" plist references a path under /Users/$USER/
      # in its ProgramArguments that is NOT inside ~/Library/. Vendor agents
      # (Dropbox, Google updater, etc.) install themselves under ~/Library/
      # and shouldn't see our secrets.
      if ! grep -E "$USER_HOME_PREFIX" "$plist" | grep -vqE "$USER_HOME_PREFIX(Library|Applications)/"; then
        continue
      fi
      user_owned=$((user_owned+1))
      if grep -q "soul-hub/.env" "$plist"; then
        ok "$label sources ~/.soul-hub/.env"
      else
        warn "$label does NOT source ~/.soul-hub/.env"
        note "    wrap ProgramArguments with /bin/sh -c \"set -a; . \$HOME/.soul-hub/.env; set +a; exec ...\""
      fi
    done
    if (( user_owned == 0 )); then
      note "no user-owned plists found (skipping vendor agents)"
    fi
  fi
else
  note "no LaunchAgents directory"
fi

# ─────────────────────────────────────────────────────────────────────────
section "Summary"
printf "  %s%d pass%s · %s%d warn%s · %s%d fail%s\n" \
  "$c_grn" "$PASS" "$c_off" \
  "$c_yel" "$WARN" "$c_off" \
  "$c_red" "$FAIL" "$c_off"

if (( FAIL > 0 )); then
  exit 1
fi
exit 0
