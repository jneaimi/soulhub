#!/usr/bin/env bash
# install/agents/install.sh — Soul Hub starter agents.
#
# Seeds a small starter set — one agent per dispatch backend ("flavor") — so a
# fresh install has something to dispatch:
#   assistant  (claude-pty)         → Lane A  ~/.claude/agents/
#   researcher (claude-stream-json) → Lane A
#   summarizer (claude-cli-flag)    → Lane A
#   drafter    (ai-sdk, BYOK)       → Lane B  ~/.soul-hub/data/agents/
#
# COPIES (not symlinks) — these are starter templates you're meant to edit.
# Conservative by default: a lane is seeded ONLY if it has no agents yet, so an
# operator with their own agents is never polluted. --force copies regardless,
# skipping any file that already exists (never clobbers your edits).
#
# Idempotent. macOS + Linux.
#
# Usage:
#   bash install/agents/install.sh          # seed empty lanes only
#   bash install/agents/install.sh --force  # copy into non-empty lanes too (skip existing)
#   bash install/agents/install.sh --quiet  # minimal output (for bootstrap)

set -euo pipefail

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

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \?//'; exit 0 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SOUL_HUB_HOME="${SOUL_HUB_HOME:-$HOME/.soul-hub}"
LANE_A_DIR="${SOUL_HUB_LANE_A_DIR:-$HOME/.claude/agents}"
LANE_B_DIR="${SOUL_HUB_LANE_B_DIR:-$SOUL_HUB_HOME/data/agents}"

# seed_lane <src-subdir> <glob> <target-dir> <label>
seed_lane() {
  local src="$SRC_DIR/$1" glob="$2" target="$3" label="$4"
  [ -d "$src" ] || { warn "$label: source $src missing — skipped"; return; }

  mkdir -p "$target"
  # Count existing agents in the target lane.
  local existing
  existing=$(find "$target" -maxdepth 1 -name "$glob" -type f 2>/dev/null | wc -l | tr -d ' ')

  if [ "$existing" -gt 0 ] && [ "$FORCE" != "1" ]; then
    ok "$label: $existing agent(s) already present — left untouched (use --force to add starters)"
    return
  fi

  local copied=0 skipped=0
  for f in "$src"/$glob; do
    [ -e "$f" ] || continue
    local base; base="$(basename "$f")"
    if [ -e "$target/$base" ]; then
      skipped=$((skipped+1)); continue
    fi
    cp "$f" "$target/$base"
    copied=$((copied+1))
  done
  ok "$label: copied $copied → $target${skipped:+ ($skipped already present, skipped)}"
}

step "Seeding starter agents"
seed_lane "lane-a" "*.md"   "$LANE_A_DIR" "Lane A (~/.claude/agents)"
seed_lane "lane-b" "*.yaml" "$LANE_B_DIR" "Lane B (~/.soul-hub/data/agents)"

[ "$QUIET" = "1" ] || printf "\n%sStarter agents ready.%s Open /agents in the UI, or dispatch from chat.\n" "$GRN$BOLD" "$RST"
