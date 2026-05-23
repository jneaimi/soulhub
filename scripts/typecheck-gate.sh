#!/usr/bin/env bash
#
# typecheck-gate.sh — ratcheting svelte-check baseline gate (ADR-005).
#
# `npm run check` (svelte-check) is NOT part of `vite build`, so type errors
# accrue invisibly. This gate freezes the current error count in
# .typecheck-baseline and fails a push that would change it:
#
#   count  > baseline  → REGRESSION  (new type errors) → block
#   count  < baseline  → RATCHET     (you improved!)    → block until you lower
#                                                          the baseline in-change
#   count == baseline  → OK
#
# The ratchet-on-improvement is deliberate: you cannot silently improve and
# later regress back into the slack. Run manually with `npm run typecheck:gate`
# or automatically via the .githooks/pre-push hook.
#
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 1

BASELINE_FILE=".typecheck-baseline"
if [[ ! -f "$BASELINE_FILE" ]]; then
	echo "❌ typecheck-gate: $BASELINE_FILE not found at repo root." >&2
	exit 1
fi
baseline="$(tr -dc '0-9' < "$BASELINE_FILE")"
if [[ -z "$baseline" ]]; then
	echo "❌ typecheck-gate: $BASELINE_FILE does not contain an integer." >&2
	exit 1
fi

echo "[typecheck-gate] running svelte-check (baseline=$baseline)…"
# svelte-check exits non-zero when errors exist; capture regardless.
output="$(npm run check 2>&1 || true)"

# The summary line looks like: "… COMPLETED 1902 FILES 3 ERRORS 91 WARNINGS …"
count="$(printf '%s\n' "$output" | grep -oE '[0-9]+ ERRORS' | tail -1 | grep -oE '^[0-9]+')"
if [[ -z "$count" ]]; then
	echo "❌ typecheck-gate: could not parse an error count from svelte-check output:" >&2
	printf '%s\n' "$output" | tail -8 >&2
	exit 1
fi

echo "[typecheck-gate] current=$count  baseline=$baseline"

if (( count > baseline )); then
	echo ""
	echo "❌ REGRESSION — $count type errors > baseline $baseline."
	echo "   Your change introduced $(( count - baseline )) new svelte-check error(s)."
	echo "   Fix them, then push again. (Run 'npm run check' to see them.)"
	exit 1
elif (( count < baseline )); then
	echo ""
	echo "❌ RATCHET — $count type errors < baseline $baseline. Nice, you cleared $(( baseline - count ))!"
	echo "   Lock it in so it can't regress: lower the baseline in THIS change."
	echo "     echo $count > $BASELINE_FILE && git add $BASELINE_FILE"
	exit 1
fi

echo "✅ typecheck-gate: $count == baseline. OK to push."
exit 0
