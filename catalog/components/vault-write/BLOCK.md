---
name: vault-write
version: 1.0.0
kind: subprocess
type: component
category: vault
runtime: node
description: Explicit vault note creation. Routes through POST/PUT /api/vault/notes — no direct-fs fallback. Closes the cafe-ops orphan-project hole.
when_to_use: Persist a markdown note to `~/vault/<zone>/...` from a recipe — research output, peer-brief, log entry, ADR draft. Frontmatter is required (zone-aware); body is markdown without the `---` delimiters.
when_not_to_use: You need to write outside the vault (use `shell-exec` with `mkdir/echo` — note the soul-cli-guard). You're inside soul-hub app code (call the engine directly via `vault.createNote`). You need a non-markdown asset under the vault (PDF, image — `katib-build` for PDFs).
author: jasem
project: naseej

inputs:
  - name: path
    type: string
    required: true
    description: Vault-relative path including filename. Must end with .md. Must not contain `..` or start with `/`. The runner is responsible for ensuring this path is under the recipe's declared project zone.
  - name: frontmatter
    type: object
    required: true
    description: Note frontmatter as a JSON object. Required keys per zone — at minimum `type`, `created`, `tags`. `source_agent` recommended for audit log + rate-limit attribution.
  - name: body
    type: string
    required: true
    description: Note body in Markdown. UTF-8. The frontmatter `---` delimiters are added by the API; do NOT include them here.
  - name: mode
    type: string
    enum: [create, append, replace]
    default: create
    description: '`create` POST (refuses overwrite). `replace` PUT (overwrites meta + body). `append` GET-then-PUT (concatenates body to existing).'
  - name: api_base
    type: string
    default: http://localhost:2400
    description: Override the Soul Hub base URL. Set this when running against a non-default port.

outputs:
  - name: vault_path
    type: string
    description: Vault-relative path of the written note (mirrors input `path`).
  - name: note_uri
    type: string
    description: '`vault://<path>` URI for downstream references.'
  - name: bytes_written
    type: integer
    description: Length of the rendered note (frontmatter + body) in bytes.
  - name: action
    type: string
    enum: [created, updated]
    description: Whether the write created a new note or updated an existing one.
  - name: warnings
    type: array
    description: Non-fatal warnings from the API (e.g., unresolved wikilinks per ADR-047).

invocation:
  protocol: stdin-json
  request: '{ path, frontmatter, body, mode?, api_base? }'
  response: '{ vault_path, note_uri, bytes_written, action, warnings }'
  exit_codes:
    0: success
    1: api unreachable (connection refused / network error)
    2: bad input (missing field, invalid JSON, invalid path)
    4: not found (mode=replace|append on missing note, or POST on existing)
    5: api rejected the write (zone violation, naming pattern, dedup, rate limit, link validation)
---

# vault-write

The Naseej replacement for the auto-save side-effect in the legacy pipeline-bridge. Every note a recipe produces flows through the canonical chokepoint (POST/PUT `/api/vault/notes`) which enforces the 10 governance gates from [[../../../../vault/projects/soul-hub-whatsapp/adr-046-vault-write-chokepoint|ADR-046]] plus the link validator from [[../../../../vault/projects/soul-hub-whatsapp/adr-047-wikilink-validation-at-vault-api|ADR-047]] and the stub scaffolder from [[../../../../vault/projects/soul-hub-whatsapp/adr-049-vault-stub-scaffolding|ADR-049]].

## What's intentionally NOT here

- **No direct-fs fallback.** The legacy `pipeline-bridge.ts:38-85` silently wrote to disk when the engine wasn't initialized, bypassing every governance gate. This component refuses to write — exit 1 — when the API is unreachable. Fail-loud, not fail-silent. That's the structural fix.
- **No project-zone enforcement.** That belongs to the runner (it knows the recipe's `project:` field and `run_id`). The component trusts the `path` input. The runner gatekeeps.
- **No retry / backoff.** A failed write is the recipe's problem to handle (or the runner's, on its terms). Quiet retries here would hide systemic problems.

## Invocation

```bash
echo '{
  "path": "projects/naseej/outputs/test-abc/note.md",
  "frontmatter": {
    "type": "output",
    "created": "2026-05-16",
    "tags": ["naseej", "test"],
    "project": "naseej",
    "source_agent": "vault-write-component"
  },
  "body": "# Hello\n\nNote body."
}' | node run.mjs
```

Output:

```json
{
  "vault_path": "projects/naseej/outputs/test-abc/note.md",
  "note_uri": "vault://projects/naseej/outputs/test-abc/note.md",
  "bytes_written": 156,
  "action": "created",
  "warnings": []
}
```

## Modes

- `create` (default) — POST `/api/vault/notes`. Refuses overwrite with exit 5.
- `replace` — PUT `/api/vault/notes/<path>`. Refuses on missing note with exit 4. Replaces frontmatter + body wholesale.
- `append` — GET existing note + PUT with `body` concatenated (separated by `\n\n`). Refuses on missing note with exit 4. Frontmatter is **merged** (new keys win); if you need to overwrite an array field, use `replace`.

## Files

- `BLOCK.md` — this manifest
- `run.mjs` — entry point (Node ESM, no compile step)
- `tests/test_vault_write.mjs` — integration tests against running Soul Hub

## Provenance

The API contract is documented in `src/routes/api/vault/notes/+server.ts` and `src/routes/api/vault/notes/[...path]/+server.ts`. The skill at `~/.claude/skills/vault-write` wraps the same endpoints from the operator side; this component does the same from the recipe side.

## Versioning

- `1.0.0` — initial. create / replace / append.
- Future `1.x` — optional `strict_links: true` passthrough (refuses unresolved wikilinks per ADR-047 strict mode); optional `scaffold_stubs: true` passthrough (auto-creates stub notes for unresolved targets per ADR-049).
- Future `2.x` — breaking I/O changes (none planned).
