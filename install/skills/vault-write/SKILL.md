---
name: vault-write
description: "Author a note in the soul vault. The sanctioned AI write path is the `soul` CLI (`soul note create/update`, `soul adr propose/accept/ship/park/reject`) — direct Write/Edit on ~/vault/ is blocked by the vault-write-guard hook (ADR-046). This skill teaches the authoring rules (frontmatter, zones, wikilinks, ADR fields) and the correct `soul` invocations. Trigger on /vault-write, or any AI-authored vault content: ADRs, learnings, patterns, project indexes, research reports, snippets, debugging notes."
---

# Vault Write (/vault-write)

Direct `Write`/`Edit`/`NotebookEdit` on paths under `~/vault/` is blocked at the Claude Code hook layer ([[soul-hub-whatsapp/adr-046-vault-write-chokepoint|ADR-046]]). All AI-authored vault content must flow through the Soul Hub vault API so it picks up governance: required-field validation, zone rules, naming-pattern + template checks, per-agent rate limiting, content dedup, audit log, atomic write + watcher re-index + event-driven git commit.

**The sanctioned client for that API is the `soul` CLI.** This skill exists to teach you the *authoring rules* (frontmatter, filename, wikilinks, zones, ADR fields) and the *correct `soul` invocation* — not to hand you a parallel bash script. The CLI is first-choice per `feedback_soul_cli_first_choice` and `~/dev/soul-hub/CLAUDE.md`; reaching for `curl`/`vault-write.sh` when a `soul` verb fits trips the weekly `soul-cli-uptake-check` falsifier.

---

## Primary path — the `soul` CLI

All `soul` write verbs terminate at the same ADR-046 chokepoint as the raw API, so validation is identical. They add `--dry-run` safety, `--json` composition, lower context tax, and an audit trail. Run `soul note create --help` / `soul adr propose --help` to confirm the shape.

### Create a note

```bash
soul note create \
  --zone "knowledge/learnings" \
  --filename "2026-05-16-my-insight.md" \
  --type "learning" \
  --meta-json '{"created":"2026-05-16","tags":["insight","example"],"source_agent":"claude-opus"}' \
  --content "# My insight

Body in Markdown."
```

- `--type` sets `meta.type`. **`created` and `tags` are also required** (no server defaulting) — pass them in `--meta-json`.
- Body can come from `--content STR`, `--content-file PATH`, or `--content -` (stdin) — prefer the latter two for long/heredoc bodies.
- Use `--dry-run` first when unsure; it prints the exact POST body without writing.
- On success: prints the vault-relative path, exit 0.

### Update a note

```bash
soul note update "knowledge/learnings/2026-05-16-my-insight.md" \
  --meta-json '{"tags":["insight","example","reviewed"]}' \
  --content "# My insight (revised)

Updated body."
```

`--meta-json` **merges** into existing frontmatter (partial update). `--content`/`--content-file` **replaces** the body. Either can be omitted.

### Move / rename / delete

```bash
soul note move   "inbox/2026-05-16-foo.md" "knowledge/learnings" [--rename "2026-05-16-foo.md"]  # link-safe: rewrites inbound wikilinks
soul note rename "knowledge/learnings/2026-05-16-foo.md" "2026-05-16-bar.md"
soul note delete "inbox/2026-05-16-foo.md"   # archives to ~/vault/archive/...; permanent removal still needs rm
```

### ADR lifecycle — use the `soul adr` verbs, not `note create`

ADRs in `projects/<slug>/` have their own lifecycle verbs that handle numbering, routing, and status transitions:

```bash
soul adr propose --project <slug> --slug "adr-NNN-my-decision" --title "ADR-NNN — My Decision" \
  --content-file /tmp/adr-body.md \
  --meta-json '{"work_type":"coding","surface":"soul-hub","owner":"ai","parent_project":"[[soul-hub|soul-hub]]"}'
soul adr accept "projects/<slug>/adr-NNN-my-decision.md"   # resolves assignee via routing matrix when unset
soul adr ship   "projects/<slug>/adr-NNN-my-decision.md"
soul adr park   "projects/<slug>/adr-NNN-my-decision.md" --review-after 2026-07-01
soul adr reject "projects/<slug>/adr-NNN-my-decision.md" --reason "superseded by ADR-XYZ"
```

`soul adr propose` auto-prefixes `adr-NNN-` and slots the next free number. See the ADR-specific frontmatter section below for the fields these verbs rely on.

---

## Authoring rules (read before composing the note)

