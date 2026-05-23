# Changelog

All notable changes to Soul Hub are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-05-23

First public release of Soul Hub — a local-first, single-user ambient AI
command center, orchestrated by Claude Code.

### Added
- **Chat** — message Soul Hub from WhatsApp or Telegram; a Claude orchestrator
  routes each request to the right tool (vault, inbox, search, reminders) and
  streams progress back as it works.
- **Unified Inbox** — connect an email account; surface queued messages, drill
  into threads, and draft replies from chat or the web UI.
- **Vault** — governed, Obsidian-compatible knowledge graph: 6 zones, 60+ note
  types, full-text search, smart filters, Arabic RTL, and rate-limited,
  deduplicated, audited agent writes.
- **Pipelines** — visual multi-step pipelines (Python/Bash/Node), chained into
  DAGs, run on cron, webhooks, or folder watches; agent steps run Claude Code.
- **Terminal** — browser `node-pty` + xterm.js sessions with logging + history.
- **Scheduler** — unified view of every scheduled job with countdowns and run
  history.
- **`soul` CLI** — bash-native wrapper over the vault/projects/CRM/scheduler API.
- **`/api/system/version`** — reports the running build's name + semver.
- **`npm run update`** — pull latest, install, build, and reload a running
  production process with zero downtime (no-ops safely on a dev checkout).

### Notes
- Some modules ship in the codebase but are hidden behind feature flags, off by
  default in the public distribution: **Naseej** and **Workspaces** (still in
  development) and the **Playbook** engine (being decommissioned). Enable them
  via `features` in `~/.soul-hub/settings.json` at your own risk.

[2.0.0]: https://github.com/jneaimi/soulhub/releases/tag/v2.0.0
