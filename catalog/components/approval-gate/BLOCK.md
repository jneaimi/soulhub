---
slug: approval-gate
name: approval-gate
version: 1.0.0
kind: subprocess
type: component
category: capability
tier: 1
runtime: node
shape: gate
entry: run.mjs
description: Pause a recipe run and require the operator to approve or reject before continuing. Uses the stdout-code-2 pause protocol — first invocation emits a pause-request and exits 2; the runner intercepts, registers the pause, awaits the operator's decision, then re-invokes the component with resume_response injected; second invocation exits 0 with decision + optional comment.
when_to_use: A binary continue-or-abort decision before a consequential step (sending a draft, deploying, destructive ops). Operator should be in the loop with no structured data to enter — only the buttons.
when_not_to_use: You need structured or free-form data beyond a yes/no (use `human-form`). The pipeline must run unattended — gate steps block forever without an operator. You only want a quality check, not a human approval (use `stop-slop` or `inline-llm-pass`).
author: jasem
project: naseej
---

# approval-gate

Tier-1 gate component for operator approve/reject decisions mid-recipe.

## When to use

You need a binary decision checkpoint — continue or abort — before a recipe proceeds to a consequential step. Examples: approve a generated draft before it is sent, confirm a destructive operation, gate a deployment step.

## When NOT to use

- You need to collect structured or free-form data beyond a binary decision — use `human-form` instead.
- No operator gate is needed — use `shell-exec` or `inline-llm-pass` for unattended steps.
- You are in a fully automated pipeline that must not block — gate steps are incompatible with headless runs.

## Inputs

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `prompt` | string | yes | — | Shown to the operator with the approve/reject buttons |
| `allow_comment` | boolean | no | `true` | When true, the operator may attach a comment to their decision. When false, comments are stripped from the resume payload. |
| `timeout_sec` | integer | no | 3600 | Seconds before the pause times out. 0 is not valid. |
| `resume_response` | object | no | — | Injected by the runner on the second invocation. Must contain `decision` (`"approved"` or `"rejected"`) and optionally `comment`. |

## Outputs

| Name | Type | Notes |
|---|---|---|
| `decision` | string | `"approved"` or `"rejected"` |
| `comment` | string | Present only when `allow_comment` is true and the operator provided a non-empty comment. |

## Behavior — two-phase pause protocol

**First invocation** (no `resume_response` in stdin):

1. Validates `prompt` (required, non-empty string).
2. Emits a pause-request JSON line to stdout:
   ```json
   {"pause": true, "kind": "gate", "prompt": "...", "allow_comment": true, "timeout_sec": N}
   ```
3. Exits with code **2**.

**Runner intercept** (not in this component — CP4 responsibility):

The runner detects exit code 2 from a component with `manifest.shape === 'gate'`, parses the pause-request JSON from stdout, calls `registerPause()` on the in-process pause-registry, emits the `gate_required` SSE event, and awaits the resolver. When the operator POSTs `POST /api/recipes/runs/<id>/respond`, the runner re-invokes this component with the full original input JSON merged with `{"resume_response": {decision, comment?}}` piped to stdin.

**Second invocation** (`resume_response` present in stdin):

1. Validates `decision` is `"approved"` or `"rejected"`.
2. When `allow_comment` is false, strips the comment from the output even if the runner injected one.
3. Emits `{"decision": "...", "comment": "..."}` (comment omitted when absent or disallowed) to stdout.
4. Exits with code **0**.

Exit code 0 on both `approved` and `rejected` decisions — rejection is a valid decision, not an error. Downstream steps branch via `{{steps.<id>.outputs.decision}}`.

## Invocation

```
protocol: stdin-json
request:  { prompt, allow_comment?, timeout_sec?, resume_response? }
response: { decision, comment? }                                      (on exit 0)
          { pause: true, kind: "gate", prompt, allow_comment, timeout_sec }  (on exit 2)
exit_codes:
  0: second invocation — decision (+ optional comment) in outputs
  1: validation error (missing/empty prompt, invalid decision, etc.)
  2: first invocation — pause-request emitted; runner must intercept
```

## Example

```yaml
- id: gate-send
  component: approval-gate@1.0.0
  inputs:
    prompt: "The newsletter draft is ready. Approve to send to 847 subscribers."
    allow_comment: true
    timeout_sec: 86400

- id: send-newsletter
  component: channel-send-text@1.0.0
  depends_on: [gate-send]
  condition: "{{steps.gate-send.outputs.decision == 'approved'}}"
  inputs:
    channel: email
    body: "{{steps.draft.outputs.text}}"
```

The recipe pauses at `gate-send`, surfaces the `gate_required` SSE event, and waits up to 24 hours. If the operator approves, the `send-newsletter` step runs. If rejected, `condition` is false and the step is skipped.
