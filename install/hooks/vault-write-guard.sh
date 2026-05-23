#!/bin/bash
# ADR-046 — Vault-write chokepoint
# Blocks direct Write/Edit/NotebookEdit on paths under ~/vault/ and
# redirects the agent to the `vault-write` skill (which calls the Soul
# Hub createNote API). All AI-authored vault content must flow through
# the API to get governance (frontmatter validation, zone rules,
# rate-limiting, audit log, dedup, atomic commit).
#
# Exempt subdirs:
#   ~/vault/.vault/   — operator-curated templates + config
#   ~/vault/.git/     — git internals (never written by agents anyway)
#   ~/vault/.gitnexus — runtime index (excluded from git as well)
#   ~/vault/.obsidian — Obsidian config
#
# Exempt files (any depth):
#   CLAUDE.md         — operator-curated zone-governance config (Allowed
#                       Types, Naming Pattern). Read by governance.ts as
#                       raw markdown; not a content note — /vault-write
#                       API has no endpoint for it. Stderr audit echo on
#                       each pass-through so zone-schema edits remain
#                       visible to the operator (git log + this log).

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

case "$TOOL_NAME" in
  Write|Edit|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
[[ -n "$FILE_PATH" ]] || exit 0

# Resolve ~ and relative paths to absolute. Portable across macOS (BSD)
# and Linux. python3's os.path.abspath doesn't require the file to exist,
# which matters because Write/NotebookEdit create new files. expanduser
# handles a literal `~/vault/...` form too.
ABS_PATH=$(python3 -c "import os,sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))" "$FILE_PATH" 2>/dev/null || true)
[[ -n "$ABS_PATH" ]] || exit 0

VAULT_ROOT="$HOME/vault"

# Only intercept paths under the vault.
case "$ABS_PATH" in
  "$VAULT_ROOT"/*) ;;
  *) exit 0 ;;
esac

# Exempt subdirs (operator-curated config + git internals).
case "$ABS_PATH" in
  "$VAULT_ROOT"/.vault/*|"$VAULT_ROOT"/.git/*|"$VAULT_ROOT"/.gitnexus/*|"$VAULT_ROOT"/.obsidian/*)
    exit 0
    ;;
esac

REL_PATH="${ABS_PATH#$VAULT_ROOT/}"

# Exempt CLAUDE.md (operator-curated zone-governance config). Audit echo
# so zone-schema edits surface in the operator's hook log.
case "$ABS_PATH" in
  */CLAUDE.md)
    echo "[chokepoint] CLAUDE.md edit allowed: $REL_PATH (zone schema, ADR-046 exempt)" >&2
    exit 0
    ;;
esac

cat >&2 <<EOF
BLOCKED: Direct $TOOL_NAME on vault path is not allowed (ADR-046).

Target: $REL_PATH

All AI-authored vault content must go through the vault API so it
gets frontmatter validation, zone rules, rate-limiting, audit log,
dedup, and atomic commit.

→ Use the /vault-write skill instead:

   ~/.claude/skills/vault-write/scripts/vault-write.sh \\
     --zone "<zone>" \\
     --filename "<filename.md>" \\
     --meta-json '{"type":"...","created":"YYYY-MM-DD","tags":[...]}' \\
     --content "<body>"

For an update, use --update with the full vault-relative path:

   vault-write.sh --update "<zone>/<filename.md>" \\
     --meta-json '{...}' --content "..."

Or call the API directly:

   POST http://localhost:2400/api/vault/notes
   PUT  http://localhost:2400/api/vault/notes/<path>

See ~/claude-config/rules/vault.md for the full rule.
EOF

exit 2
