---
name: inline-llm-pass
version: 1.0.0
kind: subprocess
type: component
category: capability
tier: 1
runtime: node
description: Run a single-purpose LLM pass via `claude -p --output-format=json`. Tier-1 capability per ADR-006 D4 — generic prompt-in/text-out wrapper for recipes that need a one-shot model call without the iterative `/goal` loop or an agent definition. The decomposition primitive for any pipeline that splits work into narrow, parallelizable model calls.
when_to_use: A single-pass model call — em-dash strip, polish pass, JSON extraction, decomposition step. Cheaper + faster than `agent-dispatch` because there is no agent loop. Use a narrow `system_prompt` to constrain.
when_not_to_use: Needs multi-tool iteration / convergence (use `agent-dispatch`). Output is deterministic / rule-based (use `shell-exec` running a script — no model cost). Needs operator approval after generation (chain with `approval-gate` or `human-form`).
author: jasem
project: naseej

inputs:
  - name: prompt
    type: string
    required: true
    description: The full prompt sent to the model. Plain text — no system/user role markers. If you need to operate on existing text, pass it via `input_text` and reference it from the prompt body.
  - name: input_text
    type: string
    description: Optional content the prompt should operate on. Appended to the prompt under a `\n\n---\n\n# Input\n\n<text>` block before invocation. Useful for decomposed pipelines that pass the previous step's output forward. Mutually exclusive with `input_text_path`.
  - name: input_text_path
    type: string
    description: Absolute path to a file whose contents become `input_text`. Use this when the upstream step's output exceeds shell-exec's 10 KB inline cap — pair with the upstream's `stdout_to_file` and pass its `outputs.stdout_path` here. Mutually exclusive with `input_text`.
  - name: model
    type: string
    default: claude-sonnet-4-6
    description: Model slug passed verbatim as `--model`. Defaults to Sonnet 4.6 — Opus 4.7 is overkill for single-purpose polish passes, Haiku 4.5 may not survive stop-slop work. Recipe authors override per-step for cost/quality tuning.
  - name: system_prompt
    type: string
    description: Optional system-level framing passed as `--append-system-prompt`. Use for narrow remit ("You are an em-dash stripping editor. Reply with the rewritten text only — no preamble."). Reduces token count vs stuffing the framing into `prompt`.
  - name: budget_seconds
    type: integer
    default: 120
    description: Wall-clock cap before SIGTERM (5s SIGKILL grace). 120s is generous for single-pass work; tune down to 60s for narrow polish passes, up to 300s for long drafts.
  - name: claude_binary
    type: string
    description: Absolute path to the `claude` executable. Tests override to point at a stub script. Production leaves unset — resolves `claude` from PATH.
  - name: cwd
    type: string
    default: /tmp
    description: Working directory for the spawned claude process. Defaults to `/tmp` (a clean dir) on purpose — running from a directory with a CLAUDE.md auto-loads ~10× the per-call token cost. Override only when the call genuinely needs project context (rare for decomposed pipelines).
  - name: max_budget_usd
    type: number
    description: Optional per-call dollar ceiling (passed as `--max-budget-usd`). Bounds runaway risk on long generation. Recommend setting on every call in production recipes — even $0.10 catches infinite-loop bugs that would otherwise burn $5 before the wall-clock budget fires.
  - name: json_schema
    type: object
    description: Optional JSON Schema (passed as `--json-schema`). When set, the model's output MUST conform to the schema or the CLI returns is_error=true. Eliminates an entire class of malformed-output failures for structured generation (findings, tables, metadata). Leave unset for prose generation where structure is loose.
  - name: session_action
    type: string
    enum: [start, continue]
    description: ADR-028 session mode. `start` opens a persistent claude conversation (drops --no-session-persistence, passes --session-id) and returns its `session_id`. `continue` resumes a prior session (--resume) so this turn has the full context of earlier turns — enables cross-step consistency and stop-slop-as-remediation. Omit for the default stateless one-shot call. Session mode is sequential — a session cannot be resumed from parallel steps.
  - name: session_id
    type: string
    description: UUID of the session to use. With `session_action=continue` this is REQUIRED and names the session to resume. With `session_action=start` it is optional — when omitted the component generates a UUID and returns it. Thread it forward via `{{steps.<start-step>.outputs.session_id}}`. Ignored when `session_action` is unset. A session chain MUST share the same `cwd` across steps (claude keys sessions by project dir).

