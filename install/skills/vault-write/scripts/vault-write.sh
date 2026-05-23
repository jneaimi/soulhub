#!/bin/bash
# ADR-046 vault-write skill wrapper.
# Routes create + update operations through the Soul Hub vault API.
# All AI vault writes must go through this script (or call the API
# directly) — direct Write/Edit on ~/vault/* is blocked by
# ~/.claude/hooks/vault-write-guard.sh.
#
# Usage (create):
#   vault-write.sh --zone <zone> --filename <name.md> \
#                  --meta-json '<json>' --content '<body>'
#
# Usage (update):
#   vault-write.sh --update <vault-relative-path> \
#                  [--meta-json '<json>'] [--content '<body>']
#
# On success: prints the vault-relative path to stdout, exit 0.
# On failure: prints the API error to stderr, exit non-zero.

set -euo pipefail

API_BASE="${SOUL_HUB_URL:-http://localhost:2400}"

ZONE=""
FILENAME=""
META_JSON=""
CONTENT=""
UPDATE_PATH=""

usage() {
  cat >&2 <<USAGE
Usage:
  Create:  $0 --zone <zone> --filename <name.md> --meta-json '<json>' --content '<body>'
  Update:  $0 --update <vault-relative-path> [--meta-json '<json>'] [--content '<body>']

Flags:
  --zone         Target zone (e.g. "knowledge/learnings")
  --filename     Filename within zone (e.g. "2026-05-16-foo.md")
  --update       Vault-relative path for update (mutually exclusive with --zone/--filename)
  --meta-json    Frontmatter as JSON object (required for create; partial-merge for update)
  --content      Markdown body (required for create; replaces body for update)

Env:
  SOUL_HUB_URL   Override API base (default: http://localhost:2400)
USAGE
  exit 64
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zone)        ZONE="$2"; shift 2 ;;
    --filename)    FILENAME="$2"; shift 2 ;;
    --meta-json)   META_JSON="$2"; shift 2 ;;
    --content)     CONTENT="$2"; shift 2 ;;
    --update)      UPDATE_PATH="$2"; shift 2 ;;
    -h|--help)     usage ;;
    *)             echo "Unknown flag: $1" >&2; usage ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required (brew install jq)" >&2
  exit 2
fi

# Quick health check — fail closed if Soul Hub isn't up.
if ! curl -sf -o /dev/null --max-time 3 "$API_BASE/api/vault/hygiene" 2>/dev/null; then
  echo "ERROR: Soul Hub API at $API_BASE is unreachable." >&2
  echo "       Start it: cd ~/dev/soul-hub && ./node_modules/.bin/pm2 start ecosystem.config.cjs" >&2
  exit 3
fi

if [[ -n "$UPDATE_PATH" ]]; then
  # ── UPDATE PATH ────────────────────────────────────────────────
  if [[ -n "$ZONE" || -n "$FILENAME" ]]; then
    echo "ERROR: --update is mutually exclusive with --zone/--filename" >&2
    usage
  fi
  if [[ -z "$META_JSON" && -z "$CONTENT" ]]; then
    echo "ERROR: --update requires at least one of --meta-json or --content" >&2
    usage
  fi

  # Validate meta JSON if provided.
  if [[ -n "$META_JSON" ]]; then
    if ! echo "$META_JSON" | jq -e . >/dev/null 2>&1; then
      echo "ERROR: --meta-json is not valid JSON" >&2
      exit 4
    fi
  fi

  PAYLOAD=$(jq -nc \
    --argjson meta "${META_JSON:-null}" \
    --arg content "${CONTENT:-}" \
    --argjson has_content "$([ -n "$CONTENT" ] && echo true || echo false)" \
    '{} + (if $meta != null then {meta:$meta} else {} end) + (if $has_content then {content:$content} else {} end)')

  RESPONSE=$(curl -sS -X PUT "$API_BASE/api/vault/notes/$UPDATE_PATH" \
    -H 'Content-Type: application/json' \
    -d "$PAYLOAD")

  if echo "$RESPONSE" | jq -e '.success == true' >/dev/null 2>&1; then
    echo "$RESPONSE" | jq -r '.path'
    exit 0
  fi
  echo "FAILED: $RESPONSE" >&2
  ERR_FIELD=$(echo "$RESPONSE" | jq -r '.field // empty')
  [[ -n "$ERR_FIELD" ]] && echo "  (field: $ERR_FIELD)" >&2
  echo "  do NOT report success" >&2
  exit 1
fi

# ── CREATE PATH ────────────────────────────────────────────────
if [[ -z "$ZONE" || -z "$FILENAME" || -z "$META_JSON" || -z "$CONTENT" ]]; then
  echo "ERROR: create requires --zone, --filename, --meta-json, and --content" >&2
  usage
fi

if ! echo "$META_JSON" | jq -e . >/dev/null 2>&1; then
  echo "ERROR: --meta-json is not valid JSON" >&2
  exit 4
fi

PAYLOAD=$(jq -nc \
  --arg zone "$ZONE" \
  --arg filename "$FILENAME" \
  --argjson meta "$META_JSON" \
  --arg content "$CONTENT" \
  '{zone:$zone, filename:$filename, meta:$meta, content:$content}')

RESPONSE=$(curl -sS -X POST "$API_BASE/api/vault/notes" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD")

if echo "$RESPONSE" | jq -e '.success == true' >/dev/null 2>&1; then
  echo "$RESPONSE" | jq -r '.path'
  exit 0
fi

echo "FAILED: $RESPONSE" >&2
ERR_FIELD=$(echo "$RESPONSE" | jq -r '.field // empty')
[[ -n "$ERR_FIELD" ]] && echo "  (field: $ERR_FIELD)" >&2
echo "  do NOT report success" >&2
exit 1
