#!/usr/bin/env bash
# Daily vault git snapshot — invoked by Soul Hub scheduler task
# `vault-backup-daily` per ADR-019. Safety-net layer below the
# event-driven commits in src/lib/vault/committer.ts.
#
# Two responsibilities:
#   1. Stage + commit anything not yet covered by event-driven commits.
#   2. Push origin/main if a remote is configured (GitHub backup added
#      2026-05-16). The push happens UNCONDITIONALLY so any unpushed
#      event-driven commits from earlier in the day also get mirrored.
#
# Push failures (network blip, auth issue, GitHub down) emit a warning
# but DO NOT fail the script — the next day's run will catch up.
#
# Reads VAULT_DIR from env (set by scheduler) or falls back to ~/vault.

set -euo pipefail

VAULT_DIR="${VAULT_DIR:-$HOME/vault}"

if [ ! -d "$VAULT_DIR/.git" ]; then
  echo "[vault-backup-daily] $VAULT_DIR is not a git repo — run: bash scripts/bootstrap.sh" >&2
  exit 1
fi

git -C "$VAULT_DIR" add -A

if git -C "$VAULT_DIR" diff --cached --quiet ; then
  echo "[vault-backup-daily] no changes to commit (event-driven commits already covered today)"
else
  DATE_STAMP="$(date +%Y-%m-%d)"
  STAGED_COUNT="$(git -C "$VAULT_DIR" diff --cached --name-only | wc -l | tr -d ' ')"
  git -C "$VAULT_DIR" commit -m "vault: daily snapshot ${DATE_STAMP} (${STAGED_COUNT} files)"
  echo "[vault-backup-daily] committed ${STAGED_COUNT} files"
fi

# Push to GitHub backup remote if one is configured. Runs even when the
# commit above was a no-op, so unpushed event-driven commits from
# earlier in the day still flush. The `git remote get-url` returns
# non-zero if `origin` is missing — that's expected on vaults that
# haven't been backed up yet, and we exit gracefully.
if git -C "$VAULT_DIR" remote get-url origin >/dev/null 2>&1; then
  if git -C "$VAULT_DIR" push --quiet origin main 2>&1; then
    echo "[vault-backup-daily] pushed to origin/main"
  else
    echo "[vault-backup-daily] push to origin failed — next run will retry" >&2
  fi
else
  echo "[vault-backup-daily] no 'origin' remote configured — skipping push"
fi
