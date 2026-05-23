#!/usr/bin/env bash
# install/cli/install.sh — Soul Hub CLI installer (ADR-001, soul-hub-cli).
#
# Symlinks the `soul` shim from this repo into a directory on the user's PATH
# (default ~/.local/bin) so the CLI is invocable from any shell. Mirrors
# ADR-050's chokepoint installer pattern: symlink by default, `--copy` for
# environments where symlinks are awkward, `--verify` for post-install smoke,
# `--quiet` for bootstrap chaining.
#
# Idempotent. macOS + Linux. Bails on Windows-native (use WSL2).
#
# Usage:
#   bash install/cli/install.sh           # symlink (recommended)
#   bash install/cli/install.sh --copy    # copy instead
#   bash install/cli/install.sh --verify  # smoke-test the installed binary
#   bash install/cli/install.sh --quiet   # minimal output (for bootstrap)

set -euo pipefail

# ── colors ──────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); RED=$(printf '\033[31m'); GRN=$(printf '\033[32m')
  YLW=$(printf '\033[33m'); BLU=$(printf '\033[34m'); RST=$(printf '\033[0m')
else
  BOLD=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
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
      sed -n '2,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown flag: $arg" ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_SRC="$REPO_ROOT/cli/soul"
BIN_DIR="${SOUL_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/soul"

# ── 0. OS + prerequisites ───────────────────────────────────────
step "Checking platform + prerequisites"

case "$(uname -s)" in
  Darwin|Linux) ok "OS: $(uname -s)" ;;
  MINGW*|MSYS*|CYGWIN*)
    die "Windows native not supported. Use WSL2 (Ubuntu) — see INSTALL.md."
    ;;
  *) warn "Unrecognised OS: $(uname -s) — proceeding optimistically" ;;
esac

command -v node >/dev/null 2>&1 || die "missing prerequisite: node (>=22.6 for --experimental-strip-types)"

NODE_MAJOR=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "node $NODE_MAJOR is too old. Need >=22.6 for --experimental-strip-types."
fi
ok "node $(node --version)"

[ -f "$CLI_SRC" ] || die "canonical source missing: $CLI_SRC"
[ -x "$CLI_SRC" ] || chmod +x "$CLI_SRC"
ok "cli/soul present + executable"

# ── 1. Install to ~/.local/bin (or $SOUL_BIN_DIR) ───────────────
step "Installing CLI to $BIN_DIR"

mkdir -p "$BIN_DIR"

if [ "$MODE" = "symlink" ]; then
  if [ -L "$TARGET" ] && [ "$(readlink "$TARGET")" = "$CLI_SRC" ]; then
    ok "$TARGET (symlink already current)"
  else
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
      mv "$TARGET" "$TARGET.bak.$(date +%s)"
      warn "$TARGET backed up → $TARGET.bak.<ts>"
    fi
    ln -s "$CLI_SRC" "$TARGET"
    ok "$TARGET → $CLI_SRC (symlinked)"
  fi
else
  if [ -f "$TARGET" ] && cmp -s "$CLI_SRC" "$TARGET"; then
    ok "$TARGET (copy already current)"
  else
    if [ -e "$TARGET" ] && [ ! -f "$TARGET" ]; then
      die "$TARGET exists and is not a regular file — refusing to overwrite"
    fi
    cp "$CLI_SRC" "$TARGET"
    chmod +x "$TARGET"
    ok "$TARGET ← $CLI_SRC (copied)"
  fi
fi

# ── 2. PATH check ───────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;;
  *) warn "$BIN_DIR is not on PATH — add to ~/.zshrc or ~/.bashrc:"
     printf "    export PATH=\"\$HOME/.local/bin:\$PATH\"\n" ;;
esac

# ── 3. Verify (optional) ────────────────────────────────────────
if [ "$VERIFY" = "1" ]; then
  step "Verifying installation"
  if "$TARGET" --version >/dev/null 2>&1; then
    ok "soul --version: $("$TARGET" --version)"
  else
    die "$TARGET --version failed"
  fi
  if "$TARGET" doctor >/dev/null 2>&1; then
    ok "soul doctor: all checks pass"
  else
    warn "soul doctor reports issues — run \`$TARGET doctor\` for details"
  fi
fi

[ "$QUIET" = "1" ] || printf "\n%s✓%s Soul Hub CLI installed.\n" "$GRN$BOLD" "$RST"
[ "$QUIET" = "1" ] || printf "  Try:  %ssoul --help%s   |  %ssoul doctor%s\n" "$BOLD" "$RST" "$BOLD" "$RST"
