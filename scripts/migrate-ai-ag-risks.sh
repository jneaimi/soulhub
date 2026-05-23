#!/bin/bash
# scripts/migrate-ai-ag-risks.sh — projects-graph ADR-010
# Migrate ~/vault/projects/ai-agriculture-platform/risks/cr-*.md
#   - type: research → type: risk
#   - add severity: critical (lifted from existing `critical` tag)
#   - keep `critical` in tags (90-day back-compat)
#   - status: stays (already canonical-6 'accepted' post-ADR-002)
# Reports any file missing `## Impact` or `## Mitigation` sections
# (ADR-009 risk template) for operator hand-author follow-up.
#
# Default mode: dry-run (no writes). Pass --apply to commit changes.

set -euo pipefail

VAULT_ROOT="${VAULT_ROOT:-$HOME/vault}"
RISKS_DIR="$VAULT_ROOT/projects/ai-agriculture-platform/risks"
APPLY=0
SOURCE_AGENT="adr-010-migration"

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ $APPLY -eq 0 ]]; then
  echo "=== DRY-RUN ===  (pass --apply to write)"
else
  echo "=== APPLYING via chokepoint ==="
fi
echo

FILES=()
while IFS= read -r line; do FILES+=("$line"); done < <(ls "$RISKS_DIR"/2026-04-29-cr-*.md 2>/dev/null | sort)
if [[ ${#FILES[@]} -ne 10 ]]; then
  echo "ERROR: expected 10 cr-NN files, found ${#FILES[@]}" >&2
  exit 3
fi

missing_impact=()
missing_mitigation=()
failures=()

for f in "${FILES[@]}"; do
  rel="${f#$VAULT_ROOT/}"
  name="$(basename "$f")"

  # current type + severity tag check
  current_type=$(awk '/^---$/{c++; if(c==2)exit; next} c==1 && /^type:/{print $2}' "$f")
  has_critical_tag=$(awk '/^---$/{c++; if(c==2)exit; next} c==1' "$f" | grep -c '  - critical' || true)

  # body section probe
  sections=$(grep -E '^## ' "$f" | sed 's/^## //')
  has_impact=$(echo "$sections" | grep -c -i '^impact$' || true)
  has_mitigation=$(echo "$sections" | grep -c -i '^mitigation$' || true)

  [[ "$has_impact" -eq 0 ]] && missing_impact+=("$name")
  [[ "$has_mitigation" -eq 0 ]] && missing_mitigation+=("$name")

  echo "→ $name"
  echo "    current type: $current_type  /  critical tag: $has_critical_tag  /  ## Impact: $has_impact  /  ## Mitigation: $has_mitigation"

  if [[ "$current_type" == "risk" ]]; then
    echo "    SKIP: already type: risk"
    continue
  fi

  if [[ "$has_critical_tag" -eq 0 ]]; then
    echo "    WARN: no \`critical\` tag found — severity inference unsafe; flagging"
    failures+=("$name (no critical tag)")
    continue
  fi

  if [[ $APPLY -eq 1 ]]; then
    if soul note update "$rel" \
         --meta-json "{\"type\":\"risk\",\"severity\":\"critical\",\"source_agent\":\"$SOURCE_AGENT\"}" \
         >/dev/null; then
      echo "    OK"
    else
      echo "    FAIL"
      failures+=("$name (soul update failed)")
    fi
  else
    echo "    DRY-RUN would: type→risk + severity:critical (tag preserved)"
  fi
done

echo
echo "=== Section conformance report (ADR-009 risk template) ==="
echo "Missing '## Impact' (${#missing_impact[@]}/10):"
for n in "${missing_impact[@]}"; do echo "  - $n"; done
echo
echo "Missing '## Mitigation' (${#missing_mitigation[@]}/10):"
for n in "${missing_mitigation[@]}"; do echo "  - $n"; done
echo
echo "Note: chokepoint validates templates on CREATE only (ADR-009 drift), so"
echo "      updates pass without these sections. Hand-author follow-up per ADR-010."
echo

if [[ ${#failures[@]} -gt 0 ]]; then
  echo "=== FAILURES ==="
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 4
fi

echo "Done."
