---
name: vault-write
description: "Create or update a note in the Second Brain vault via the Soul Hub createNote API (ADR-046 chokepoint). Use this skill — not Write/Edit — whenever you need to author a note under ~/vault/. Direct Write/Edit on vault paths is blocked by the vault-write-guard hook. Trigger on /vault-write, or any AI-authored vault content: ADRs, learnings, patterns, project indexes, research reports, snippets, debugging notes."
---

# Vault Write (/vault-write)

This skill is the **only sanctioned way for AI to author vault content** under `~/vault/`. Per [[soul-hub-whatsapp/adr-046-vault-write-chokepoint|ADR-046]], direct `Write`/`Edit`/`NotebookEdit` on vault paths is blocked at the Claude Code hook layer; this skill routes writes through `POST /api/vault/notes` so they pick up:

- Required-field validation (`type`, `created`, `tags` globally; per-zone extras)
- Zone-allowed-types check + naming-pattern check
- Template structure validation (when zone requires it)
- Per-agent rate limiting (writes/hour)
- Content dedup check (refuses near-duplicates of existing notes)
- Auto-tagging with `auto-generated` when `source_agent` is set
- Audit log entry
- Atomic tmp+rename write + watcher re-index + event-driven commit

If Soul Hub isn't running on `:2400`, this skill fails closed. Start Soul Hub first.

## Precedence — try the `soul` CLI first

Before invoking this skill, check whether a `soul` verb covers the case. All three paths terminate at the same `POST /api/vault/notes` chokepoint (ADR-046), so validation is identical — the CLI just doesn't burn a skill-invocation budget for what is a thin HTTP wrapper.

1. **`soul adr {propose,accept,ship,park,reject}`** — first choice for ADR lifecycle ops in `projects/<slug>/`
2. **`soul note {create,update}`** — first choice for general vault notes (any zone, full frontmatter control via `--meta-json`)
3. **This skill (`/vault-write`)** — fallback when a `soul` verb doesn't fit (e.g., update mid-script, complex piping)
4. **Direct `curl POST /api/vault/notes`** — last resort if both above are broken

Run `soul --help` and `soul note create --help` to confirm the CLI shape before falling back. See `feedback_soul_cli_first_choice` auto-memory and `~/dev/soul-hub/CLAUDE.md` (the "soul CLI is first-choice" section) for the governing rule.

## Quickstart

### Create a new note

```bash
~/.claude/skills/vault-write/scripts/vault-write.sh \
  --zone "knowledge/learnings" \
  --filename "2026-05-16-my-insight.md" \
  --meta-json '{"type":"learning","created":"2026-05-16","tags":["insight","example"],"source_agent":"claude-opus"}' \
  --content "# My insight

Body in Markdown."
```

On success: prints the vault-relative path to stdout, exit 0.

On failure: prints the structured API error to stderr, exit non-zero. Common errors include:

- `Missing required field: <field>` — frontmatter missing
- `Type "<x>" not allowed in zone "<y>"` — zone governance violation
- `Filename "<f>" doesn't match zone naming pattern: <regex>` — fix the filename
- `Missing template sections: <list>` — body doesn't include the zone's required `##` headings
- `Rate limit exceeded for agent "<name>"` — wait or change `source_agent`
- `Duplicate content detected. Similar note exists at: <path>` — update that note instead of creating
- `File already exists: <path>` — use `--update` to modify

### Update an existing note

```bash
~/.claude/skills/vault-write/scripts/vault-write.sh \
  --update "knowledge/learnings/2026-05-16-my-insight.md" \
  --meta-json '{"tags":["insight","example","reviewed"]}' \
  --content "# My insight (revised)

Updated body."
```

`--meta-json` is merged with existing frontmatter (partial update). `--content` replaces the entire body. Either can be omitted.

### Direct API call (when you need control the wrapper doesn't expose)

```bash
curl -s -X POST "http://localhost:2400/api/vault/notes" \
  -H 'Content-Type: application/json' \
  -d '{"zone":"<zone>","filename":"<f.md>","meta":{...},"content":"..."}'
```

