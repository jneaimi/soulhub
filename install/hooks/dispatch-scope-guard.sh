#!/bin/bash
# ADR-020 P4 — Mid-run dispatch-scope enforcement
#
# PreToolUse hook that refuses Write / Edit / MultiEdit / NotebookEdit calls
# whose target path is outside the dispatched ADR's declared scope.
#
# The dispatcher (`src/lib/agents/dispatch/index.ts`) snapshots the ADR's
# `scope: { allowed_paths, forbidden_paths }` frontmatter to
# `agent_runs.scope_json` at dispatch start, and stamps `claude_session_id`
# on the running row. This hook joins on `claude_session_id` to look up
# the scope for THIS session and decides allow/block.
#
# Decision logic:
#   - no scope_json for this session (legacy, no `scope:` block, non-dispatch
#     session, operator-typed claude session)  → allow (silent)
#   - forbidden_paths match (exact OR prefix-with-/)                  → block
#   - allowed_paths non-empty AND target doesn't match                → block
#   - otherwise                                                        → allow
#
# Block surface:
#   - exit code 2 + stderr — Claude's PreToolUse contract treats this as a
#     hard block; the agent sees the stderr in its tool_result and must
#     replan or pause-and-ask (ADR-019 P1).
#   - the attempt is logged to `dispatch_scope_blocks` so the operator
#     gets an audit trail.
#
# This hook ONLY affects sessions dispatched through Soul Hub's claude-pty
# backend (the only one that doesn't set CLAUDE_CODE_DISABLE_HOOKS=1). The
# cli-flag and stream-json backends are by-design unenforced.
#
# Hook invocation: registered in ~/.claude/settings.json under
# `hooks.PreToolUse[]` matching `Edit|Write|MultiEdit|NotebookEdit`.

set -euo pipefail

OPS_DB="${SOUL_HUB_OPS_DB:-$HOME/.soul-hub/data/ops/ops.db}"

# No DB → nothing to enforce against. Fail open so a half-installed
# Soul Hub doesn't break the operator's local Claude session.
if [ ! -f "$OPS_DB" ]; then
  exit 0
fi

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
# CWD as reported by Claude Code in the PreToolUse payload. Used by matches()
# below to relativise absolute targets so a forbidden entry like
# `.worktrees/**` refers to a `.worktrees/` dir UNDER the cwd, not the
# `.worktrees/` segment in the cwd's own path (ADR-022 worktrees live at
# `.../.worktrees/<slug>/`). Older Claude Code versions that don't pass cwd
# fall back to a lenient containment match — see matchesPath() in
# src/lib/agents/dispatch/resolve-adr-scope.ts for the same logic in TS.
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Only enforce on path-writing tools.
case "$TOOL_NAME" in
  Write|Edit|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

# No session_id → can't join. Fail open (operator-typed sessions, hooks
# fired in non-Claude contexts, etc.).
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Extract the target path. NotebookEdit uses `notebook_path`; others use
# `file_path`. MultiEdit uses `file_path` for the file being multi-edited.
case "$TOOL_NAME" in
  NotebookEdit)
    TARGET=$(echo "$INPUT" | jq -r '.tool_input.notebook_path // ""')
    ;;
  *)
    TARGET=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
    ;;
esac

# No target → nothing to match against. Fail open.
if [ -z "$TARGET" ]; then
  exit 0
fi

# Look up THIS session's scope. The running row is keyed on claude_session_id,
# set at dispatch start via updateRunSessionId().
SCOPE_JSON=$(sqlite3 -readonly "$OPS_DB" \
  "SELECT COALESCE(scope_json, '') FROM agent_runs WHERE claude_session_id = '$SESSION_ID' ORDER BY id DESC LIMIT 1;" \
  2>/dev/null || echo "")

# No scope → not a dispatched run, or ADR has no `scope:` block. Allow.
if [ -z "$SCOPE_JSON" ] || [ "$SCOPE_JSON" = "null" ]; then
  exit 0
fi

