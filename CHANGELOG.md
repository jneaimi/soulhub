# Changelog

All notable changes to Soul Hub are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.0] — 2026-05-25

### Added
- **Link-safe note relocation** — `soul note move <src> <dst-zone> [--rename …]`,
  `soul note rename <src> <new-filename>`, and `soul adr move <src> --project …`
  relocate a note and **rewrite every inbound wikilink across the vault** — both
  body links and frontmatter relationship fields (`relates_to`, `supersedes`, …)
  — so nothing breaks. Backed by a new `POST /api/vault/notes/move` endpoint.
- **Batch relocation** — `soul note move-batch` (and the endpoint's `moves: […]`)
  moves a whole set of notes in one pass. Mutually-referencing notes relocate
  without the old two-step "create-then-relink" workaround, because all files
  move before any link is rewritten.
- **`--dry-run`** on every relocation verb — prints the planned destinations and
  the exact notes whose links would be rewritten, writing nothing.

## [2.3.0] — 2026-05-25

### Added
- **`soul inbox accounts` / `soul inbox status`** — see email-account sync health
  from the CLI: per-account provider, status, last-sync age, and last error.
  `inbox status` flags any connected account whose last sync is older than 30
  minutes and exits non-zero, so it composes in health-check chains.
- **`soul doctor` now probes inbox staleness** — a stale connected account
  surfaces as a note alongside the existing API and catalog-index checks.
- **`--content-file PATH` and `--content -` (stdin)** on `note create`,
  `note update`, and `adr propose` — author multi-line note/ADR bodies from a
  file or a pipe instead of an inline `--content` string, avoiding shell quoting
  hazards and argument-length limits.
- **Per-verb `--help`** — `soul <noun> <verb> --help` (and `soul <noun> --help`)
  now prints usage for that verb instead of running it with missing arguments.

### Fixed
- **`--json` output is now safe to pipe to `jq` in all cases** — line/paragraph
  separator characters (U+2028/U+2029) in note bodies are escaped, so
  `soul vault get … --json | jq` no longer fails on certain notes.

## [2.2.9] — 2026-05-24

### Fixed
- **Inbox "synced Xh ago" label no longer freezes** — the timestamp tracks the
  actual sync again. The label reads `accounts.last_sync`, but that field was
  only refreshed when an account reconnected or recovered from an error. Once
  the IMAP IDLE + poll fix made background syncing work without reconnects, the
  label stuck at the initial-connect time while mail kept arriving. Routine
  syncs now stamp `accounts.last_sync` on every cycle, including the common
  "no new messages" poll.

## [2.2.8] — 2026-05-24

### Changed
- **Update check runs every 6 hours** (was once daily) — a freshly-published
  release now surfaces in the banner within hours instead of up to a day. Still
  a single lightweight GitHub call per check.

## [2.2.7] — 2026-05-24

### Added
- **Live update progress** — when you click "Update now", the banner now shows
  the real step in progress ("pulling latest", "installing dependencies",
  "building", "restarting") and surfaces an explicit failure reason the moment
  something goes wrong, instead of spinning until a 120-second timeout. Powered
  by a status file the updater writes and `/api/system/version` reports.

## [2.2.6] — 2026-05-24

### Fixed
- **One-click update no longer blocked by `package-lock.json` drift** — every
  `npm install` rewrites the lockfile's version field, which left the working
  tree "dirty" and made the updater refuse to pull (the click appeared to run,
  then nothing happened). The updater now discards lockfile-only drift and
  proceeds; releases keep `package-lock.json` in lockstep with `package.json`
  so the drift stops being created; and the update endpoint now returns an
  immediate, explicit error if the tree has *real* uncommitted changes instead
  of leaving the UI to time out after 120s.

## [2.2.5] — 2026-05-24

### Changed
- **Update banner refreshes itself** — the "update available" banner now checks
  for a new release every ~10 minutes in the background, so it appears for
  operators who keep Soul Hub open without needing to refresh or navigate.
  Updates in place (no full reload), only runs when update notifications are
  enabled, and pauses while an update is in progress.

## [2.2.4] — 2026-05-24

### Fixed
- **Feature flags now survive upgrades** — flags added in a newer version are
  back-filled into your `settings.json` on boot, instead of staying absent
  (and stuck at their schema default) after a `git pull`. In particular,
  installs created before v2.2.0 now pick up `updateCheck`, so the update
  banner starts working without hand-editing settings. Strictly additive — an
  explicit value you've set is never overwritten.

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

[2.2.8]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.8
[2.2.7]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.7
[2.2.6]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.6
[2.2.5]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.5
[2.2.4]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.4
[2.2.3]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.3
[2.2.2]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.2
[2.2.0]: https://github.com/jneaimi/soulhub/releases/tag/v2.2.0
[2.1.0]: https://github.com/jneaimi/soulhub/releases/tag/v2.1.0
[2.0.0]: https://github.com/jneaimi/soulhub/releases/tag/v2.0.0
