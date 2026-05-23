---
slug: human-form
name: human-form
version: 1.0.0
kind: subprocess
type: component
category: capability
tier: 1
runtime: node
shape: gate
entry: run.mjs
description: Pause a recipe run and collect structured operator input via a prompt + optional field schema. Uses the stdout-code-2 pause protocol — first invocation emits a pause-request and exits 2; the runner intercepts, registers the pause, awaits the operator's response, then re-invokes the component with resume_response injected; second invocation exits 0 with the operator's payload.
when_to_use: Collect free-form or structured data from the operator mid-recipe — confirmation with comment, manual data entry for a downstream step, schema-driven form responses. Use the `fields[]` input for typed fields.
when_not_to_use: A binary approved/rejected decision is enough (use `approval-gate` — simpler UI). The pipeline must run unattended (gates block forever without an operator). You can derive the value without human input (compute it with `inline-llm-pass` or `shell-exec`).
author: jasem
project: naseej
---

# human-form

Tier-1 gate component for collecting operator input mid-recipe.

## When to use

You need to pause a recipe at a specific step and collect free-form or structured input from the operator before continuing. Examples: confirmation of a generated artefact, manual data entry for a downstream step, approval with an attached comment form.

## When NOT to use

- You only need a binary approved/rejected decision — use `approval-gate` instead.
- No operator interaction is needed — use `shell-exec` or `inline-llm-pass` for unattended steps.
- You are in a fully automated pipeline that must not block — gate steps are incompatible with headless runs.

## Inputs

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `prompt` | string | yes | — | Shown to the operator above the form |
| `fields` | array | no | `[]` | Schema for named fields: `[{name, type, label?, required?, options?}]`. Empty array = free-form response. |
| `timeout_sec` | integer | no | 3600 | Seconds before the pause times out. 0 is not valid. |
| `resume_response` | object | no | — | Injected by the runner on the second invocation. When present, the component exits 0 and echoes `{response: resume_response}`. |

## Outputs

| Name | Type | Notes |
|---|---|---|
| `response` | object | The operator's payload. Shape matches the `fields` schema (or a free-form object if `fields` was empty). |

## Behavior — two-phase pause protocol

**First invocation** (no `resume_response` in stdin):

1. Validates `prompt` (required, non-empty string).
2. Emits a pause-request JSON line to stdout:
   ```json
   {"pause": true, "kind": "human", "prompt": "...", "fields": [...], "timeout_sec": N}
   ```
3. Exits with code **2**.

**Runner intercept** (not in this component — CP4 responsibility):

The runner detects exit code 2 from a component with `manifest.shape === 'gate'`, parses the pause-request JSON from stdout, calls `registerPause()` on the in-process pause-registry, emits the `human_required` SSE event, and awaits the resolver. When the operator POSTs `POST /api/recipes/runs/<id>/respond`, the runner re-invokes this component with the full original input JSON merged with `{"resume_response": <operator payload>}` piped to stdin.

**Second invocation** (`resume_response` present in stdin):

1. Emits `{"response": <resume_response>}` to stdout.
2. Exits with code **0**.

## Invocation

```
protocol: stdin-json
request:  { prompt, fields?, timeout_sec?, resume_response? }
response: { response }   (on exit 0)
          { pause: true, kind: "human", prompt, fields, timeout_sec }  (on exit 2)
exit_codes:
  0: second invocation — resume_response echoed as outputs.response
  1: validation error (missing prompt, etc.)
  2: first invocation — pause-request emitted; runner must intercept
```

## Example

```yaml
- id: collect-feedback
  component: human-form@1.0.0
  inputs:
    prompt: "Review the draft below and fill in the fields."
    fields:
      - name: verdict
        type: select
        label: "Overall verdict"
        required: true
        options: ["approve", "revise", "reject"]
      - name: notes
        type: text
        label: "Notes for the author"
    timeout_sec: 7200
```

The runner pauses the recipe, surfaces the `human_required` SSE event to the UI, and waits up to 2 hours for the operator to POST a response. Once received, `steps.collect-feedback.outputs.response.verdict` is available for downstream interpolation.