outputs:
  - name: text
    type: string
    description: The model's response text, extracted from the CLI envelope's `result` field. Trimmed of leading/trailing whitespace.
  - name: exit_code
    type: integer
    description: 0 ok / 2 bad input / 124 timeout / 1 CLI error (envelope `is_error=true` or non-zero CLI exit). Mirrors the wrapped CLI's exit so the runner's halt-on-non-zero fires correctly.
  - name: duration_ms
    type: integer
    description: Wall-clock time the subprocess ran for.
  - name: cost_usd
    type: number
    description: Cost from the CLI envelope's `total_cost_usd`. May be 0 for cached or zero-cost branches.
  - name: num_turns
    type: integer
    description: Turn count from the CLI envelope. Always 1 for inline-llm-pass (no /goal loop) — surfaced for symmetry with agent-step metrics.
  - name: model_used
    type: string
    description: Model slug actually used by the CLI (may differ from `model` input if the CLI falls back).
  - name: timed_out
    type: boolean
    description: True when budget_seconds was exceeded and SIGTERM was sent. exit_code is then 124.
  - name: session_id
    type: string
    description: Present only in session mode (`session_action` set). The session UUID — for `start` the opened/generated id, for `continue` the resumed id. Thread to the next step's `session_id` input to chain the conversation.

invocation:
  protocol: stdin-json
  request: '{ prompt, input_text?, input_text_path?, model?, system_prompt?, budget_seconds?, claude_binary?, cwd?, max_budget_usd?, json_schema?, session_action?, session_id? }'
  response: '{ text, exit_code, duration_ms, cost_usd, num_turns, model_used?, timed_out?, session_id? }'
  exit_codes:
    0: model returned a result (success)
    1: CLI returned is_error=true or exited non-zero
    2: bad input (missing prompt, invalid JSON, non-string args)
    124: budget_seconds exceeded and process killed
---

# inline-llm-pass

Tier-1 capability for single-purpose LLM calls from a Naseej recipe.

## When to use

You need a one-shot model call with a narrow remit — draft a section, strip em-dashes, rebalance metronomic rhythm, check consistency. Each step takes input text, returns output text, no iteration.

Specifically: this is the **decomposition primitive** for ADR-022's peer-brief v2 shadow. The hypothesis is that 4 narrow `inline-llm-pass` calls beat one iterative `dispatchAgent(peer-brief-synth, PTY+/goal)` on wall-clock and parity.

## When NOT to use

