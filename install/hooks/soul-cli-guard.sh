#!/bin/bash
# ADR-003 Phase 3b — soul-cli chokepoint hook (Bash side).
#
# Closes the back-channel that ADR-001/002 left open: even after `soul`
# shipped, the 2026-05-20 falsifier reported 1,247 read + 324 write
# anti-patterns/week (raw curl / inline python against /api/*) vs 362
# `soul` invocations. CLAUDE.md preambles and the memory pointer
# underperformed. This hook is the structural fix — same posture as
# `vault-write-guard-bash.sh` for ADR-046.
#
# Mode (soft-warn rollout per ADR-003 §Roll-out):
#   - DEFAULT (no env var):                exit 0 + stderr warning
#   - SOUL_CLI_GUARD_MODE=block:           exit 2 (refused; agent retries)
#   - SOUL_CLI_GUARD_MODE=off:             exit 0 silently (kill-switch)
#
# Coverage: matches `curl|wget` against `localhost:2400/api/*` and
# `python|python3 -c '...'` blocks that import requests/httpx/urllib AND
# reference `localhost:2400/api/`. Forwards the matching `soul` verb name
# in the refusal so the agent can self-correct without grepping --help.
#
# Exempt callers (matched BEFORE refusal):
#   - The CLI itself (`soul ...`, `~/.local/bin/soul`, `cli/soul`)
#   - The falsifier script (writes its own report via curl by design)
#   - The doctor script (probes the API surface to report status)
#   - The /vault-write skill internals (also chokepoint-internal)
#   - Anything under ~/.claude/hooks/ or install/hooks/
#
# Known limitations (deferred):
#   - Inline interpreter calls that hide the URL (e.g. constructing the
#     path from variables). Hook only sees the literal command string.
#   - Sub-agent invocations via the Task tool — those fire in a sibling
#     process the hook doesn't intercept. Agent-side discipline matters.

set -euo pipefail

