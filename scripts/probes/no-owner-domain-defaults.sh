#!/usr/bin/env bash
#
# no-owner-domain-defaults.sh — ADR-055 standing falsifier contract.
#
# Fails if the author's domain (jneaimi.com) appears in a CODE position in
# src/** or ecosystem.config.cjs. Pure comment lines are allowed (the domain
# may legitimately appear in explanatory comments). Path helpers like
# `/Users/jneaimi` and the repo URL `github.com/jneaimi/...` do not match the
# `jneaimi.com` pattern, so they pass.
#
# Run standalone:  bash scripts/probes/no-owner-domain-defaults.sh
# Wired into:      .githooks/pre-push (alongside typecheck-gate.sh)
#
# NOTE: the tracked-`*.db` and `catalog/brands/<owner>/` assertions (ADR-055
# P1d + ADR-056) are added when those cleanups land; this guards the domain.
#
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

hits=$(grep -rnE 'jneaimi\.com' src ecosystem.config.cjs \
  --include='*.ts' --include='*.svelte' --include='*.js' --include='*.cjs' 2>/dev/null \
  | grep -vE ':[0-9]+:[[:space:]]*(//|\*|<!--)' \
  || true)

if [ -n "$hits" ]; then
  echo "FAIL (no-owner-domain-defaults): author domain found in code positions:" >&2
  echo "$hits" >&2
  echo "" >&2
  echo "Use the branding helpers (src/lib/branding.ts) or ~/.soul-hub/.env instead." >&2
  exit 1
fi
echo "OK (no-owner-domain-defaults): no author-domain literals in src/ or ecosystem.config.cjs"
