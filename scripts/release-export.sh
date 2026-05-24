#!/usr/bin/env bash
#
# release-export.sh — ADR-008 (oss-hardening) two-repo distribution.
#
# Produces the public surface of Soul Hub by copying the tracked platform files
# (minus a denylist of PERSONAL CONTENT) into a target directory and seeding the
# feature flags OFF so not-yet-released modules (Naseej, Workspaces) and the
# decommissioning Playbook engine are hidden in the public build. It NEVER
# touches the private repo's git, the live :2400 instance, or any public remote
# — it only writes TARGET.
#
# Per ADR-008 the not-ready module CODE ships (flag-hidden), so there is no
# module-exclusion or glue-override here — only personal *content* is withheld.
#
# Usage:
#   scripts/release-export.sh [TARGET_DIR]   (default: /tmp/soul-hub-public-export)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-/tmp/soul-hub-public-export}"

if [ -t 1 ]; then B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m'); R=$(printf '\033[31m'); X=$(printf '\033[0m'); else B=""; G=""; Y=""; R=""; X=""; fi
step() { printf "%s==>%s %s\n" "$B" "$X" "$1"; }
ok()   { printf "  %s✓%s %s\n" "$G" "$X" "$1"; }
warn() { printf "  %s!%s %s\n" "$Y" "$X" "$1"; }

# ── Denylist — PERSONAL CONTENT withheld from public (NOT module code) ──────
# Module source (naseej / projects / playbook) ships and is flag-hidden (ADR-008).
DENY_PREFIXES=(
  "catalog/brands/jneaimi"            # operator's brand assets (2.2 MB)
  "catalog/recipes/peer-brief"        # operator's signal-forge output recipe
  "catalog/recipes/peer-brief-rebuild"
  "catalog/agents"                    # signal-forge + box-motif agents (personal/dead, unwired)
  "catalog/components/katib-build"    # deprecated, wraps the external ~/dev/katib app
  "pipelines/_archive"                # dead legacy-pipeline data
  "pipelines/_archive-2026-05-16"
  "src/lib/_archive"                  # dead legacy-pipeline code
  "tests/fixtures/adr-008-known-failures.jsonl"  # 5.7 MB personal fixture
  "install/public"                    # public-only overlay assets (README), applied below — not shipped at this path
  "static/screenshots/playbooks.png"  # marketing imagery of flag-hidden modules
  "static/screenshots/project.png"
)

is_denied() {
  local f="$1"
  for p in "${DENY_PREFIXES[@]}"; do
    case "$f" in "$p"|"$p"/*) return 0 ;; esac
  done
  case "$f" in *.db|*.db-wal|*.db-shm) return 0 ;; esac
  return 1
}

step "Assembling public export → $TARGET"
rm -rf "$TARGET"; mkdir -p "$TARGET"

copied=0; skipped=0
while IFS= read -r -d '' f; do
  if is_denied "$f"; then skipped=$((skipped+1)); continue; fi
  mkdir -p "$TARGET/$(dirname "$f")"
  cp "$ROOT/$f" "$TARGET/$f"
  copied=$((copied+1))
done < <(git -C "$ROOT" ls-files -z)
ok "copied $copied tracked files, withheld $skipped personal-content files"

# Seed feature flags in the public settings template. Not-yet-released modules
# (Naseej / Workspaces / Playbook) ship OFF until the operator opts in.
# updateCheck is the INVERSE of the canonical default: ON for public installs
# (so strangers see the update-available banner — ADR-010) but OFF on the
# operator's private command center, which develops features before they ship.
step "Seeding feature flags in settings.example.json"
SEX="$TARGET/settings.example.json"
if [ -f "$SEX" ]; then
  python3 - "$SEX" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["features"] = {"naseej": False, "workspaces": False, "playbook": False, "updateCheck": True}
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
PY
  ok "features = {naseej:false, workspaces:false, playbook:false, updateCheck:true}"
else
  warn "settings.example.json missing in export — features not seeded"
fi

# Overlay the public README (ADR-008). The private repo's README describes the
# full operator instance — including flag-hidden modules — so the public tree
# gets a dedicated README from install/public/ that markets only the shipped
# surface. Content overlay only; no code is swapped.
step "Overlaying public README"
PUB_README="$ROOT/install/public/README.md"
if [ -f "$PUB_README" ]; then
  cp "$PUB_README" "$TARGET/README.md"
  ok "README.md ← install/public/README.md"
else
  warn "install/public/README.md missing — public README NOT overlaid"
fi

# Point the public package.json at the public repo (the private repo URL would
# 404 for strangers) and give it a description that matches the shipped surface.
step "Rewriting package.json metadata for the public repo"
PKG="$TARGET/package.json"
if [ -f "$PKG" ]; then
  python3 - "$PKG" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault("repository", {})["url"] = "https://github.com/jneaimi/soulhub.git"
d["homepage"] = "https://github.com/jneaimi/soulhub"
d["bugs"] = {"url": "https://github.com/jneaimi/soulhub/issues"}
d["description"] = ("A local-first, single-user ambient AI command center — chat "
                    "(WhatsApp/Telegram), a unified inbox, a governed knowledge "
                    "vault, terminal, scheduler, and pipelines, powered by Claude Code")
json.dump(d, open(p, "w"), indent="\t")
open(p, "a").write("\n")
PY
  ok "repository → soulhub, description → public surface"
else
  warn "package.json missing in export — metadata not rewritten"
fi

step "Running export gate"
if bash "$ROOT/scripts/probes/export-gate.sh" "$TARGET"; then
  ok "export gate PASSED"
else
  printf "\n%sExport gate FAILED — public tree NOT clean. Fix above, re-run.%s\n" "$R" "$X" >&2
  exit 1
fi

echo
printf "%sExport assembled at:%s %s\n" "$B" "$X" "$TARGET"
printf "Next: cd %s && npm install && npm run build   (verify the public tree builds)\n" "$TARGET"
