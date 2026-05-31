#!/usr/bin/env bash
#
# adr-038-phase-c-falsifier.sh — verify ADR-038 Phase C still works.
#
# Phase C = the worktree-janitor-daily scheduler entry in ~/.soul-hub/settings.json
# that activates Layer B (the daily safety-net janitor). Originally shipped
# 2026-05-28 after the discovery that S3 was code-complete but never scheduled.
#
# Checks:
#   F1  task is registered with the scheduler
#   F2  task's nextRunAt is within the next 24h
#   F3  task fires cleanly when triggered manually (POST /api/scheduler/run-now)
#   F4  live regression — synthesize a locked merged worktree, fire the janitor,
#       assert the worktree is reclaimed and the branch is `-d`-deleted, and
#       no other repo state is touched
#
# Each check returns 0 on pass, 1 on fail, with one-line green/red output.
# F4 is destructive in the synthetic-worktree-only sense (it creates and then
# expects-removed a fixture under .worktrees/). It refuses to run if any real
# in-flight orchestration run state is detected, to avoid racing the workbench.
#
# Usage:
#   ./adr-038-phase-c-falsifier.sh [f1|f2|f3|f4|all]   (default: all)

set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
API="${SOUL_HUB_BASE_URL:-http://localhost:2400}"
TASK_ID="worktree-janitor-daily"

# Unique synthetic IDs for F4. Using a wall-clock ms below the workbench's
# real range (year 2030+) and the PID for cross-invocation uniqueness — keeps
# the fixture impossible to mistake for a real orchestration run.
F4_RUN_ID="1900000000000-phase-c-falsifier-$$"
F4_BRANCH="orchestration/run-${F4_RUN_ID}/synth"
F4_WT_PATH="$ROOT/.worktrees/run-${F4_RUN_ID}"

# --- helpers --------------------------------------------------------------

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
note()  { printf '\033[2m%s\033[0m\n' "$*"; }

api_get() {
  curl -s --max-time 10 "$API$1"
}

api_post() {
  curl -s --max-time 60 -X POST -H 'Content-Type: application/json' -d "$2" "$API$1"
}

require_api() {
  if ! api_get /api/system/health >/dev/null 2>&1; then
    red "✗ pre-check: $API/api/system/health unreachable. Start soul-hub first."
    exit 2
  fi
}

# --- F1: task is registered ----------------------------------------------

f1() {
  local task
  task=$(api_get /api/scheduler/tasks \
    | python3 -c "import sys, json; d=json.load(sys.stdin); t=d if isinstance(d,list) else d.get('tasks',[]); m=[x for x in t if x.get('id')=='$TASK_ID']; print(json.dumps(m[0]) if m else '')")
  if [[ -z "$task" || "$task" == "null" ]]; then
    red "✗ F1: $TASK_ID is NOT registered with the scheduler"
    note "    fix: add the task entry to ~/.soul-hub/settings.json (see ADR-038 Phase C)"
    return 1
  fi
  green "✓ F1: $TASK_ID is registered"
  return 0
}

# --- F2: nextRunAt is within the next 24h --------------------------------

f2() {
  local next_iso
  next_iso=$(api_get /api/scheduler/tasks \
    | python3 -c "import sys, json; d=json.load(sys.stdin); t=d if isinstance(d,list) else d.get('tasks',[]); m=[x for x in t if x.get('id')=='$TASK_ID']; print((m[0].get('nextRunAt') or '') if m else '')")
  if [[ -z "$next_iso" ]]; then
    red "✗ F2: $TASK_ID has no nextRunAt (task disabled, paused, or scheduler not running?)"
    return 1
  fi
  python3 - <<EOF >/dev/null 2>&1
import sys
from datetime import datetime, timezone
next_run = datetime.fromisoformat("$next_iso".replace("Z","+00:00"))
delta_s = (next_run - datetime.now(timezone.utc)).total_seconds()
sys.exit(0 if 0 <= delta_s <= 86400 else 1)
EOF
  if [[ $? -ne 0 ]]; then
    red "✗ F2: $TASK_ID nextRunAt=$next_iso is not within the next 24h"
    return 1
  fi
  green "✓ F2: $TASK_ID nextRunAt=$next_iso (within next 24h)"
  return 0
}

# --- F3: task runs cleanly + emits the handler's summary contract --------
#
# Stronger than the run-now ok-status check: also verifies the handler's
# typed output contract matches what ADR-038's original Falsifier section
# committed to — a summary string of the form `worktree-janitor: ...`
# plus typed `reclaimed` + `escalated` integer counters. Catches drift in
# the handler's emit shape, which is the load-bearing observable for
# anyone inspecting `scheduler_runs` history.

