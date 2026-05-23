# `install/` — canonical sources for the vault chokepoint

Single source of truth for the five artifacts that make up the ADR-046 +
ADR-047 + ADR-048 + ADR-049 vault-write defense stack. Anything that lands
in `~/.claude/hooks/`, `~/.claude/skills/vault-write/`, or `~/vault/.vault/hooks/`
should originate here.

| File / dir | Deploys to | ADR |
|---|---|---|
| `hooks/vault-write-guard.sh` | `~/.claude/hooks/vault-write-guard.sh` | ADR-046 Pass 1 |
| `hooks/vault-write-guard-bash.sh` | `~/.claude/hooks/vault-write-guard-bash.sh` | ADR-046 Pass 2 |
| `skills/vault-write/` | `~/.claude/skills/vault-write/` | ADR-046 |
| `claude-settings.snippet.json` | merged into `~/.claude/settings.json` | ADR-046 |
| `~/vault/.vault/hooks/pre-commit` (lives in vault, not here) | `~/vault/.git/hooks/pre-commit` (via install.sh) | ADR-048 |

The manual install sequence is documented in `/INSTALL.md` (repo root).
The automated installer is planned for ADR-050 (`scripts/install-chokepoint.sh`).

## Why these files duplicate live config

The hooks + skill ship live at `~/.claude/...` on the operator's machine
today, but `~/.claude/` is per-machine user config — not version-controlled
with soul-hub. Bundling canonical copies here means:

- Fresh-install operators get one repo to clone (no scattered configs).
- Edits to a hook land in version control automatically (no drift between
  what's running and what's documented).
- The automated installer (Phase A / ADR-050) has a single source dir.

Edit hooks here; deploy via copy or symlink (see INSTALL.md). Do NOT edit
`~/.claude/hooks/*` directly going forward.
