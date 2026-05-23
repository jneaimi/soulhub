---
name: shell-exec
version: 1.0.0
kind: subprocess
type: component
category: capability
tier: 1
runtime: node
description: Run an arbitrary subprocess with stdin/stdout/stderr capture, optional file redirection, and a wall-clock timeout. Tier-1 capability per ADR-006 D4 — the generic escape hatch for invoking external commands from a recipe before the catalog accretes a typed Tier-2 adapter.
when_to_use: Invoke an external command from a recipe — script, CLI tool, binary. No Tier-2 adapter exists yet for that system. Pair with `stdout_to_file` when the upstream output exceeds 10 KB inline.
when_not_to_use: "A Tier-2 adapter exists for the system (prefer it — typed inputs, error parsing): `katib-build`, `vault-write`, `channel-send-text`. You need shell features like `&&`, `|`, globs — pass a script path instead of a chained command, or invoke `bash -c` deliberately. The command is a one-shot LLM call (use `inline-llm-pass`)."
author: jasem
project: naseej

inputs:
  - name: cmd
    type: string
    required: true
    description: Executable name or absolute path. Resolved via PATH (no shell, so no `&&`, `|`, or globs — pass args separately).
  - name: args
    type: array
    default: []
    description: Argument vector passed verbatim to the executable. Each element is a single argv slot — no shell-word splitting.
  - name: cwd
    type: string
    description: Working directory for the subprocess. Defaults to soul-hub repo root (the runner's process.cwd).
  - name: stdin
    type: string
    default: ""
    description: Text piped to the subprocess's stdin (closed immediately after). Empty by default.
  - name: env
    type: object
    description: Environment variables merged onto process.env. Use sparingly — secrets should come from the operator shell, not from recipes.
  - name: timeout_sec
    type: integer
    default: 60
    description: Wall-clock cap before the runner sends SIGTERM (then SIGKILL after a 5s grace). Tune up for long renders (katib build, signal-trend extract); tune down for cheap checks.
  - name: stdout_to_file
    type: string
    description: Absolute path. When set, the subprocess's stdout is captured to this file in addition to being truncated inline in `outputs.stdout`. Pair with `{{work_dir}}/<name>` for run-scoped artefacts.
  - name: stderr_to_file
    type: string
    description: Same as stdout_to_file but for stderr.

outputs:
  - name: exit_code
    type: integer
    description: Subprocess exit code (or -1 if spawn failed, 124 on timeout per GNU convention).
  - name: stdout
    type: string
    description: Captured stdout, truncated at 10KB inline. Full payload at stdout_path if stdout_to_file was set.
  - name: stderr
    type: string
    description: Captured stderr, truncated at 10KB inline. Full payload at stderr_path if stderr_to_file was set.
  - name: stdout_path
    type: string
    description: Absolute path to the captured stdout file. Present only when stdout_to_file was supplied.
  - name: stderr_path
    type: string
    description: Absolute path to the captured stderr file. Present only when stderr_to_file was supplied.
  - name: duration_ms
    type: integer
    description: Wall-clock time the subprocess ran for.
  - name: timed_out
    type: boolean
    description: True when the runner sent SIGTERM due to timeout_sec being exceeded. exit_code is then 124.

invocation:
  protocol: stdin-json
  request: '{ cmd, args?, cwd?, stdin?, env?, timeout_sec?, stdout_to_file?, stderr_to_file? }'
  response: '{ exit_code, stdout, stderr, stdout_path?, stderr_path?, duration_ms, timed_out? }'
  exit_codes:
    0: command ran and exited 0 (success)
    2: bad input (missing cmd, invalid JSON, non-string args)
    124: command exceeded timeout_sec and was killed
    126: command could not be spawned (not found, not executable)
    "1-255": command's own non-zero exit code is passed through verbatim
---

# shell-exec

Naseej's Tier-1 escape hatch for running arbitrary subprocesses from a recipe.

## When to use

You have a script, binary, or CLI that produces a useful artefact and there is no Tier-2 adapter for it yet. Examples (anticipated):

- `signal-trend-extract.py` → produces a YAML signal-trend block for peer-brief.
- `katib build` → renders a katib recipe to PDF. (Will get a Tier-2 `katib-build` adapter once ADR-007 ships.)
- One-off `jq`, `awk`, `wc` invocations in a recipe that doesn't justify a typed adapter.

## When NOT to use

Per ADR-006 D6: when two recipes share the same `shell-exec` shape, extract a Tier-2 adapter. The catalog's `?promotion_candidate=true` query surfaces such duplication. Long-lived recipe-specific subprocess invocations are smells that the catalog is missing a typed wrapper.

Per ADR-006 D5: do not use `shell-exec` to wrap something a typed adapter already covers (`vault-write`, `channel-send-text`, etc.).

## Example

```yaml
- id: extract-trend
  component: shell-exec@1.0.0
  inputs:
    cmd: uv
    args:
      - run
      - "{{HOME}}/.claude/skills/katib/scripts/extract-signal-trend.py"
      - --as-of
      - "{{inputs.date}}"
    stdout_to_file: "{{work_dir}}/trend.yaml"
    timeout_sec: 60
```

The runner spawns `uv run ~/.claude/skills/katib/scripts/extract-signal-trend.py --as-of 2026-05-17`, captures stdout into `~/.soul-hub/data/naseej/runs/<run_id>/trend.yaml`, and exposes `outputs.stdout_path` for the next step to read.

## Failure modes

- **Bad input (exit 2)** — `cmd` missing or non-string; `args` not a string array; stdin not JSON. Component refuses before spawning.
- **Spawn failure (exit 126)** — `cmd` not on PATH, not executable, or EACCES. `stderr` includes the spawn error message.
- **Timeout (exit 124)** — `timeout_sec` exceeded; SIGTERM sent, then SIGKILL after 5s grace. `outputs.timed_out: true`.
- **Command failure (exit N where 1 ≤ N ≤ 255)** — the wrapped command's exit code is passed through verbatim. The Naseej runner halts the recipe at this step (per `runner.ts:491` halt-on-non-zero behaviour). Use `cwd`, `env`, and `stdin` to set up the command's environment; surface non-zero as a recipe-author-controlled failure.

## Security

`shell-exec` runs commands directly via `child_process.spawn` (no shell, no `/bin/sh -c`). Arguments are not interpreted: there is no risk of shell-metacharacter injection in `args`. `cmd` is resolved via PATH; ensure the executable is trustworthy. The `env` input lets recipes layer environment variables on top of the runner's environment — do not pass secrets through recipe YAML; export them in the shell that runs soul-hub.
