#!/usr/bin/env bash
# Daily ~/.claude git snapshot — invoked by Soul Hub scheduler task
# `claude-config-backup-daily` per ADR-024 (soul-hub-agents). Sibling of
# scripts/vault-backup-daily.sh (ADR-019): same shape, different store.
#
# After ADR-024 collapsed the ~/.claude symlink, ~/.claude IS a git repo
# (formerly ~/claude-config). Soul Hub is now its commit/backup authority.
#
# Two responsibilities:
#   1. Stage + commit anything not yet committed (config edits made directly
#      via Claude Code Edit/Write, or via the orchestration agent/skill UIs).
#   2. Push origin/main if a remote is configured (GitHub offsite backup).
#      Push runs UNCONDITIONALLY so earlier unpushed commits also flush.
#
# Push failures emit a warning but DO NOT fail the script — next run retries.
# Reads CLAUDE_DIR from env (set by scheduler) or falls back to ~/.claude.

set -euo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

if [ ! -d "$CLAUDE_DIR/.git" ]; then
  echo "[claude-config-backup-daily] $CLAUDE_DIR is not a git repo — did ADR-024 collapse run? (scripts/migrate-claude-config-collapse.sh)" >&2
  exit 1
fi

git -C "$CLAUDE_DIR" add -A

if git -C "$CLAUDE_DIR" diff --cached --quiet ; then
  echo "[claude-config-backup-daily] no changes to commit"
else
  DATE_STAMP="$(date +%Y-%m-%d)"
  STAGED_COUNT="$(git -C "$CLAUDE_DIR" diff --cached --name-only | wc -l | tr -d ' ')"
  git -C "$CLAUDE_DIR" commit -m "claude-config: daily snapshot ${DATE_STAMP} (${STAGED_COUNT} files)"
  echo "[claude-config-backup-daily] committed ${STAGED_COUNT} files"
fi

if git -C "$CLAUDE_DIR" remote get-url origin >/dev/null 2>&1; then
  if git -C "$CLAUDE_DIR" push --quiet origin main 2>&1; then
    echo "[claude-config-backup-daily] pushed to origin/main"
  else
    echo "[claude-config-backup-daily] push to origin failed — next run will retry" >&2
  fi
else
  echo "[claude-config-backup-daily] no 'origin' remote configured — skipping push"
fi
