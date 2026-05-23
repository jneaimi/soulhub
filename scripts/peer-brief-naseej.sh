#!/usr/bin/env bash
# peer-brief-naseej.sh — Naseej port of peer-brief-render.py (ADR-007 S3).
#
# Thin wrapper: POSTs to /api/recipes/run with recipe=peer-brief and
# inputs.date = $1 (default: today). Parses the response JSON, prints
# the rendered PDF path on success, maps failed_step to distinct exit
# codes for back-compat with the legacy scheduler triage flow.
#
# Usage:
#   ./peer-brief-naseej.sh                  # today
#   ./peer-brief-naseej.sh 2026-05-16       # back-date
#
# Env:
#   SOUL_HUB_BASE   override the API base (default http://localhost:2400)
#   PEER_BRIEF_MIN_SCORE   override stop-slop min score (default 30)
#
# Exit codes (parity with peer-brief-render.py):
#   0  success
#   1  general error (API unreachable, malformed response)
#   2  bad args (invalid date format)
#   4  extract-trend failed (legacy: missing miner-daily)
#   5  synth failed
#   6  scan failed (stop-slop gate)
#   7  render failed (katib build)
#   8  notify failed (telegram)

set -euo pipefail

DATE="${1:-$(date +%Y-%m-%d)}"
BASE="${SOUL_HUB_BASE:-http://localhost:2400}"
MIN_SCORE="${PEER_BRIEF_MIN_SCORE:-30}"
RUN_ID="peer-brief-${DATE}-$(date +%s)"

# ADR-007 S4 shadow-week path override.
#
# The legacy peer-brief-render.py task (07:30 cron) writes the canonical
# ~/Downloads/peer-brief-<DATE>.en.pdf. This Naseej wrapper runs at 07:35
# and finishes ~26 min later, so without an override it clobbers the
# legacy artefact and breaks the same-day F2/F3 comparison (size, section
# count, stop-slop score). Default the Naseej PDF to a "-naseej" suffix
# during the shadow window. After F4 (legacy task disabled), delete this
# block and the recipe default (~/Downloads/peer-brief-<DATE>.en.pdf)
# takes back the canonical path.
OUT_PDF="${PEER_BRIEF_OUT_PDF:-${HOME}/Downloads/peer-brief-${DATE}-naseej.en.pdf}"

if ! [[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
	echo "[ERROR] Invalid date format: $DATE (expected YYYY-MM-DD)" >&2
	exit 2
fi

echo "[peer-brief-naseej] date=$DATE run_id=$RUN_ID min_score=$MIN_SCORE" >&2

# Default to production dispatch (claude-pty + /goal) for the synth step.
#
# Empirical finding (ADR-007 S3 testing on 2026-05-17, runs 1-6):
# peer-brief-synth ISN'T structurally one-shot — its em-dash self-check
# is a convergence loop ("write → grep → fix → re-grep → done"). Without
# /goal as an early-termination signal, cli-flag oneshot mode (run 6)
# never returned: sonnet kept refining until the 25-min budget hit, with
# zero turns recorded and no file produced. PTY + /goal lets the agent
# exit as soon as the goal-condition is satisfied (runs 1+3 both fired
# goal_achieved at the natural completion point).
#
# Override with PEER_BRIEF_MODE=oneshot to use the cli-flag backend for
# genuinely single-pass agents (kept for future Naseej recipes — see
# ADR-007 S3 notes + dispatch-mode pattern note).
MODE="${PEER_BRIEF_MODE:-production}"

PAYLOAD=$(cat <<JSON
{
	"recipe": "peer-brief",
	"run_id": "${RUN_ID}",
	"mode": "${MODE}",
	"inputs": {
		"date": "${DATE}",
		"min_score": ${MIN_SCORE},
		"out_pdf": "${OUT_PDF}"
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

# Surface a tail of the response for triage even on success
echo "$RESPONSE" | jq -r '"[peer-brief-naseej] status=\(.status) duration_ms=\(.duration_ms // 0)"' >&2 || {
	echo "[ERROR] Malformed JSON response: ${RESPONSE:0:500}" >&2
	exit 1
}

STATUS=$(echo "$RESPONSE" | jq -r '.status')

if [[ "$STATUS" == "success" ]]; then
	PDF_PATH=$(echo "$RESPONSE" | jq -r '.steps[] | select(.id == "render") | .outputs.pdf_path')
	PDF_SIZE=$(echo "$RESPONSE" | jq -r '.steps[] | select(.id == "render") | .outputs.pdf_size_bytes')
	echo "[peer-brief-naseej] ✓ rendered ${PDF_PATH} (${PDF_SIZE} bytes)" >&2
	echo "$PDF_PATH"
	exit 0
fi

FAILED_STEP=$(echo "$RESPONSE" | jq -r '.failed_step // "unknown"')
STEP_ERROR=$(echo "$RESPONSE" | jq -r --arg s "$FAILED_STEP" '.steps[] | select(.id == $s) | .error // "no error captured"')

echo "[peer-brief-naseej] ✗ failed at step=${FAILED_STEP}: ${STEP_ERROR}" >&2

case "$FAILED_STEP" in
	extract-trend) exit 4 ;;
	synth)         exit 5 ;;
	scan)          exit 6 ;;
	render)        exit 7 ;;
	notify)        exit 8 ;;
	*)             exit 1 ;;
esac
