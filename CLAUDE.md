<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **soul-hub** (22258 symbols, 30098 relationships, 272 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/soul-hub/context` | Codebase overview, check index freshness |
| `gitnexus://repo/soul-hub/clusters` | All functional areas |
| `gitnexus://repo/soul-hub/processes` | All execution flows |
| `gitnexus://repo/soul-hub/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

<!-- operator-curated: survives `gitnexus analyze` because it lives outside the marker block above. -->

## Releasing to the public repo (two-repo distribution — ADR-008 / ADR-013)

This repo (`jneaimi/soul-hub`) is **PRIVATE** — the operator's command center. A separate **PUBLIC** repo (`jneaimi/soulhub`) receives only a clean, minimal surface. Editing soul-hub does NOT update the public repo; publishing is an explicit, separate step.

**To publish a change to the public repo:**

```bash
git push origin main        # 1. land it on private main first (pre-push gates run)
npm run release             # 2. assemble public surface + push to soulhub (asks to confirm)
```

`npm run release` → `uv run scripts/release-publish.py`. It runs `release-export.sh` (copies tracked files minus personal content, seeds feature flags off, runs the fail-closed export gate), then pushes the delta to the public repo **history-preserving** (never force-push). It **refuses to push without confirmation** (`--yes` to skip the prompt) because it writes to a public remote. `--dry-run` shows what would ship without pushing; `--gh-release` also cuts a GitHub Release (needed for ADR-010's update-check). It never touches the live `:2400` instance.

⚠️ `release-export.sh` copies tracked files from the **working tree**, so uncommitted edits to tracked files WILL ship — commit first for a reproducible release.

**Versioning (semver — ADR-006).** Plain `npm run release` syncs public main with **no version change** (rolling main — fine for docs/minor syncs). Cut a *versioned* release at milestones:

```bash
npm run release -- --bump minor    # bumps package.json, commits+pushes private, publishes, tags v<new>, creates the GitHub Release
```

`patch` = bug fixes · `minor` = new backward-compatible features · `major` = breaking changes. The update-check banner (ADR-010) compares the installed version to the **latest GitHub Release**, so only `--bump` releases are visible to users — continuous unbumped pushes stay invisible until the next versioned release.

## Reading or writing Soul Hub state? The `soul` CLI is first-choice.

For ANY read or write against `~/vault/**`, `~/.soul-hub/**`, or `http://localhost:2400/api/*`, run `soul --help` BEFORE reaching for `Bash curl`, `Read`, `Write`, or `Edit`. The CLI is a dumb pipe to the same API the raw tools would hit — same ADR-046/047/048 chokepoints, zero per-turn context tax, bash-composable with `--json | jq`. Applies to subagents dispatched from this repo too.

Verbs available (read + write shipped 2026-05-18, ADR-001 + ADR-002 in `[[soul-hub-cli/index]]`):

| Surface | Read | Write |
|---|---|---|
| Vault notes | `soul vault search/get/recent` | `soul note create/update` |
| Projects | `soul project list/get` | `soul project create` |
| ADRs | `soul adr list` | `soul adr propose/accept/ship/park/reject` |
| CRM | `soul crm find/followups` | (none yet — use orchestrator tools) |
| Scheduler | `soul scheduler tasks` | (none yet — edit `~/.soul-hub/settings.json` + `POST /api/settings {}` to reconcile) |
| Intent log | `soul intent metrics` | (read-only) |
| Health | `soul doctor` | — |

Rules:
- `--json` on every read; pipe to `jq`. Don't parse pretty output.
- `--dry-run` on every write verb when uncertain.
- If a verb is missing or broken, fall back AND tell the operator so the gap can be scoped for the next phase. Do NOT silently route around the CLI — the weekly falsifier `soul-cli-uptake-check` (Sun 09:05 Dubai, closes 2026-08-18) is measuring exactly that anti-pattern.
- Operator-facing vault writes still go through the `/vault-write` skill; the CLI is the agent-facing path. Both validate at the same chokepoint.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes the GitNexus index becomes stale. The PostToolUse hook in this project **detects staleness after `git commit` / `git merge` and notifies the agent to run analyze** — the hook does NOT auto-run it (gitnexus 1.6.4+ design: avoids 120s blocks + risk of KuzuDB corruption on timeout). When the hook fires its staleness notice, run:

```bash
npx gitnexus analyze
```

As of gitnexus 1.6.4, `analyze` **preserves existing embeddings by default**. Two flags govern embedding state:

| Flag | Effect |
|------|--------|
| (none) | Preserve existing embeddings; regenerate only the graph |
| `--embeddings` | Regenerate embeddings (use after major structural changes) |
| `--drop-embeddings` | Delete embeddings entirely (use to opt out of semantic search) |

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means none).
