#!/usr/bin/env bash
# ADR-024 — Collapse the ~/.claude symlink into a real, Soul-Hub-managed git store.
#
# Today: ~/.claude → symlink → ~/claude-config (a git repo).
# After: ~/.claude IS the git repo (the dir is relocated in place), the
#        separate ~/claude-config path is gone, .git + remote + .githooks
#        travel with it. Idempotent: re-running when already collapsed is a no-op.
#
# Safe by construction: same-filesystem `mv` is an atomic rename (no copy, no
# data loss). The only mutating window is unlink(symlink)+rename, microseconds,
# and no Claude Code hook fires mid-command. On any post-move verification
# failure it auto-rolls-back to the original symlink layout.
#
# Usage:
#   migrate-claude-config-collapse.sh --dry-run   # show what would happen
#   migrate-claude-config-collapse.sh             # do it (with verify + rollback)

set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

CLAUDE_LINK="$HOME/.claude"
CONFIG_DIR="$HOME/claude-config"

log() { echo "[collapse] $*"; }
die() { echo "[collapse] ERROR: $*" >&2; exit 1; }

# ── Idempotency / preconditions ────────────────────────────────────────
if [ -d "$CLAUDE_LINK" ] && [ ! -L "$CLAUDE_LINK" ]; then
  if [ -d "$CLAUDE_LINK/.git" ]; then
    log "already collapsed — ~/.claude is a real git dir. No-op."
    exit 0
  fi
  die "~/.claude is a real dir but has no .git — refusing to touch (unexpected state)."
fi

[ -L "$CLAUDE_LINK" ] || die "~/.claude is neither a symlink nor a collapsed dir — unexpected."
TARGET="$(readlink "$CLAUDE_LINK")"
[ "$TARGET" = "$CONFIG_DIR" ] || die "~/.claude points to '$TARGET', not '$CONFIG_DIR' — refusing."
[ -d "$CONFIG_DIR/.git" ] || die "$CONFIG_DIR/.git missing — not a git repo, refusing."

# Warn (don't block) on unpushed commits — uncommitted files travel fine with mv.
UNPUSHED="$(git -C "$CONFIG_DIR" rev-list --count @{u}..HEAD 2>/dev/null || echo '?')"
log "preconditions OK. unpushed commits: ${UNPUSHED}"

if [ "$DRY" = 1 ]; then
  log "DRY RUN — would do:"
  log "  unlink $CLAUDE_LINK        # remove symlink (target untouched)"
  log "  mv $CONFIG_DIR $CLAUDE_LINK  # atomic rename (same FS)"
  log "  then verify: dir + .git + git log + CLAUDE.md + a sub-symlink, else rollback"
  exit 0
fi

# ── The collapse (atomic-ish) ──────────────────────────────────────────
log "collapsing…"
unlink "$CLAUDE_LINK"
mv "$CONFIG_DIR" "$CLAUDE_LINK"

# ── Verify; rollback on any failure ────────────────────────────────────
rollback() {
  echo "[collapse] VERIFY FAILED ($1) — rolling back" >&2
  if [ -d "$CLAUDE_LINK" ] && [ ! -L "$CLAUDE_LINK" ]; then
    mv "$CLAUDE_LINK" "$CONFIG_DIR"
  fi
  ln -s "$CONFIG_DIR" "$CLAUDE_LINK"
  echo "[collapse] rolled back to symlink layout." >&2
  exit 1
}

[ -d "$CLAUDE_LINK" ] && [ ! -L "$CLAUDE_LINK" ] || rollback "not a real dir"
[ -d "$CLAUDE_LINK/.git" ]                        || rollback ".git missing"
git -C "$CLAUDE_LINK" log -1 --oneline >/dev/null 2>&1 || rollback "git log broken"
[ -r "$CLAUDE_LINK/CLAUDE.md" ]                   || rollback "CLAUDE.md unreadable"
# a known sub-symlink must still resolve (governance hook → soul-hub/install)
[ -e "$CLAUDE_LINK/hooks/vault-write-guard.sh" ]  || rollback "sub-symlink broken"

log "collapsed OK. ~/.claude is now a real git repo."
log "  .git:        $(git -C "$CLAUDE_LINK" rev-parse --git-dir)"
log "  hooksPath:   $(git -C "$CLAUDE_LINK" config core.hooksPath || echo none)"
log "  remote:      $(git -C "$CLAUDE_LINK" remote get-url origin 2>/dev/null || echo none)"
log "  HEAD:        $(git -C "$CLAUDE_LINK" log -1 --oneline)"
