#!/usr/bin/env bash
# Daily soul-hub git push — invoked by Soul Hub scheduler task
# `soul-hub-backup-daily`. Mirrors the safety-net intent of
# `vault-backup-daily.sh` (ADR-019) for the code repo.
#
# CRITICAL DIFFERENCE from vault-backup-daily: this repo is
# operator-driven (no event-driven commits). Auto-staging would commit
# half-done work-in-progress. So this script is strictly PUSH-ONLY —
# it only flushes committed-but-unpushed main work to origin/main.
#
# Only `main` is auto-pushed. Feature branches remain operator-driven.
#
# Push failures (network blip, auth issue, GitHub down) emit a warning
# but DO NOT fail the script — the next day's run will catch up.
#
# Reads SOUL_HUB_REPO from env (set by scheduler) or falls back to the
# script's parent directory.

set -euo pipefail

SOUL_HUB_REPO="${SOUL_HUB_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"

if [ ! -d "$SOUL_HUB_REPO/.git" ]; then
  echo "[soul-hub-backup-daily] $SOUL_HUB_REPO is not a git repo" >&2
  exit 1
fi

if ! git -C "$SOUL_HUB_REPO" remote get-url origin >/dev/null 2>&1; then
  echo "[soul-hub-backup-daily] no 'origin' remote configured — skipping push"
  exit 0
fi

# Fetch first so the ahead-count reflects origin truth. Soft-fail: a
# fetch failure shouldn't block a push attempt — push has its own
# error handling.
git -C "$SOUL_HUB_REPO" fetch --quiet origin main || true

AHEAD="$(git -C "$SOUL_HUB_REPO" rev-list --count origin/main..main 2>/dev/null || echo "?")"

if [ "$AHEAD" = "0" ]; then
  echo "[soul-hub-backup-daily] main is up-to-date with origin (0 commits ahead)"
  exit 0
fi

if git -C "$SOUL_HUB_REPO" push --quiet origin main 2>&1; then
  echo "[soul-hub-backup-daily] pushed ${AHEAD} commit(s) to origin/main"
else
  echo "[soul-hub-backup-daily] push to origin failed — next run will retry" >&2
fi
