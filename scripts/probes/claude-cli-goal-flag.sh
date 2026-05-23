#!/usr/bin/env bash
# Monthly probe — does `claude -p --goal` exist in headless mode yet?
#
# Per ADR-031 (~/vault/projects/soul-hub-whatsapp/adr-031-goal-command-agent-loops.md)
# Decision 3 — the `claude-cli-flag` backend can't pre-load /goal in Claude
# Code v2.1.143 (verified 2026-05-18). When Anthropic ships a headless flag,
# we want to know within ~30 days so the pending dispatch wiring can be
# picked up. Tracked as scheduler task `claude-cli-goal-flag-probe`.
#
# Detection: greps `claude -p --help` for `--goal`. Sends Telegram alert
# when found. Exits 0 either way so the scheduler doesn't flag it failed.

set -u

if ! command -v claude >/dev/null 2>&1; then
  echo "[claude-cli-goal-flag] claude binary not on PATH — skipping" >&2
  exit 0
fi

if claude -p --help 2>&1 | grep -q -- '--goal'; then
  if [ -z "${TELEGRAM_CHAT_ID:-}" ] || [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "[claude-cli-goal-flag] --goal detected but TELEGRAM_* env missing — cannot notify" >&2
    exit 0
  fi
  MSG=$'\xe2\x9c\x85 Claude Code shipped headless --goal flag.\n\nRe-open ADR-031 cli-flag wiring:\n~/vault/projects/soul-hub-whatsapp/adr-031-goal-command-agent-loops.md\n\nADR-052 (per-dispatch override) and naseej ADR-020 (per-step mode) are the immediate successors.\n\nProbe: ~/dev/soul-hub/scripts/probes/claude-cli-goal-flag.sh'
  curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${MSG}" >/dev/null || {
      echo "[claude-cli-goal-flag] Telegram send failed" >&2
      exit 0
    }
  echo "[claude-cli-goal-flag] notified — headless --goal landed"
else
  echo "[claude-cli-goal-flag] no --goal flag in claude -p --help (Claude Code $(claude --version 2>&1 | head -1))"
fi

exit 0
