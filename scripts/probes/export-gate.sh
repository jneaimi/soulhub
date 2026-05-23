#!/usr/bin/env bash
#
# export-gate.sh — ADR-008 (oss-hardening) public-export safety gate.
#
# Validates an assembled public-export tree (from release-export.sh) is clean
# BEFORE it is committed/pushed to the public repo. Fails closed.
#
# Under the feature-flag model (ADR-008) the not-ready module CODE ships and is
# hidden by flags — so this gate does NOT check for module imports. It enforces:
#   1. No PERSONAL CONTENT present (brand assets, personal recipes/agents, DBs, archives).
#   2. No tracked SQLite DBs.
#   3. No author domain (jneaimi.com) in code positions (src/ + ecosystem.config.cjs).
#   4. Feature flags seeded OFF in settings.example.json (public hides not-ready modules).
#
# Usage:  scripts/probes/export-gate.sh <TARGET_DIR>
#
set -uo pipefail
TARGET="${1:?usage: export-gate.sh <TARGET_DIR>}"
[ -d "$TARGET" ] || { echo "export-gate: TARGET '$TARGET' is not a directory" >&2; exit 2; }

fail=0
note() { echo "  FAIL: $1" >&2; fail=1; }

# ── 1. No personal-content paths present ─────────────────────────────────
PERSONAL=(
  "catalog/brands/jneaimi" "catalog/recipes/peer-brief" "catalog/recipes/peer-brief-rebuild"
  "catalog/agents" "catalog/components/katib-build"
  "pipelines/_archive" "pipelines/_archive-2026-05-16" "src/lib/_archive"
  "tests/fixtures/adr-008-known-failures.jsonl"
)
for p in "${PERSONAL[@]}"; do
  [ -e "$TARGET/$p" ] && note "personal-content path present: $p"
done

# ── 2. No tracked SQLite DBs ─────────────────────────────────────────────
dbs=$(find "$TARGET" -type f \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \) 2>/dev/null || true)
[ -n "$dbs" ] && { note "SQLite DB(s) present:"; echo "$dbs" | sed 's/^/      /' >&2; }

# ── 3. No author domain in code positions ───────────────────────────────
dom=$(grep -rnE 'jneaimi\.com' "$TARGET/src" "$TARGET/ecosystem.config.cjs" \
  --include='*.ts' --include='*.svelte' --include='*.js' --include='*.cjs' 2>/dev/null \
  | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*|<!--)' || true)
[ -n "$dom" ] && { note "author domain in code positions:"; echo "$dom" | sed 's/^/      /' >&2; }

# ── 4. Feature flags seeded OFF in the public settings template ──────────
SEX="$TARGET/settings.example.json"
if [ ! -f "$SEX" ]; then
  note "settings.example.json missing"
elif ! python3 - "$SEX" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
f = d.get("features", {})
ok = all(f.get(k) is False for k in ("naseej", "workspaces", "playbook"))
sys.exit(0 if ok else 1)
PY
then
  note "settings.example.json does not seed features.{naseej,workspaces,playbook} = false"
fi

if [ "$fail" -ne 0 ]; then
  echo "export-gate: FAILED" >&2
  exit 1
fi
echo "export-gate: OK (no personal content, no DBs, no author domain, features seeded off)"
