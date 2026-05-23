---
name: text-correct
version: 1.0.0
kind: subprocess
type: component
category: capability
tier: 1
runtime: python
description: Prescription-pattern AI corrector. A model reads prose against a ruleset and emits a minimal substitution map ([{find, replace, why}]); the component applies it deterministically + a regex backstop. Fact-preserving (only proposed substrings change) and truncation-proof (the model emits a diff, never the full content). Tier-1 per ADR-035 — the ruleset is a parameter, so it corrects against any style guide, not just stop-slop.
when_to_use: A second-pass cleanup that FIXES prose instead of only detecting slop. Pair after a draft step and before a verify gate (the 3-beat draft -> text-correct -> stop-slop sequence). Use when re-emitting the full content would risk truncation or fact corruption (large compositions, recipes).
when_not_to_use: Need only a pass/fail score with no edits (use `stop-slop`). Need a full creative rewrite rather than surgical fixes (use `inline-llm-pass` with a rewrite prompt). Need human sign-off on the edits (chain with `approval-gate`). The content is deterministic / rule-based with no judgment (use `shell-exec`).
author: jasem
project: naseej

inputs:
  - name: input_text
    type: string
    description: The prose to correct, inline. Mutually exclusive with `input_text_path`. The component writes it to a temp file so the model reads it the same way it reads a path input.
  - name: input_text_path
    type: string
    description: Absolute path to a file whose contents are corrected in place of `input_text`. Use for large upstream artefacts (a composition / recipe) — pair with the upstream step's `stdout_to_file` + its `outputs.stdout_path`. Mutually exclusive with `input_text`.
  - name: ruleset
    type: string
    default: ~/.claude/skills/stop-slop/SKILL.md
    description: Path to a markdown ruleset appended to the model as `--append-system-prompt`. Defaults to the stop-slop skill. Swap it for an arabic-voice, brand-voice, or legal-tone ruleset — the corrector itself is style-agnostic. `~` is expanded.
  - name: model
    type: string
    default: claude-sonnet-4-6
    description: Model slug passed verbatim as `--model`. Sonnet is sufficient for a substitution-map pass; Haiku may miss subtle slop.
  - name: max_budget_usd
    type: number
    default: 0.40
    description: Per-call dollar ceiling (`--max-budget-usd`). The map is small, so this is generous headroom, not a target.
  - name: emdash_backstop
    type: boolean
    default: true
    description: When true, a deterministic regex pass converts every em-dash (`—` or ` -- `) to a comma AFTER the model map is applied. Guarantees the hard em-dash ban regardless of what the model missed.
  - name: output_path
    type: string
    description: Absolute path to write the corrected content to. When set, the corrected file is written and `corrected_path` is returned (the full text is NOT echoed to stdout, to bound output size). When omitted, the corrected content is returned inline as `corrected_text`.
  - name: claude_binary
    type: string
    description: Absolute path to the `claude` executable. Tests override to a stub. Production leaves unset — resolves `claude` from PATH.

outputs:
  - name: corrected_path
    type: string
    description: Path the corrected content was written to. Present only when `output_path` was supplied.
  - name: corrected_text
    type: string
    description: The corrected content inline. Present only when `output_path` was NOT supplied.
  - name: substitutions_applied
    type: integer
    description: Count of model-proposed substitutions whose `find` matched and was replaced.
  - name: substitutions_missed
    type: integer
    description: Count of proposed substitutions whose `find` did not match the content verbatim (skipped, not guessed).
  - name: emdash_fixed
    type: boolean
    description: True if the deterministic em-dash backstop changed the content.
  - name: cost_usd
    type: number
    description: Cost of the prescription model call from the CLI envelope. 0 when the call was skipped or stubbed.
  - name: exit_code
    type: integer
    description: 0 ok / 2 bad input. The corrector is best-effort — a failed or empty model map does not fail the step; the backstop still runs and the (possibly unchanged) content is written.

invocation:
  protocol: stdin-json
  request: '{ input_text? | input_text_path?, ruleset?, model?, max_budget_usd?, emdash_backstop?, output_path?, claude_binary? }'
  response: '{ corrected_path? | corrected_text?, substitutions_applied, substitutions_missed, emdash_fixed, cost_usd, exit_code }'
  exit_codes:
    0: ok (corrections applied, or best-effort fallthrough)
    2: bad input (no content, both inputs set, missing JSON, etc.)
---

# text-correct

Prescription-pattern AI corrector. Where `stop-slop` *detects* slop and scores it, `text-correct` *fixes* it — and does so without the failure mode that bites full-rewrite passes.

## Why the prescription pattern

Asking a model to re-emit a corrected copy of a large document is unreliable: it truncates, and it silently rewrites facts (numbers, names, quotes). Instead, the model emits only a **minimal substitution map**:

```json
[{"find": "<exact verbatim substring>", "replace": "<slop-free rewrite>", "why": "em-dash"}]
```

Python applies that map deterministically with `str.replace(find, replace, 1)`. Only the proposed substrings change; every other byte — including every fact — is preserved verbatim. This is the validated approach from `feedback_llm_step_full_output_variance`.

## How it works

1. Resolve the content (from `input_text_path`, or `input_text` written to a temp file).
2. Spawn `claude -p` with the ruleset as `--append-system-prompt`, the cost-stripping flags (`--setting-sources ""`, `--exclude-dynamic-system-prompt-sections`, clean cwd) and `--dangerously-skip-permissions` so the read-only pass never prompts headless. The prompt asks for a `{"substitutions": [...]}` object; the map is parsed from the envelope `result`. (We do NOT use `--json-schema` — in the installed CLI it routes structured output away from `result`, leaving it empty.)
3. Apply each `{find, replace}` where `find` matches verbatim. Misses are counted, never guessed.
4. If `emdash_backstop` is on, convert remaining em-dashes to commas deterministically.
5. Write `output_path` (returning `corrected_path`) or return `corrected_text`.

## Best-effort contract

The corrector never fails the pipeline on a model hiccup. If the prescription call errors or returns an empty/invalid map, `substitutions_applied` is 0, the em-dash backstop still runs, and the content is written through. The downstream `stop-slop` gate is the real safety net.

## Files

- `BLOCK.md` — this manifest
- `run.py` — entry point; reads stdin JSON, writes stdout JSON
- `tests/` — substitution apply, fact preservation, backstop, bad input

## Provenance

Ported from the legacy `scripts/peer-brief-render.py` `step_correct`. ADR-035 P4 migrates that legacy pass to call this component so one corrector definition exists system-wide.