Response: `{"success":true,"path":"..."}` or `{"success":false,"error":"...","field":"..."}`.

## Authoring rules (read before composing the note)

1. **Frontmatter MUST include** `type`, `created` (YYYY-MM-DD), `tags` (array). The skill rejects writes without these.
2. **Filename pattern** — most zones require kebab-case with a YYYY-MM-DD prefix for time-stamped notes (`2026-05-16-foo.md`). Check the zone's `CLAUDE.md` for the exact pattern; the API will tell you the regex if you guess wrong.
3. **Wikilinks**:
   - **NEVER wikilink auto-memory filenames** like `[[feedback_*]]`, `[[project_*]]`, `[[user_*]]`, `[[reference_*]]` — those live in `~/.claude/projects/.../memory/`, not the vault. Use inline backticks for those: `` `feedback_my_lesson` ``.
   - **Project references use `[[<slug>/index]]`** not bare `[[<slug>]]`. Example: `[[naseej/index]]` not `[[naseej]]`.
   - **Cross-project links use `[[../<other-project>/index]]`** (relative from a project subdir) or `[[projects/<other>/index]]` (absolute from root).
   - **ADR references use the full slug**: `[[adr-046-vault-write-chokepoint]]` not `[[adr-046]]`.
   - **Quote wikilinks in YAML frontmatter**: `relates_to: "[[slug]]"` not `relates_to: [[slug]]`.
4. **Templates** — for `type: decision`, `type: pattern`, `type: debugging`, `type: learning`, etc., respect the template at `~/vault/.vault/templates/<type>.md` — the API will refuse if required `##` headings are missing.
5. **Provenance** — set `source_agent: "<your-name>"` so the audit log + rate limit work. Set `source_context: "<short>"` to record why you wrote it.

## Zone reference

| Zone | Type whitelist | Typical filename pattern |
|---|---|---|
| `inbox/` | any | `YYYY-MM-DD-<slug>.md` |
| `projects/<slug>/` | `index`, `decision`, `project`, `research`, `learning`, `report` | mix (index.md, adr-NNN-*.md, YYYY-MM-DD-*.md) |
| `knowledge/learnings/` | `learning` | `YYYY-MM-DD-<slug>.md` |
| `knowledge/patterns/` | `pattern` | `YYYY-MM-DD-<slug>.md` |
| `knowledge/debugging/` | `debugging` | `YYYY-MM-DD-<slug>.md` |
| `knowledge/snippets/` | `snippet` | `<slug>.md` |
| `knowledge/research/` | `research` | `YYYY-MM-DD-<slug>.md` |
| `content/` | `draft`, `report` | varies |
| `operations/` | varies | varies |
| `archive/` | any | mirror of original path |

Check the zone's `CLAUDE.md` for the authoritative rules.

## When NOT to use this skill

- Reading from the vault → use the search API (`GET /api/vault/notes?q=...`) or the `/brain` skill.
- Editing operator-curated config under `~/vault/.vault/` — the hook exempts this path; use Edit directly.
- Manual operator edits via `vim` — outside Claude Code, the hook doesn't apply.
- Writing files **outside** `~/vault/` — the hook only intercepts vault paths.

## Verifying the write

After a successful create, confirm the watcher indexed:

```bash
curl -s "http://localhost:2400/api/vault/notes?q=<unique-keywords>&limit=3" | jq -r '.results[].path'
```

The watcher is live — new notes are searchable within seconds.

## Troubleshooting

- **"BLOCKED: Direct Write on vault path"** — you tried `Write`/`Edit` directly. Re-invoke through this skill.
- **`connection refused`** — Soul Hub isn't running on `:2400`. `cd ~/dev/soul-hub && ./node_modules/.bin/pm2 status` to check; `pm2 start ecosystem.config.cjs` if down.
- **Rate-limit error** — the API limits writes/hour per `source_agent`. Wait or switch the agent name.
- **Dedup match** — a similar note exists; consider updating it (`--update <path>`) rather than creating.
- **Naming-pattern violation** — check the zone's `CLAUDE.md`; most date-prefixed zones want `YYYY-MM-DD-<kebab>.md`.
