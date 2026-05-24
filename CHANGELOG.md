# Changelog

All notable changes to Soul Hub are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.3] — 2026-05-24

### Added
- **Files in the header** — a folder icon now sits in the global header next to
  Terminal and Settings, so the file browser (`/files`) is reachable from any
  page instead of only the homepage card.

## [2.2.2] — 2026-05-24

### Fixed
- **One-click update build** — the in-app "Update now" flow (v2.2.0) failed at
  its build step because the updater runs under `NODE_ENV=production`, where
  `npm install` omits the devDependencies (`vite`, `svelte-kit`) the build
  needs. The updater now installs with `--include=dev` so the build always
  has its toolchain. (Manual `npm run update` from a shell was unaffected.)

## [2.2.0] — 2026-05-24

### Added
- **Update-available banner** — Soul Hub now checks once a day for a newer
  published release and shows a slim, dismissible banner ("Soul Hub vX.Y.Z is
  available" + a "What's new" link) when your build is behind. Read-only; the
  check reads a local cache, never blocks a page render, and works offline.
  (ADR-010)
- **One-click update** — the banner's **Update now** button runs the full
  update (`git pull → install → build → reload`) for you, with a confirmation
  modal and live progress; the page reloads itself when the new version is up.
  The update endpoint is locked to same-origin browser requests (an exposed
  port or a CSRF page cannot trigger it), verifies the git remote before
  pulling, and re-syncs the vault-write chokepoint on every update. (ADR-011)

### Notes
- Both features are controlled by the `updateCheck` flag in
  `~/.soul-hub/settings.json`, on by default for this distribution. Set it to
  `false` to hide the banner and disable the update endpoint.

## [2.1.0] — 2026-05-24

### Added
- **One-command public release** — `npm run release` assembles the public
  surface and publishes it to the public repo (history-preserving, never
  force-push); `--bump patch|minor|major` cuts a versioned GitHub Release
  (bump → tag → release). (ADR-013)
- **uv-first Python runtime** — `bootstrap.sh` now installs `uv`, and
  Soul-Hub Python scripts run via `uv run` with inline (PEP 723) dependencies;
  `doctor` checks for `uv`. (ADR-012)
- **Built-in daily vault backup** — the `vault-backup-daily` git-snapshot
  safety net is now a code-default scheduler task, so every install has it
  without hand-editing `settings.json`. (ADR-012)

### Changed
- **Quieter, more accurate fresh-install doctor** — `curl_cffi` is probed via
  yt-dlp (where it actually lives), `SOUL_HUB_PUBLIC_URL` only warns when the
  remote tunnel is enabled, and the operator-only `soul-hub-backup-daily` check
  is now informational. A correctly-set-up local install reports no spurious
  warnings. (ADR-012)
- **Guaranteed ADR titles** — `soul adr propose` injects the `# ADR-N — Title`
  H1 and the vault template validator enforces it.

### Fixed
- **Unified Inbox** — new IMAP mail is now fetched promptly via an IDLE
  `exists` handler plus a 5-minute poll fallback (previously sync could stall
  while the connection still showed "connected").

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

[2.2.3]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.3
[2.2.2]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.2
[2.2.0]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.0
[2.1.0]: https://github.com/jneaimi/soulhub/releases/tag/v2.1.0
[2.0.0]: https://github.com/jneaimi/soulhub/releases/tag/v2.0.0
