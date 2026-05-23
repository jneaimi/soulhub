#!/usr/bin/env bash
# scripts/soul-cli-uptake-check.sh — ADR-001 falsifier data collector (v2).
#
# Scans Claude Code session JSONLs in a time window and counts:
#   - Total Bash tool invocations
#   - `soul ...` invocations (positive signal)
#   - Anti-patterns the CLI is meant to replace, split read vs write:
#       A1r) Inline Python read against /api/(vault|projects|crm|scheduler|intent)
#       A1w) Inline Python write (requests.post/put/patch/delete, httpx.*, method="POST"...)
#       A2r) Raw curl read on covered routes
#       A2w) Raw curl write (-X POST/PUT/PATCH/DELETE or --request POST/...)
#
# Surfaces counts + most-recent samples so the operator sees why the falsifier moved.
# Intended to be called by the scheduler weekly (soul-cli-uptake-check task).
#
# Usage:
#   bash scripts/soul-cli-uptake-check.sh                       # last 7 days, pretty
#   bash scripts/soul-cli-uptake-check.sh 30                    # last 30 days
#   bash scripts/soul-cli-uptake-check.sh 7 --json              # machine-readable
#   bash scripts/soul-cli-uptake-check.sh --since 1747526400    # absolute epoch cutoff
#   bash scripts/soul-cli-uptake-check.sh 7 --json --write-vault # also POST to inbox/
#
# Falsifier rule (ADR-001, post-Phase-2): per-bucket. Either read-anti OR write-anti
# at ≥ 5/week trips. Tracked independently so a regression in one bucket is visible
# even when the other improves.
#
# Exit codes:
#   0  ran successfully (regardless of whether falsifier is tripped)
#   1  dependency missing / Claude projects dir absent

set -uo pipefail

DAYS="${1:-7}"
# Strip the leading positional if it's not a number (e.g., user passed --since first).
if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then DAYS=7; fi

JSON_OUT=0
WRITE_VAULT=0
SINCE_EPOCH=""

for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    --write-vault) WRITE_VAULT=1 ;;
    --since=*) SINCE_EPOCH="${arg#--since=}" ;;
  esac
done
# Support `--since EPOCH` (space-separated form) by scanning positionally.
i=1
for arg in "$@"; do
  if [ "$arg" = "--since" ]; then
    next_idx=$((i + 1))
    SINCE_EPOCH="${!next_idx:-}"
  fi
  i=$((i + 1))
done

CLAUDE_PROJECTS="${CLAUDE_PROJECTS:-$HOME/.claude/projects}"
[ -d "$CLAUDE_PROJECTS" ] || { echo "soul-cli-uptake: $CLAUDE_PROJECTS missing" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "soul-cli-uptake: jq required" >&2; exit 1; }

# Cutoff in milliseconds. --since EPOCH wins; otherwise N days ago.
if [ -n "$SINCE_EPOCH" ]; then
  if ! [[ "$SINCE_EPOCH" =~ ^[0-9]+$ ]]; then
    echo "soul-cli-uptake: --since requires a unix epoch (seconds)" >&2
    exit 1
  fi
  CUTOFF_MS=$((SINCE_EPOCH * 1000))
  WINDOW_LABEL="since epoch ${SINCE_EPOCH}"
else
  if date -v -1d +%s >/dev/null 2>&1; then
    CUTOFF_MS=$(($(date -v -"${DAYS}"d +%s) * 1000))      # BSD / macOS
  else
    CUTOFF_MS=$(($(date -d "$DAYS days ago" +%s) * 1000)) # GNU / Linux
  fi
  WINDOW_LABEL="last ${DAYS} day(s)"
fi

# Walk every JSONL. Extract Bash tool_use commands inside the window.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