- **You want orchestrator-v2 features** (model registry routing, branch failover, intent log, presence) — use `agent:` step type with a defined agent in `~/.claude/agents/`.
- **The task is iterative** (the model can't know when to stop without a `/goal` condition) — use `agent:` step type with `mode: production` (claude-pty + /goal).
- **The task wraps a deterministic tool** (`uv run`, `katib build`, `pdftotext`) — use `shell-exec` or a Tier-2 adapter.

Per ADR-006 D5: do not use `inline-llm-pass` to wrap something a typed adapter already covers.

## Example

```yaml
- id: strip-emdashes
  component: inline-llm-pass@1.0.0
  inputs:
    system_prompt: "You are a copy editor. Replace every em-dash in the input with a comma or period — pick whichever fits the sentence. Reply with the rewritten text only. No preamble."
    prompt: "Rewrite this brief with the constraint above."
    input_text: "{{steps.draft.outputs.text}}"
    model: claude-haiku-4-5-20251001
    budget_seconds: 60
```

The runner spawns `claude -p --output-format=json --model claude-haiku-4-5-20251001 --append-system-prompt "..."`, pipes the assembled prompt to stdin, parses the JSON envelope, exposes `outputs.text` for the next step.

## Session mode (ADR-028)

By default each call is a fresh stateless `claude -p`. Set `session_action` to chain calls into ONE conversation so later steps see what earlier steps wrote — fixing cross-step consistency and letting stop-slop run as a remediation *turn* instead of a pass/block gate.

```yaml
# Step 1 — open the session, draft prose. session_id generated + returned.
- id: draft
  component: inline-llm-pass@1.0.0
  inputs:
    session_action: start
    system_prompt: "You are a brief writer. Follow the /stop-slop anti-slop rules."
    prompt: "Draft the prose blocks for today's peer-brief."
    input_text: "{{steps.build-context.outputs.text}}"

# Step 2 — resume; the model still has the draft in context, so the findings
# stay consistent with the prose without re-passing it.
- id: findings
  component: inline-llm-pass@1.0.0
  inputs:
    session_action: continue
    session_id: "{{steps.draft.outputs.session_id}}"
    prompt: "Now write the findings section, consistent with the prose you just drafted."

# Step 3 — stop-slop as REMEDIATION, not a gate.
- id: polish
  component: inline-llm-pass@1.0.0
  inputs:
    session_action: continue
    session_id: "{{steps.draft.outputs.session_id}}"
    prompt: "Review everything you wrote against the anti-slop rubric and rewrite any violations. Output the final assembled brief only."
```

Caveats:
- **Sequential only.** A session is a linear conversation — it cannot be resumed from parallel steps. Adopting session mode trades away parallel execution (ADR-013). Use parallel fresh calls for independent drafts; use a session for consistency-critical chains.
- **Same `cwd` across the chain.** claude keys sessions by project dir; a mismatched `cwd` makes `--resume` miss the session.
- **No cache savings.** Measured: `--resume` re-caches the accumulated prefix (`cache_read=0`), so cost grows per turn. Session mode is a *quality* play (consistency + remediation), not a cost play. See `knowledge/learnings/2026-05-20-claude-p-session-resume`.

## Failure modes

- **Bad input (exit 2)** — `prompt` missing or non-string; `input_text` not a string; invalid JSON; budget_seconds not a positive integer; `session_action` not `start`/`continue`; `session_id` not a valid UUID; `continue` without a `session_id`. Component refuses before spawning.
- **CLI error (exit 1)** — envelope `is_error=true` (model refused, content filter, unknown model slug) or CLI exited non-zero. `outputs.text` carries whatever the CLI emitted; `outputs.exit_code` is 1.
- **Timeout (exit 124)** — `budget_seconds` exceeded; SIGTERM sent, SIGKILL after 5s grace. `outputs.timed_out: true`.
- **Envelope parse failure** — treated as exit 1; raw stdout truncated into `outputs.text` so the recipe author can debug.

## Cost

Per-call cost lands in `outputs.cost_usd`. The audit-trail row (`naseej_runs.steps_json`) carries the per-step cost array.

**Baseline overhead is ~$0.015 per call** (PONG-class reply, Sonnet 4.6) — this is the unavoidable Claude Code core system prompt. The component hardcodes cost-stripping flags to keep it there: `cwd` defaults to `/tmp` (so no CLAUDE.md auto-loads from the calling directory), `--setting-sources ""` (no project/local settings load), `--exclude-dynamic-system-prompt-sections` (per-machine sections moved out, cache reuses better), `--tools ""` (no tool definitions in the system prompt — we never call tools from this component), and `--no-session-persistence` (no session JSON written to disk) **for stateless calls only**. Without these, the same PONG call costs **$0.16** — a 10× regression (measured 2026-05-19, see ADR-022 cost-overhead investigation). In session mode (`session_action` set) `--no-session-persistence` is dropped — the session MUST persist to be resumable — and `--session-id`/`--resume` is added instead.

Set `max_budget_usd` on every production call. The wall-clock `budget_seconds` is a fallback; the dollar cap is the primary guard against runaway generation costs.

Decomposed pipelines stack: 4 × `inline-llm-pass` calls ≈ 4 × token cost of one iterative agent run, minus the `/goal` loop's retry overhead. Net direction depends on whether decomposition or iteration was actually doing the work — that's ADR-022's question.

## Security

`inline-llm-pass` spawns `claude` directly via `child_process.spawn` (no shell). The `prompt` and `input_text` inputs are sent to the model — recipe authors are responsible for not embedding secrets in prompt text. `claude_binary` is an absolute-path override used only in tests; production runs ignore it and resolve `claude` from PATH.