# Decide allow/block via jq path-matching. We evaluate forbidden_paths first
# (block always wins), then allowed_paths (when non-empty, only listed paths
# are allowed).
#
# Match semantics (MUST stay in lock-step with src/lib/agents/dispatch/
# resolve-adr-scope.ts → matchesPath; cross-validated by the unit suite):
#   1. Normalise the scope entry: strip trailing `/**`, `**`, and trailing `/`.
#      So `src/lib/vault/**`, `src/lib/vault/`, and `src/lib/vault` all coerce
#      to `src/lib/vault`. Empty after strip = wildcard (matches everything).
#   2. Exact equality                      → match.
#   3. Absolute entry (starts with `/`)    → target startswith entry+`/`.
#   4. Relative entry (operator-authored)  → target startswith entry+`/` OR
#      target contains `/entry/` as a path segment. The path-segment containment
#      is what lets a YAML entry like `src/lib/vault/**` match an absolute
#      Claude Code target `/Users/.../worktree/src/lib/vault/index.ts`.
#
# Bug fix 2026-05-29 (#60): previously the matcher did pure exact-or-prefix
# against the entry as written — so relative + glob entries against absolute
# targets always failed, falsely blocking every Edit/Write in run 525.
#
# Implementation note: when invoking `matches(...; .)` via `map`, jq
# lazy-evaluates `.` against the OUTER pipe context (which changes inside the
# function body), so we capture the array element via `. as $e | matches(...; $e)`
# before calling. Without this, the closure-captured entry leaks into the
# next iteration and matching silently breaks (caught by smoke test).
DECISION=$(echo "$SCOPE_JSON" | jq --arg target "$TARGET" --arg cwd "$CWD" -r '
  def normalise(entry):
    entry
    | sub("/\\*\\*$"; "")
    | sub("\\*\\*$"; "")
    | if (. != "/" and endswith("/")) then .[0:-1] else . end ;
  def matches(target; entry; cwd):
    (normalise(entry)) as $e |
    if $e == "" then true
    elif ($e | startswith("/")) then
      target == $e or (target | startswith($e + "/"))
    elif (cwd != "" and (target | startswith(cwd + "/"))) then
      # Relativise target to cwd, then strict prefix match. This is the path
      # operators actually mean when they write `src/lib/vault/**` or
      # `.worktrees/**` in an ADR — those entries are cwd-relative.
      (target[(cwd | length) + 1:]) as $rel |
      $rel == $e or ($rel | startswith($e + "/"))
    else
      # Lenient fallback: target is itself relative, or cwd is absent / target
      # is outside cwd. Allow path-segment containment so a relative entry
      # still bites a foreign-prefixed absolute target.
      target == $e
      or (target | startswith($e + "/"))
      or (target | contains("/" + $e + "/"))
    end ;
  . as $scope |
  (.forbidden_paths // []) as $forbidden |
  (.allowed_paths // []) as $allowed |
  if ($forbidden | map(. as $e | matches($target; $e; $cwd)) | any) then
    {decision: "block", reason: "forbidden_paths matches",
     matched: ($forbidden | map(select(. as $e | matches($target; $e; $cwd))) | .[0])}
  elif ($allowed | length) > 0 and (($allowed | map(. as $e | matches($target; $e; $cwd))) | any | not) then
    {decision: "block", reason: "allowed_paths set but target not in it", count: ($allowed | length)}
  else
    {decision: "allow"}
  end
')

# Allow → exit 0 quietly.
if [ "$(echo "$DECISION" | jq -r '.decision')" = "allow" ]; then
  exit 0
fi

# Block: log to dispatch_scope_blocks (best-effort; never fail the block
# itself just because the log write failed).
REASON=$(echo "$DECISION" | jq -r '.reason')
RUN_ID=$(sqlite3 -readonly "$OPS_DB" \
  "SELECT run_id FROM agent_runs WHERE claude_session_id = '$SESSION_ID' ORDER BY id DESC LIMIT 1;" \
  2>/dev/null || echo "")
# Portable epoch-ms: `date +%s%3N` is GNU-only (BSD date on macOS leaves a
# literal "3N" suffix → invalid SQL). Use python (everywhere on macOS +
# Linux), fall back to seconds*1000 if python missing.
NOW=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo $(($(date +%s) * 1000)))
sqlite3 "$OPS_DB" "INSERT INTO dispatch_scope_blocks (run_id, claude_session_id, tool_name, target_path, reason, blocked_at) VALUES ('${RUN_ID}', '${SESSION_ID}', '${TOOL_NAME}', '${TARGET//\'/\'\'}', '${REASON//\'/\'\'}', ${NOW});" 2>/dev/null || true

# Emit a structured error message to stderr so the agent sees a clear
# reason in its tool_result and can pause-and-ask (ADR-019 P1) or replan.
cat >&2 <<EOF
BLOCKED by ADR-020 P4 dispatch-scope enforcement.

Tool:    $TOOL_NAME
Target:  $TARGET
Reason:  $REASON

This dispatch is bounded by the ADR's \`scope:\` frontmatter. To write
this file you must either:
  1. Pause and ask the operator (ADR-019 P1 ask-operator surface), OR
  2. Adjust your plan to stay within scope.

The ADR's authored \`scope:\` block is the source of truth. Operator
can amend it by editing the ADR's frontmatter and re-dispatching.
EOF

exit 2
