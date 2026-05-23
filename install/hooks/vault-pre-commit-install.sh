#!/bin/bash
# ADR-048 — installs the vault pre-commit hook from versioned source into
# `.git/hooks/`. Idempotent: re-running re-creates the symlink.
#
# Run from anywhere; the script resolves paths relative to its own location.
#
# Why a symlink not a copy: keeps the hook tracking the versioned source so
# `git pull` to the .vault/hooks/ tree updates the active hook instantly.
# `.git/hooks/` is per-clone and never committed, so the install step is the
# bootstrap.

set -euo pipefail

HOOKS_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT_ROOT="$(cd "$HOOKS_SRC/../.." && pwd)"
GIT_HOOKS="$VAULT_ROOT/.git/hooks"

if [[ ! -d "$GIT_HOOKS" ]]; then
  echo "error: $GIT_HOOKS does not exist (is this a git repo?)" >&2
  exit 1
fi

install_hook() {
  local name="$1"
  local target="$GIT_HOOKS/$name"
  local source="$HOOKS_SRC/$name"

  if [[ ! -f "$source" ]]; then
    echo "skip: $source missing" >&2
    return
  fi

  chmod +x "$source"

  if [[ -L "$target" && "$(readlink "$target")" == "$source" ]]; then
    echo "ok: $name → $source (already linked)"
    return
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    mv "$target" "$target.bak.$(date +%s)"
    echo "moved existing $name → $target.bak.<ts>"
  fi

  ln -s "$source" "$target"
  echo "installed: $name → $source"
}

install_hook "pre-commit"

echo ""
echo "Done. The vault pre-commit hook is active for this clone."
echo "Bypass once: git commit --no-verify"
echo "Bypass always (NOT recommended): set core.hooksPath to something else"
