# Vault-first long-term memory

Claude Code's auto-memory (`~/.claude/projects/.../memory/`) is per-machine, project-scoped, and invisible to `/brain`, the vault watcher, and other machines. For anything worth keeping beyond the current conversation, **also write a vault note** at `~/vault/`.

## Triage — what goes where

| Category | Memory | Vault |
|---|---|---|
| User preferences ("prefers terse replies", "Arabic content via /arabic") | ✓ | — |
| Project state (current sprint, who's blocking what, today's branch) | ✓ | — |
| External references (URLs, IDs, paths to other repos) | ✓ | — |
| **Validated patterns** — technique that worked, lesson with general applicability | pointer | `~/vault/knowledge/patterns/YYYY-MM-DD-<slug>.md` |
| **Debugging post-mortems** — non-trivial bug after real investigation | pointer | `~/vault/knowledge/debugging/YYYY-MM-DD-<slug>.md` |
| **Architecture decisions** — tradeoff made with stakes | pointer | `~/vault/projects/<project>/decisions/YYYY-MM-DD-<slug>.md` |
| **General learnings** — research, insight, "this is how X works" | pointer | `~/vault/knowledge/learnings/YYYY-MM-DD-<slug>.md` |
| **Code snippets** — reusable utility with non-obvious usage | pointer | `~/vault/knowledge/snippets/YYYY-MM-DD-<slug>.md` |

## The pointer pattern

Memory entry stays tight (2-3 lines + a `[[wikilink]]`). Vault holds the depth.

```markdown
# memory file: feedback_tool_routing.md
When the orchestrator picks the wrong tool, fix descriptions on BOTH sides —
STRICT ROUTING preamble + competitor "Do NOT use" clause. Full pattern:
[[knowledge/patterns/2026-05-12-orchestrator-tool-routing-description-tuning]]
```

This way future-Claude sees the terse rule from memory AND can jump to the full pattern when the situation calls for it.

## Templates

The vault ships templates at `~/vault/.vault/templates/`:
- `pattern.md` — when/pattern/why structure
- `debugging.md` — symptom/diagnosis/fix structure
- `adr.md` — context/decision/consequences structure
- `learning.md` — insight/evidence/applies-to structure
- `snippet.md` — code with usage notes

**Use them.** They keep notes scannable + linkable + filterable by frontmatter.

## Verification

After writing a vault note, confirm the watcher indexed it:

```bash
curl -s "http://localhost:2400/api/vault/notes?q=<keywords>&limit=3" | jq -r '.results[].path'
```

The watcher is live — new notes are searchable within seconds. If Soul Hub isn't running on `:2400`, the file still lives on disk and will be picked up on next boot.

## When NOT to write to vault

- The insight is one-conversation deep (no general lesson). Memory only.
- It's already covered by an existing vault note. Update the existing one — don't fragment.
- It's user-specific or ephemeral (today's standup, this sprint's blockers).
- The user explicitly says "don't save this".

## Linkage discipline

When writing a vault note that builds on or contradicts another, **link it via wikilink** in the body. The vault graph (`/api/vault/graph`) becomes useful only when notes connect; orphan notes are nearly invisible.

When updating memory to point at a new vault note, include the wikilink in the memory body so future-Claude can navigate up. This is the bidirectional pointer pattern that keeps memory tight + vault discoverable.