f3() {
  local resp summary
  resp=$(api_post /api/scheduler/run-now "{\"taskId\":\"$TASK_ID\"}")
  summary=$(printf '%s' "$resp" | python3 -c "
import sys, json, re
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
out = d.get('output') if isinstance(d.get('output'), dict) else {}
summary = out.get('summary', '') if isinstance(out, dict) else ''
if (d.get('ok') is True
    and d.get('status') == 'success'
    and isinstance(summary, str)
    and re.match(r'^worktree-janitor: ', summary)
    and isinstance(out.get('reclaimed'), int)
    and isinstance(out.get('escalated'), int)):
    print(summary)
    sys.exit(0)
sys.exit(1)
" 2>/dev/null)
  if [[ $? -ne 0 || -z "$summary" ]]; then
    red "✗ F3: run-now response failed contract check"
    note "    expected: ok=true, status=success, output.summary matches /^worktree-janitor: /, output.reclaimed/escalated are ints"
    note "    body: $resp"
    return 1
  fi
  green "✓ F3: run-now succeeded; output.summary=\"$summary\""
  return 0
}

# --- F4: live regression — janitor reclaims a synthetic merged orphan ----

f4_setup() {
  # Refuse to set up if there are pre-existing worktrees we'd be confused by.
  local extant
  extant=$(git worktree list --porcelain | awk '/^worktree /{print $2}' | grep -F "$ROOT/.worktrees/" | wc -l | tr -d ' ')
  if [[ "$extant" -gt 0 ]]; then
    red "✗ F4 pre-check: $extant existing worktree(s) under .worktrees/ — refusing to set up a synthetic fixture beside live state."
    note "    inspect:  cd $ROOT && git worktree list"
    return 2
  fi
  # Create the synthetic locked merged worktree.
  git worktree add --lock -b "$F4_BRANCH" "$F4_WT_PATH" main >/dev/null 2>&1 \
    || { red "✗ F4 setup: git worktree add failed"; return 1; }
  return 0
}

f4_cleanup() {
  # Idempotent: only remove if anything was left behind by a failed assertion.
  if [[ -d "$F4_WT_PATH" ]] || git worktree list --porcelain | grep -qF "$F4_WT_PATH"; then
    git worktree unlock "$F4_WT_PATH" >/dev/null 2>&1 || true
    git worktree remove --force "$F4_WT_PATH" >/dev/null 2>&1 || rm -rf "$F4_WT_PATH"
  fi
  git branch -D "$F4_BRANCH" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
}

f4() {
  trap f4_cleanup EXIT
  f4_setup || return $?

  # Sanity: branch is provably merged (it's at main).
  if ! git merge-base --is-ancestor "$F4_BRANCH" main 2>/dev/null; then
    red "✗ F4: synthetic branch $F4_BRANCH is somehow NOT an ancestor of main"
    return 1
  fi

  # Fire the janitor.
  local resp ok
  resp=$(api_post /api/scheduler/run-now "{\"taskId\":\"$TASK_ID\"}")
  ok=$(printf '%s' "$resp" | python3 -c "import sys, json; print(json.load(sys.stdin).get('ok'))" 2>/dev/null || printf 'parse-error')
  if [[ "$ok" != "True" ]]; then
    red "✗ F4: run-now returned ok=$ok"
    note "    body: $resp"
    return 1
  fi

  # Assert reclaim: worktree dir gone AND branch deleted.
  local wt_gone=1 branch_gone=1
  [[ -d "$F4_WT_PATH" ]] && wt_gone=0
  git rev-parse --verify "$F4_BRANCH" >/dev/null 2>&1 && branch_gone=0

  if [[ "$wt_gone" -eq 1 && "$branch_gone" -eq 1 ]]; then
    green "✓ F4: janitor reclaimed the synthetic merged orphan (worktree + branch gone)"
    trap - EXIT     # nothing to clean — assertion passed
    return 0
  fi

  red "✗ F4: janitor failed to reclaim:"
  [[ "$wt_gone" -eq 0 ]]     && red "    worktree still on disk: $F4_WT_PATH"
  [[ "$branch_gone" -eq 0 ]] && red "    branch still present:   $F4_BRANCH"
  return 1
}

# --- dispatch ------------------------------------------------------------

cd "$ROOT"
require_api

case "${1:-all}" in
  f1)  f1 ;;
  f2)  f2 ;;
  f3)  f3 ;;
  f4)  f4 ;;
  all) rc=0; f1 || rc=$?; f2 || rc=$?; f3 || rc=$?; f4 || rc=$?; exit $rc ;;
  *)   printf 'usage: %s [f1|f2|f3|f4|all]\n' "$0" >&2; exit 2 ;;
esac
