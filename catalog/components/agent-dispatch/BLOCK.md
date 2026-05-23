---
name: agent-dispatch
version: 1.0.0
kind: subprocess
type: component
category: capability
tier: 1
shape: agentic
runtime: node
description: Dispatch a soul-hub agent by slug. Tier-1 capability per ADR-023 — the agentic primitive that collapses the legacy `agent:` step type into the component catalog. Runs the full dispatchAgent() loop including PTY+/goal convergence, artifact marker extraction, and per-step budget overrides.
when_to_use: A step needs a soul-hub agent's skills, persona, or tools — anything that requires the iterative `/goal` convergence loop, multi-tool workflow, or a per-agent system prompt. The PTY backend is itself an interactive claude session (stateful across its own /goal turns); cross-dispatch resume is the ADR-028 Phase 2 spike. Pick this when you'd otherwise have invoked `claude` with a custom agent definition.
when_not_to_use: A single-purpose LLM pass (use `inline-llm-pass` — cheaper, no agent setup; it now supports session/resume for sequential chains per ADR-028). A shell command (use `shell-exec`). A typed external system has a Tier-2 adapter already (prefer the adapter — e.g. `katib-build`, `vault-write`).
author: jasem
project: naseej

inputs:
  - name: agent
    type: string
    required: true
    description: Slug of the agent to run. Must match a file at `~/.claude/agents/<slug>.md` or `~/.soul-hub/data/agents/<slug>.yaml`.
  - name: task
    type: string
    required: true
    description: Prompt passed to the agent. Interpolation of `{{steps.X.outputs.Y}}` template variables must be resolved by the runner before passing here.
  - name: context
    type: string
    description: Extra context injected into the dispatch options. Capped at 4000 chars internally (ADR-005 D6 PTY paste-stall guard). Longer strings are silently truncated.
  - name: goal_condition
    type: string
    description: Natural-language convergence condition forwarded to the PTY dispatcher as `/goal <condition>`. When present, the agent self-iterates until the condition is met or the budget fires. Only the `claude-pty` backend acts on this; `claude-cli-flag` and `ai-sdk` ignore it.
  - name: mode
    type: string
    default: production
    enum: [production, test, oneshot]
    description: Dispatch backend selection. `production` routes through claude-pty with `/goal` loop. `test` uses claude-cli-flag with hard caps ($0.10 / 5 turns / 60s) — for CI smokes. `oneshot` uses claude-cli-flag with no caps, for structurally single-pass agents that need production budgets.
  - name: timeout_sec
    type: integer
    default: 600
    description: Wall-clock budget in seconds. Absent = agent's stored budget, which falls through to PRODUCTION_DEFAULTS (600s) if unset.
  - name: max_turns
    type: integer
    description: Turn budget. Absent = agent's stored budget (default 25).
  - name: max_usd
    type: number
    description: Dollar ceiling. Absent = agent's stored budget (default $0.50).

outputs:
  - name: output_excerpt
    type: string
    description: Last 2000 characters of the agent's final output.
  - name: artifact_path
    type: string
    description: Present when the agent emits the `===ARTIFACT===\n<path>\n===END===` marker in its output. Vault-relative path to the produced artefact.
  - name: agent_status
    type: string
    description: Terminal status from DispatchResult — one of `success`, `goal_achieved`, `failed`, `cancelled`, `timeout`, `error`, `budget-exceeded`.
  - name: num_turns
    type: integer
    description: Number of turns the agent took.
  - name: cost_usd
    type: number
    description: Actual dollar cost of the dispatch run.
  - name: exit_code
    type: integer
    description: 0 on success or goal_achieved. 1 on failed, timeout, cancelled, or error.

invocation:
  protocol: stdin-json
  request: '{ agent, task, context?, goal_condition?, mode?, timeout_sec?, max_turns?, max_usd? }'
  response: '{ output_excerpt, artifact_path?, agent_status, num_turns, cost_usd, exit_code }'
  exit_codes:
    0: agent finished with status success or goal_achieved
    1: agent finished with status failed, timeout, cancelled, error, or budget-exceeded
    2: bad input (missing required fields, invalid JSON)
---

# agent-dispatch

Tier-1 agentic primitive. Wraps the soul-hub `dispatchAgent()` loop in the Naseej stdin-json protocol so any recipe step can run a registered agent.