These rules are **client-agnostic** — they apply whether you use `soul`, the script, or the raw API. The API rejects writes that violate them.

1. **Frontmatter MUST include** `type`, `created` (YYYY-MM-DD), `tags` (array). No defaulting — the write fails without all three.
2. **Filename pattern** — most zones require kebab-case with a `YYYY-MM-DD` prefix for time-stamped notes (`2026-05-16-foo.md`). Check the zone's `CLAUDE.md` for the exact pattern; the API returns the regex if you guess wrong.
3. **Wikilinks**:
   - **NEVER wikilink auto-memory filenames** like `[[feedback_*]]`, `[[project_*]]`, `[[user_*]]`, `[[reference_*]]` — those live in `~/.claude/projects/.../memory/`, not the vault. Use inline backticks: `` `feedback_my_lesson` ``.
   - **Project references use `[[<slug>/index]]`** not bare `[[<slug>]]`. Example: `[[naseej/index]]` not `[[naseej]]`.
   - **Cross-project links use `[[../<other-project>/index]]`** (relative from a project subdir) or `[[projects/<other>/index]]` (absolute from root).
   - **ADR references use the full slug**: `[[adr-046-vault-write-chokepoint]]` not `[[adr-046]]`.
   - **Quote wikilinks in YAML frontmatter**: `relates_to: "[[slug]]"` not `relates_to: [[slug]]` (unquoted parses as a nested list).
4. **Templates** — for `type: decision`, `type: pattern`, `type: debugging`, `type: learning`, etc., respect the template at `~/vault/.vault/templates/<type>.md` — the API refuses if required `##` headings are missing.
5. **Provenance** — set `source_agent: "<your-name>"` so the audit log + rate limit work. Set `source_context: "<short>"` to record why you wrote it.

## Zone reference

| Zone | Type whitelist | Typical filename pattern |
|---|---|---|
| `inbox/` | any | `YYYY-MM-DD-<slug>.md` |
| `projects/<slug>/` | `index`, `decision`, `project`, `research`, `learning`, `report` | mix (`index.md`, `adr-NNN-<slug>.md`, `YYYY-MM-DD-<slug>.md`) — ADRs (`adr-NNN-*.md`) require the extra fields below; `index.md` should carry `repo:` so its ADRs inherit it |
| `knowledge/learnings/` | `learning` | `YYYY-MM-DD-<slug>.md` |
| `knowledge/patterns/` | `pattern` | `YYYY-MM-DD-<slug>.md` |
| `knowledge/debugging/` | `debugging` | `YYYY-MM-DD-<slug>.md` |
| `knowledge/snippets/` | `snippet` | `<slug>.md` |
| `knowledge/research/` | `research` | `YYYY-MM-DD-<slug>.md` |
| `content/` | `draft`, `report` | varies |
| `operations/` | varies | varies |
| `archive/` | any | mirror of original path |

Check the zone's `CLAUDE.md` for the authoritative rules.

## ADR-specific frontmatter fields

ADRs (`projects/<slug>/adr-NNN-*.md`) carry extra fields beyond the global `type`/`created`/`tags`. These were standardized for routing, graph navigation, and falsifier tracking — `soul adr accept` and the workbench rely on them.

