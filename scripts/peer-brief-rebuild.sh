#!/usr/bin/env bash
# peer-brief-rebuild.sh — internalized peer-brief (ADR-034 CP3).
#
# Invokes the `peer-brief-rebuild` recipe: the daily peer-brief rebuilt on the
# Naseej stack (doc-render + the peer-brief document template + slot taxonomy),
# ZERO katib. POSTs to /api/recipes/run, maps failed_step → exit codes for
# scheduler triage.
#
# Shadow phase (ADR-034 falsifier): renders to ~/Downloads, NO Telegram send.
# Legacy `peer-brief-daily` keeps the 07:30 Telegram send until cutover. On a
# clean parity week, swap the send into this path and retire legacy.
#
# Output: ~/Downloads/peer-brief-<DATE>-rebuild.en.pdf
#
# Usage:
#   ./peer-brief-rebuild.sh                 # today
#   ./peer-brief-rebuild.sh 2026-05-20      # back-date
#
# Env:
#   SOUL_HUB_BASE             override API base (default http://localhost:2400)
#   PEER_BRIEF_MIN_SCORE      override stop-slop min score (default 25)
#   PEER_BRIEF_REBUILD_OUT_PDF  override output path
#   PEER_BRIEF_REBUILD_DRAFT_MODEL  override draft model (default claude-sonnet-4-6)
#
# Exit codes:
#   0   success
#   1   general error (API unreachable, malformed response)
#   2   bad args (invalid date format)
#   4   extract-trend / build-context failed
#   5   draft-prose failed
#   6   draft-findings failed
#   7   draft-figures failed
#   8   persist-* failed
#   9   fill failed
#   10  scan failed (stop-slop gate)
#   11  render failed (doc-render)

set -euo pipefail

DATE="${1:-$(date +%Y-%m-%d)}"
BASE="${SOUL_HUB_BASE:-http://localhost:2400}"
MIN_SCORE="${PEER_BRIEF_MIN_SCORE:-25}"
RUN_ID="peer-brief-rebuild-${DATE}-$(date +%s)"
OUT_PDF="${PEER_BRIEF_REBUILD_OUT_PDF:-${HOME}/Downloads/peer-brief-${DATE}-rebuild.en.pdf}"
DRAFT_MODEL="${PEER_BRIEF_REBUILD_DRAFT_MODEL:-claude-sonnet-4-6}"

if ! [[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
	echo "[ERROR] Invalid date format: $DATE (expected YYYY-MM-DD)" >&2
	exit 2
fi

echo "[peer-brief-rebuild] date=$DATE run_id=$RUN_ID min_score=$MIN_SCORE draft_model=$DRAFT_MODEL" >&2

PAYLOAD=$(cat <<JSON
{
	"recipe": "peer-brief-rebuild",
	"run_id": "${RUN_ID}",
	"mode": "production",
	"inputs": {
		"date": "${DATE}",
		"min_score": ${MIN_SCORE},
		"out_pdf": "${OUT_PDF}",
		"draft_model": "${DRAFT_MODEL}"
	}
}
JSON
)

RESPONSE=$(curl -sS -X POST "${BASE}/api/recipes/run" \
	-H 'Content-Type: application/json' \
	-d "$PAYLOAD" 2>&1) || {
	echo "[ERROR] API call failed: ${RESPONSE}" >&2
	exit 1
}

echo "$RESPONSE" | jq -r '"[peer-brief-rebuild] status=\(.status) duration_ms=\(.duration_ms // 0)"' >&2 || {
	echo "[ERROR] Malformed JSON response: ${RESPONSE:0:500}" >&2
	exit 1
}

STATUS=$(echo "$RESPONSE" | jq -r '.status')

if [[ "$STATUS" == "success" ]]; then
	PDF_PATH=$(echo "$RESPONSE" | jq -r '.steps[] | select(.id == "render") | .outputs.pdf_path')
	PDF_SIZE=$(echo "$RESPONSE" | jq -r '.steps[] | select(.id == "render") | .outputs.bytes')
	echo "[peer-brief-rebuild] ✓ rendered ${PDF_PATH} (${PDF_SIZE} bytes)" >&2
	echo "$PDF_PATH"
	exit 0
fi

FAILED_STEP=$(echo "$RESPONSE" | jq -r '.failed_step // "unknown"')
STEP_ERROR=$(echo "$RESPONSE" | jq -r --arg s "$FAILED_STEP" '.steps[] | select(.id == $s) | .error // "no error captured"')

echo "[peer-brief-rebuild] ✗ failed at step=${FAILED_STEP}: ${STEP_ERROR}" >&2

case "$FAILED_STEP" in
	extract-trend|build-context)                      exit 4 ;;
	draft-prose)                                      exit 5 ;;
	draft-findings)                                   exit 6 ;;
	draft-figures)                                    exit 7 ;;
	persist-prose|persist-findings|persist-figures)   exit 8 ;;
	fill)                                             exit 9 ;;
	scan)                                             exit 10 ;;
	render)                                           exit 11 ;;
	*)                                                exit 1 ;;
esac