## Inputs

| Input | Type | Required | Default | Notes |
|---|---|---|---|---|
| `agent` | string | yes | | Slug matching `~/.claude/agents/<slug>.md` |
| `task` | string | yes | | Prompt passed to the agent |
| `context` | string | no | | Extra context. Capped at 4000 chars (ADR-005 D6 PTY paste-stall guard) |
| `goal_condition` | string | no | | Natural-language goal for the `/goal` convergence loop |
| `mode` | string | no | `production` | `production` (claude-pty+/goal), `test` (cheap CI), `oneshot` (single-pass cli-flag) |
| `timeout_sec` | integer | no | 600 | Wall-clock cap |
| `max_turns` | integer | no | agent default | Turn budget |
| `max_usd` | number | no | agent default | Dollar ceiling |

## Outputs

| Output | Type | Notes |
|---|---|---|
| `output_excerpt` | string | Last 2000 chars of final agent output |
| `artifact_path` | string | Set when agent emits the `===ARTIFACT===` marker |
| `agent_status` | string | DispatchResult.status |
| `num_turns` | integer | |
| `cost_usd` | number | |
| `exit_code` | integer | 0 on success/goal_achieved, 1 on failure/timeout/cancelled |

## Behavior

On invocation the component:

1. Reads stdin as JSON. Exits code 2 immediately if `agent` or `task` are missing or if the JSON is malformed.
2. Calls `getAgent(agent)` to verify the slug exists in the registry. Exits code 1 with a structured error if not found.
3. Caps `context` at 4000 chars. Truncates silently — no error.
4. Calls `dispatchAgent(agent, task, { mode, signal, context, goal_condition, budget_override })` and drains the async generator using the iterator protocol (not `for await...of` — the `TReturn` value carries the `DispatchResult`).
5. Buffers up to 50 `DispatchEvent` entries in a ring buffer (ADR-005 D5). Older events shift off when the buffer is full.
6. Scans the final `DispatchResult.output` for the artifact marker (`/===ARTIFACT===\s*\n([^\n]+)\s*\n===END===/`). Extracts the path if found.
7. Maps terminal status to exit code: `success` or `goal_achieved` → 0; everything else → 1.
8. Writes a single JSON object to stdout with the output fields listed above. Exits with the mapped code.

If the `dispatchAgent` generator throws, the component catches the error and exits code 1 with `{ error: "dispatcher threw: <message>", agent_status: "error", exit_code: 1 }`.

## When NOT to use

This component is **tight-coupled to soul-hub's internal `$lib/agents` module**. It imports `dispatchAgent`, `getAgent`, and related types directly from the soul-hub source tree. This is intentional per ADR-023's "Naseej plugs INTO orchestrator-v2" boundary.

Do not use `agent-dispatch` from:
- A recipe running inside a different project that doesn't share the soul-hub source tree
- A component that needs to call agents on a different Soul Hub instance
- A context where you want the orchestrator-v2 model-routing, intent-log, or branch-failover features — those only activate when the orchestrator dispatches directly, not when Naseej drives the call

For iterative work where the model can converge without a named agent, use `inline-llm-pass` with a goal-shaped `system_prompt` instead.

## Example

```yaml
- id: research
  component: agent-dispatch@1.0.0
  inputs:
    agent: researcher
    task: "Research GCC hydroponics market. Output a 500-word brief."
    goal_condition: "A markdown brief of at least 400 words is present in the output"
    mode: production
    timeout_sec: 300
    max_usd: 0.50
```

## Failure modes

- **Bad input (exit 2)** — `agent` or `task` missing from stdin JSON; invalid JSON.
- **Agent not found (exit 1)** — slug has no matching file in either registry lane.
- **Dispatcher threw (exit 1)** — unexpected exception inside `dispatchAgent()`; the error message is captured.
- **Status failed/timeout/cancelled (exit 1)** — the agent ran but did not succeed. `outputs.agent_status` carries the exact status for branching.

## Cost

`outputs.cost_usd` is the per-dispatch dollar cost from `DispatchResult.cost_usd`. The audit-trail row in `agent_runs` records the same value independently. The step's cost also propagates into the Naseej run summary via `StepResult.cost_usd`.