- **`work_type:`** — one of `coding | design | research | content | ops | governance`. Drives the dispatch routing matrix in `src/lib/agents/routing/work-types.ts`. Without it, `soul adr accept` falls back to the agent on `assignee:` or to a generic agent. Required for any ADR that will be dispatched.
- **`surface:`** — the system surface the work touches (e.g. `soul-hub`, `soul-hub-whatsapp`, `signal-forge`). Lets cluster-detection group ADRs by surface for cross-project triage.
- **`owner:`** — `ai` or `human`. Decision authority. AI-led ADRs let the implementer agent make scope calls; human-led ADRs reserve that for the operator.
- **`assignee:`** — agent slug (e.g. `soul-hub-implementer`, `developer`, `architect`). Optional; if absent, `soul adr accept` resolves via the routing matrix using `work_type` + project `repo:` binding.
- **`parent_project:`** — wikilink to the parent project (e.g. `'[[soul-hub|soul-hub]]'`). Required per ADR-038 for graph navigation. Must be quoted (YAML wikilink rule).
- **`falsifier_date:`** — `YYYY-MM-DD`. Falsifier validation deadline. Renders in the workbench as a deadline chip.
- **`shipped_phases:`** — array of phase IDs (e.g. `[P1]`). For multi-phase ADRs that ship phase-by-phase; `status:` stays `accepted` until all phases ship. Convention documented in `~/claude-config/rules/vault.md`.
- **`repo:`** (on the project's `index.md`, NOT on ADRs) — absolute path to the project's git repo (e.g. `~/dev/soul-hub`). Inherited by every ADR in the project; lets the routing matrix bind `work_type: coding` ADRs to the right implementer agent.

Example ADR frontmatter using all the new fields:

```yaml
---
type: decision
created: 2026-05-29
tags: [adr, soul-hub, routing]
status: accepted
work_type: coding
surface: soul-hub
owner: ai
assignee: soul-hub-implementer
parent_project: "[[soul-hub|soul-hub]]"
falsifier_date: 2026-06-15
shipped_phases: [P1]
source_agent: claude-opus
---

# ADR-NNN — Title
```

And the matching `repo:` on the project index (one line, inherited downward):

```yaml
---
type: index
created: 2026-04-01
tags: [project, soul-hub]
repo: ~/dev/soul-hub
---

# soul-hub
```

---

## Fallback paths (only when the CLI doesn't fit)

Reach for these **only** when a `soul` verb is missing, broken, or you need control the CLI doesn't expose (e.g. mid-script piping). When you fall back, mention the gap in your response so the missing verb can be scoped — do not silently route around the CLI.

### The `vault-write.sh` wrapper

```bash
# Create
~/.claude/skills/vault-write/scripts/vault-write.sh \
  --zone "knowledge/learnings" --filename "2026-05-16-my-insight.md" \
  --meta-json '{"type":"learning","created":"2026-05-16","tags":["insight"]}' \
  --content "# My insight

Body."

# Update
~/.claude/skills/vault-write/scripts/vault-write.sh \
  --update "knowledge/learnings/2026-05-16-my-insight.md" \
  --meta-json '{"tags":["insight","reviewed"]}' --content "# Revised"
```

Equivalence map (script → preferred `soul` verb):

| `vault-write.sh` | `soul` equivalent |
|---|---|
| `--zone Z --filename F --meta-json … --content …` | `soul note create --zone Z --filename F --type T --meta-json … --content …` |
| `--update PATH --meta-json … --content …` | `soul note update PATH --meta-json … --content …` |

### Direct API call (last resort)

```bash
curl -s -X POST "http://localhost:2400/api/vault/notes" \
  -H 'Content-Type: application/json' \
  -d '{"zone":"<zone>","filename":"<f.md>","meta":{...},"content":"..."}'
# Update: PUT http://localhost:2400/api/vault/notes/<path>
```

Response: `{"success":true,"path":"..."}` or `{"success":false,"error":"...","field":"..."}`.

Common API errors (same across all paths): `Missing required field: <field>` · `Type "<x>" not allowed in zone "<y>"` · `Filename … doesn't match zone naming pattern: <regex>` · `Missing template sections: <list>` · `Rate limit exceeded for agent "<name>"` · `Duplicate content detected. Similar note exists at: <path>` (update that note instead) · `File already exists: <path>` (use update).

---

## When NOT to use this skill

- Reading from the vault → use `soul vault search/get/recent` (or `GET /api/vault/notes?q=...`).
- Editing operator-curated config under `~/vault/.vault/` — the hook exempts this path; use `Edit` directly.
- Editing a zone's `CLAUDE.md` — exempt (operator-curated zone schema); use `Edit` directly.
- Manual operator edits via `vim` — outside Claude Code, the hook doesn't apply.
- Writing files **outside** `~/vault/` — the hook only intercepts vault paths.

## Verifying the write

```bash
soul vault search -q "<unique-keywords>" --limit 3   # or: curl -s ".../api/vault/notes?q=…"
```

The watcher is live — new notes are searchable within seconds.

## Troubleshooting

- **"BLOCKED: Direct Write on vault path"** — you tried `Write`/`Edit` directly. Re-do it via `soul note create/update`.
- **`connection refused` / Soul Hub unreachable** — the API isn't running on `:2400`. `cd ~/dev/soul-hub && ./node_modules/.bin/pm2 status`; `pm2 start ecosystem.config.cjs` if down. All write paths fail closed when it's down.
- **Rate-limit error** — the API limits writes/hour per `source_agent`. Wait or switch the agent name.
- **Dedup match** — a similar note exists; `soul note update <path>` instead of creating.
- **Naming-pattern violation** — check the zone's `CLAUDE.md`; most date-prefixed zones want `YYYY-MM-DD-<kebab>.md`.
