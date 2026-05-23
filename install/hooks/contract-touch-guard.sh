#!/bin/bash
# soul-hub-governance ADR-002 (P2) — contract-touch advisory hook.
#
# Design-time layer of the falsifier-backed-contract model: when a Write/Edit
# touches a file that participates in a declared cross-area contract, print a
# terse advisory naming the contract + its falsifier, so the change is made with
# the contract in mind ("update its falsifier in the same change").
#
# ADVISORY ONLY — always exits 0; never blocks an edit (the blocking build-time
# chokepoint is ADR-002 P3, a separate decision). Reads the COMPILED CACHE off
# disk (instant, offline, no dependency on soul-hub running). Fail-open: if the
# cache is missing or jq is unavailable, it stays silent and allows the edit.
#
# Source of truth is the vault note projects/soul-hub-governance/contract-registry.md;
# the cache is projected by `compile()` (heartbeat task + POST /api/contracts/compile).

set -uo pipefail

CACHE="${SOUL_HUB_HOME:-$HOME/.soul-hub}/data/contracts/registry.json"

# Fail-open preconditions.
command -v jq >/dev/null 2>&1 || exit 0
[[ -f "$CACHE" ]] || exit 0

INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
case "$TOOL_NAME" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
[[ -n "$FILE_PATH" ]] || exit 0

# Resolve ~ and relative paths to absolute (file need not exist — Write creates).
ABS=$(python3 -c "import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))" "$FILE_PATH" 2>/dev/null || true)
[[ -n "$ABS" ]] || exit 0

# Emit one TSV row per (contract, bashGlob): id, glob, guarantees, falsifier.
ROWS=$(jq -r '.contracts[] | .id as $id | .guarantees as $g | .falsifier as $f
              | .bashGlobs[] | [$id, ., $g, $f] | @tsv' "$CACHE" 2>/dev/null || true)
[[ -n "$ROWS" ]] || exit 0

declare -A SEEN
MATCHES=""
while IFS=$'\t' read -r id glob guarantees falsifier; do
  [[ -n "$glob" ]] || continue
  # Unquoted $glob → bash pathname-style match ('*' crosses '/').
  if [[ "$ABS" == $glob ]]; then
    [[ -n "${SEEN[$id]:-}" ]] && continue
    SEEN[$id]=1
    MATCHES+="  • ${id} — ${guarantees}"$'\n'
    MATCHES+="    falsifier: ${falsifier}"$'\n'
  fi
done <<< "$ROWS"

[[ -n "$MATCHES" ]] || exit 0

REL="${ABS#"$HOME"/}"
cat >&2 <<EOF
[contract-touch] This change touches a declared cross-area contract (governance ADR-002).
Target: ~/${REL}
${MATCHES}→ If your change could violate the invariant, update the contract's falsifier in the
  same change ("migrations ship with the rename"). Query anytime: soul contracts touching <path>
EOF

exit 0