while IFS= read -r -d '' file; do
  jq -r --argjson cutoff "$CUTOFF_MS" '
    . as $r
    | select($r.type == "assistant" and ($r.message.content // null) != null)
    | (($r.timestamp | sub("\\.[0-9]+Z$"; "Z") | (try fromdateiso8601 catch 0)) * 1000) as $ms
    | select($ms >= $cutoff)
    | $r.message.content[]
    | select(.type == "tool_use" and .name == "Bash")
    | [($ms | tostring), (.input.command // "" | gsub("\n"; " ¶ "))]
    | @tsv
  ' "$file" 2>/dev/null
done < <(find "$CLAUDE_PROJECTS" -type f -name "*.jsonl" -print0) >> "$TMP"

TOTAL=$(wc -l < "$TMP" | tr -d ' ')
[ -z "$TOTAL" ] && TOTAL=0

# Regexes — ERE.
SOUL_RE='(^|[[:space:]]|/)soul([[:space:]]|$)'

# Inline Python touching the Soul Hub API.
PY_API_RE='python3?[[:space:]]+-c.*localhost:2400/api/'
# Python write heuristic: explicit method= or method-named call.
PY_WRITE_RE='(requests|httpx|urllib3?)[[:space:]]*\.(post|put|patch|delete)|method[[:space:]]*=[[:space:]]*["'"'"']?(POST|PUT|PATCH|DELETE)'

# Raw curl against covered routes.
CURL_API_RE='curl[^|]*localhost:2400/api/(vault|projects|crm|scheduler|intent)'
# HTTP-method override flags that promote a curl to a write.
CURL_WRITE_RE='-X[[:space:]]+(POST|PUT|PATCH|DELETE)|--request[[:space:]]+(POST|PUT|PATCH|DELETE)'

count_lines() {
  # $1 = file with one command per line. echoes count, never errors.
  wc -l < "$1" | tr -d ' '
}

# Build per-bucket command lists.
PY_ALL=$(mktemp); PY_R=$(mktemp); PY_W=$(mktemp)
CURL_ALL=$(mktemp); CURL_R=$(mktemp); CURL_W=$(mktemp)
trap 'rm -f "$TMP" "$PY_ALL" "$PY_R" "$PY_W" "$CURL_ALL" "$CURL_R" "$CURL_W"' EXIT

awk -F'\t' '{print $2}' "$TMP" | grep -E "$PY_API_RE"   > "$PY_ALL"   2>/dev/null || true
awk -F'\t' '{print $2}' "$TMP" | grep -E "$CURL_API_RE" > "$CURL_ALL" 2>/dev/null || true

# Python: writes match PY_WRITE_RE; rest are reads.
grep -E    -- "$PY_WRITE_RE"   "$PY_ALL"   > "$PY_W" 2>/dev/null || true
grep -Ev   -- "$PY_WRITE_RE"   "$PY_ALL"   > "$PY_R" 2>/dev/null || true
# Curl: writes match CURL_WRITE_RE; rest are reads.
grep -E    -- "$CURL_WRITE_RE" "$CURL_ALL" > "$CURL_W" 2>/dev/null || true
grep -Ev   -- "$CURL_WRITE_RE" "$CURL_ALL" > "$CURL_R" 2>/dev/null || true

SOUL_COUNT=$(awk -F'\t' '{print $2}' "$TMP" | grep -Ec "$SOUL_RE" 2>/dev/null || echo 0)
A1R=$(count_lines "$PY_R")
A1W=$(count_lines "$PY_W")
A2R=$(count_lines "$CURL_R")
A2W=$(count_lines "$CURL_W")
READ_ANTI=$((A1R + A2R))
WRITE_ANTI=$((A1W + A2W))
ANTI_TOTAL=$((READ_ANTI + WRITE_ANTI))

# Window normalisation for rate. If --since was used, derive days from it.
if [ -n "$SINCE_EPOCH" ]; then
  NOW_S=$(date +%s)
  WINDOW_DAYS=$(awk -v n="$NOW_S" -v s="$SINCE_EPOCH" 'BEGIN{d=(n-s)/86400; printf "%.4f", (d>0?d:0.0001)}')
else
  WINDOW_DAYS="$DAYS"
fi

READ_RATE=$(awk -v a="$READ_ANTI"  -v d="$WINDOW_DAYS" 'BEGIN{printf "%.1f", (d>0 ? a*7/d : 0)}')
WRITE_RATE=$(awk -v a="$WRITE_ANTI" -v d="$WINDOW_DAYS" 'BEGIN{printf "%.1f", (d>0 ? a*7/d : 0)}')
READ_TRIP=$(awk  -v r="$READ_RATE"  'BEGIN{print (r >= 5 ? "yes" : "no")}')
WRITE_TRIP=$(awk -v r="$WRITE_RATE" 'BEGIN{print (r >= 5 ? "yes" : "no")}')
ANY_TRIP="no"; [ "$READ_TRIP" = "yes" ] || [ "$WRITE_TRIP" = "yes" ] && ANY_TRIP="yes"

# Most-recent samples per bucket (up to 3 each, truncated).
samples_from() {
  # $1 = bucket file
  grep -F -f <(awk -F'\t' '{print $2}' "$1") "$TMP" 2>/dev/null \
    | sort -r \
    | head -3 \
    | awk -F'\t' '{
        ts = int($1 / 1000); cmd = $2;
        if (length(cmd) > 110) cmd = substr(cmd, 1, 107) "...";
        printf "%s  (ts=%d)\n", cmd, ts;
      }' || true
}

# Lighter sampling: keep it simple — pick from each bucket file directly with no ts join.
sample_bucket() {
  head -3 "$1" 2>/dev/null | awk '{
    cmd = $0;
    if (length(cmd) > 110) cmd = substr(cmd, 1, 107) "...";
    print cmd;
  }' || true
}
READ_SAMPLES=$( { sample_bucket "$PY_R"; sample_bucket "$CURL_R"; } | head -3 )
WRITE_SAMPLES=$( { sample_bucket "$PY_W"; sample_bucket "$CURL_W"; } | head -3 )

# ────────────────────────────────────────────────────────────────────────
# Output: JSON vs pretty.
# ────────────────────────────────────────────────────────────────────────

# Build a single canonical JSON blob; we reuse it for stdout AND vault.
JSON_BLOB=$(jq -n \
  --arg windowLabel "$WINDOW_LABEL" \
  --argjson cutoffMs "$CUTOFF_MS" \
  --arg windowDays "$WINDOW_DAYS" \
  --argjson total "$TOTAL" \
  --argjson soul "$SOUL_COUNT" \
  --argjson a1r "$A1R" --argjson a1w "$A1W" \
  --argjson a2r "$A2R" --argjson a2w "$A2W" \
  --argjson readAnti  "$READ_ANTI" \
  --argjson writeAnti "$WRITE_ANTI" \
  --argjson antiTotal "$ANTI_TOTAL" \
  --arg readRate  "$READ_RATE"  \
  --arg writeRate "$WRITE_RATE" \
  --arg readTrip  "$READ_TRIP"  \
  --arg writeTrip "$WRITE_TRIP" \
  --arg anyTrip   "$ANY_TRIP"   \
  --arg readSamples  "$READ_SAMPLES" \
  --arg writeSamples "$WRITE_SAMPLES" \
  '{
     windowLabel: $windowLabel,
     cutoffMs: $cutoffMs,
     windowDays: ($windowDays | tonumber),
     bashTotal: $total,
     soulCount: $soul,
     read:  { python: $a1r, curl: $a2r, total: $readAnti,  weeklyRate: ($readRate  | tonumber), tripped: ($readTrip  == "yes") },
     write: { python: $a1w, curl: $a2w, total: $writeAnti, weeklyRate: ($writeRate | tonumber), tripped: ($writeTrip == "yes") },
     antiTotal: $antiTotal,
     falsifierTripped: ($anyTrip == "yes"),
     samples: {
       read:  ($readSamples  | split("\n") | map(select(length > 0))),
       write: ($writeSamples | split("\n") | map(select(length > 0)))
     }
   }')

if [ "$JSON_OUT" = "1" ]; then
  printf '%s\n' "$JSON_BLOB"
else
  printf "soul-cli uptake — %s\n" "$WINDOW_LABEL"
  printf "─────────────────────────────────────────────\n"
  printf "  Total Bash tool calls : %s\n"           "$TOTAL"
  printf "  soul invocations      : %s\n"           "$SOUL_COUNT"
  printf "  Read  anti-patterns   : %s  (python:%s  curl:%s)   rate/wk: %s  trip: %s\n" \
    "$READ_ANTI" "$A1R" "$A2R" "$READ_RATE" "$READ_TRIP"
  printf "  Write anti-patterns   : %s  (python:%s  curl:%s)   rate/wk: %s  trip: %s\n" \
    "$WRITE_ANTI" "$A1W" "$A2W" "$WRITE_RATE" "$WRITE_TRIP"
  printf "  Falsifier tripped     : %s   (per-bucket; threshold 5.0/wk)\n" "$ANY_TRIP"
  if [ -n "$READ_SAMPLES" ]; then
    printf "\nRead samples:\n"
    printf "%s\n" "$READ_SAMPLES" | sed 's/^/  /'
  fi
  if [ -n "$WRITE_SAMPLES" ]; then
    printf "\nWrite samples:\n"
    printf "%s\n" "$WRITE_SAMPLES" | sed 's/^/  /'
  fi
fi

# ────────────────────────────────────────────────────────────────────────
# Optional: write the digest to ~/vault/inbox/<date>-soul-cli-uptake.md
# via POST /api/vault/notes (ADR-046 chokepoint compliant).
# ────────────────────────────────────────────────────────────────────────

if [ "$WRITE_VAULT" = "1" ]; then
  SOUL_HUB_URL="${SOUL_HUB_URL:-http://localhost:2400}"
  TODAY=$(date +%Y-%m-%d)
  FILENAME="${TODAY}-soul-cli-uptake.md"

  # Markdown body — same shape as the pretty output above, fenced for the agent.
  BODY=$(printf "# soul-cli uptake — %s\n\nWindow: %s\n\n## Counters\n\n| | python | curl | total | rate/wk | trip |\n|---|---|---|---|---|---|\n| **read**  | %s | %s | %s | %s | %s |\n| **write** | %s | %s | %s | %s | %s |\n\n- Bash total: **%s**\n- soul invocations: **%s**\n- Falsifier tripped (per-bucket, threshold 5/wk): **%s**\n\n## Read samples\n\n%s\n\n## Write samples\n\n%s\n\n---\n\n_ADR-001 (soul-hub-cli) falsifier. See [[adr-001-soul-cli-uptake-check]] for the rule._\n" \
    "$TODAY" "$WINDOW_LABEL" \
    "$A1R" "$A2R" "$READ_ANTI" "$READ_RATE" "$READ_TRIP" \
    "$A1W" "$A2W" "$WRITE_ANTI" "$WRITE_RATE" "$WRITE_TRIP" \
    "$TOTAL" "$SOUL_COUNT" "$ANY_TRIP" \
    "$(printf "%s\n" "${READ_SAMPLES:-_(none)_}"  | sed 's/^/    /')" \
    "$(printf "%s\n" "${WRITE_SAMPLES:-_(none)_}" | sed 's/^/    /')")

  PAYLOAD=$(jq -n \
    --arg zone     "inbox" \
    --arg filename "$FILENAME" \
    --arg today    "$TODAY" \
    --arg content  "$BODY" \
    '{
       zone: $zone,
       filename: $filename,
       meta: {
         type: "report",
         created: $today,
         tags: ["soul-cli-uptake", "falsifier", "weekly"],
         source: "agent",
         source_agent: "soul-cli-uptake",
         source_context: "soul-hub-scheduler",
         voice_eligible: false
       },
       content: $content
     }')

  RESP=$(curl -s -X POST "${SOUL_HUB_URL}/api/vault/notes" \
    -H 'content-type: application/json' \
    --data "$PAYLOAD")

  if [ "$(printf '%s' "$RESP" | jq -r '.success // false')" = "true" ]; then
    PATH_OUT=$(printf '%s' "$RESP" | jq -r '.path // ""')
    echo "[soul-cli-uptake] vault-write ok → ${PATH_OUT}" >&2
  else
    ERR=$(printf '%s' "$RESP" | jq -r '.error // "unknown"')
    echo "[soul-cli-uptake] vault-write FAILED: ${ERR}" >&2
    exit 1
  fi
fi