MODE="${SOUL_CLI_GUARD_MODE:-warn}"
[ "$MODE" = "off" ] && exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
[ "$TOOL_NAME" = "Bash" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
[ -n "$COMMAND" ] || exit 0

# Pattern detection — python3 for regex + lookup-table.
RESULT=$(python3 - "$COMMAND" <<'PYEOF'
import sys
import re

cmd = sys.argv[1]

# ─────────────────────────── EXEMPT CALLERS ───────────────────────────
# Matched BEFORE refusal. Order matters; first hit wins.
EXEMPT_PATTERNS = [
    # The CLI binary itself — most common, agent did the right thing.
    # `\bsoul\b(?!\s*=)` matches `soul …` invocation but NOT `soul=foo`
    # variable assignment. Whitespace lookahead avoids partial-word hits.
    r'\bsoul\s+(?!=)[a-z]',
    r'(~/\.local/bin/soul|cli/soul)\b',
    # The falsifier script writes its own report via curl by design.
    r'scripts/soul-cli-uptake-check\.sh',
    # The doctor script probes the API surface.
    r'scripts/doctor\.mjs',
    # The /vault-write skill internals call /api/vault/notes by design
    # (chokepoint-internal).
    r'\.claude/skills/vault-write/',
    # Hook scripts themselves.
    r'\.claude/hooks/',
    r'install/hooks/',
    # Print-routes calls (future-proof: when soul exposes its route map).
    r'\bsoul\s+--print-routes\b',
]

for pat in EXEMPT_PATTERNS:
    if re.search(pat, cmd):
        print('exempt')
        sys.exit(0)

# ─────────────────────────── ROUTE → VERB MAP ─────────────────────────
# Order matters: most-specific patterns FIRST so prefix collisions don't
# misroute (e.g. /vault/projects/X/next-actions must hit before /vault/
# /projects). Each (regex, verb_hint) tuple maps a path *under /api/* to
# the canonical soul verb. verb_hint is a human-readable string shown
# verbatim in the refusal.
ROUTE_MAP = [
    # vault — most-specific first
    (r'^vault/hygiene\b',                          'soul vault hygiene'),
    (r'^vault/reindex\b',                          'soul vault reindex'),
    (r'^vault/writes\b',                           'soul vault writes'),
    (r'^vault/unresolved\b',                       'soul vault unresolved'),
    (r'^vault/recent\b',                           'soul vault recent'),
    (r'^vault/projects/graph\b',                   'soul project graph'),
    (r'^vault/projects/similar\b',                 'soul project similar --slug <new-slug>'),
    (r'^vault/projects/[^/?]+/next-actions\b',     'soul project next-actions <slug>'),
    (r'^vault/projects/[^/?]+/ship-slice\b',       'soul project ship-slice <slug> --adr X --slice S<N> --status STATUS'),
    (r'^vault/projects/[^/?]+/propose-adr\b',      "soul project propose-adr <slug> --input-json '{...}'"),
    (r'^vault/projects/[^/?]+/falsifiers\b',       'soul project get <slug> (or --json | jq .upcomingFalsifiers)'),
    (r'^vault/projects/[^/?]+/proposals\b',        '(no soul verb yet — see soul --help)'),
    (r'^vault/projects(/|\?|$)',                   'soul project list / soul project get <slug>'),
    (r'^vault/decisions/transition\b',             'soul adr accept|ship|park|reject <path>'),
    (r'^vault/notes(/|\?|$)',                      'soul vault search / soul vault get / soul note create|update'),
    # naseej
    (r'^recipes/run\b',                            'soul recipe run <name> [--mode test|production|oneshot]'),
    (r'^recipes/runs/[^/?]+/cancel\b',             'soul recipe cancel <run-id>'),
    (r'^recipes(/|\?|$)',                          'soul recipe list / soul recipe get <name>'),
    (r'^components(/|\?|$)',                       'soul component list / soul component get <name>'),
    (r'^naseej/audit\b',                           'soul naseej audit --type runs|publishes'),
    # scheduler + inbox
    (r'^scheduler/run-now\b',                      'soul scheduler run-now <task-id>'),
    (r'^scheduler/tasks\b',                        'soul scheduler tasks'),
    (r'^inbox/digest-telegram\b',                  'soul inbox digest-telegram'),
    (r'^inbox/messages\b',                         'soul inbox queued (filters via --status)'),
    # crm + intent
    (r'^crm/contacts\b',                           'soul crm find / soul crm followups'),
    (r'^intent/metrics\b',                         'soul intent metrics'),
]

# ─────────────────────────── BACK-CHANNEL DETECTORS ───────────────────
# Each tuple: (regex, tool-name-for-msg).
# The regex must capture ONE group: the path under /api/.
DETECTORS = [
    # curl ... localhost:2400/api/<path>
    (r'\bcurl\b[^|&;\n]*\blocalhost:2400/api/([A-Za-z0-9/_-]+)',           'curl'),
    # wget ... localhost:2400/api/<path>
    (r'\bwget\b[^|&;\n]*\blocalhost:2400/api/([A-Za-z0-9/_-]+)',           'wget'),
    # python -c '...localhost:2400/api/<path>...' that uses requests/httpx/urllib.
    # DOTALL because the -c block can span multiple lines.
    (r'(?:python3?|python)\b[^|&;\n]*-c\b[^|&;\n]*?(?:requests|httpx|urllib)[\s\S]*?localhost:2400/api/([A-Za-z0-9/_-]+)', 'python'),
]

for det_pat, tool in DETECTORS:
    m = re.search(det_pat, cmd, re.DOTALL)
    if not m:
        continue
    path = m.group(1).rstrip('/')
    hint = '(no soul verb yet — see `soul --help`)'
    for rpat, vhint in ROUTE_MAP:
        if re.match(rpat, path):
            hint = vhint
            break
    # Pipe-delimited so bash awk parsing is straightforward (colons
    # appear inside the hint strings, e.g. `soul project ship-slice <slug> --adr X …`).
    print(f'match|{tool}|{path}|{hint}')
    sys.exit(0)

print('ok')
PYEOF
)

if [[ "$RESULT" == "ok" || "$RESULT" == "exempt" || -z "$RESULT" ]]; then
  exit 0
fi

# match|<tool>|<path>|<hint>
TOOL=$(echo "$RESULT" | awk -F'|' '{print $2}')
PATH_HIT=$(echo "$RESULT" | awk -F'|' '{print $3}')
HINT=$(echo "$RESULT" | awk -F'|' '{for (i=4; i<=NF; i++) printf "%s%s", $i, (i<NF?"|":"")}')

WARN_OR_BLOCK="WARNING"
EXIT_CODE=0
if [ "$MODE" = "block" ]; then
  WARN_OR_BLOCK="BLOCKED"
  EXIT_CODE=2
fi

cat >&2 <<EOF
[soul-cli-guard $WARN_OR_BLOCK] $TOOL → /api/$PATH_HIT

The soul CLI has a verb for this route:
  $HINT

Calling the API directly bypasses the CLI wrappers (lower context tax,
--json composition, --dry-run safety, audit trail in source_agent). It
also trips the weekly soul-cli-uptake-check falsifier from ADR-003.

Mode: $MODE  (export SOUL_CLI_GUARD_MODE=block to fail-close; or =off to disable)
See projects/soul-hub-cli/adr-003-chokepoint-hook-and-phase-3-verbs.md.
EOF

exit $EXIT_CODE
