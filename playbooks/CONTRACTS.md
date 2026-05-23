# Playbook Contracts

The specification for building Soul Hub playbooks — multi-agent orchestration units that coordinate AI roles through typed phases.

## 1. Playbook YAML Schema

Every playbook lives in `playbooks/<name>/playbook.yaml`.

```yaml
name: Human-readable Name
type: playbook                    # REQUIRED — always "playbook"
description: What this playbook does

# ─── Prerequisites (optional) ───
prerequisites:
  - name: tool-name               # e.g. claude, python3, eslint
    check: "which tool-name"      # shell command — exit 0 = available
    install: "How to install"     # shown to user when missing
    required: true                # false = optional enhancement

# ─── Hooks (optional) ───
hooks:
  pre_run:                        # run before any phase
    - id: hook-name
      run: "python3 hooks/script.py $inputs.X"
      output: result.json         # JSON output for engine to parse
      timeout: 30                 # seconds, default 30
  post_run: []                    # run after all phases

timeout_strategy: auto            # auto = use hook output | static (default)

# ─── Inputs ───
inputs:
  - id: input_name
    type: text                    # text | string | number | file | path | select
    description: What to provide
    required: true
    default: ""                   # optional default
    options: [a, b, c]            # only for type: select

# ─── Roles ───
roles:
  - id: role-name                 # unique ID, kebab-case
    provider: claude              # claude | codex
    model: sonnet                 # sonnet | opus | haiku (claude) | codex-mini (codex)
    agent: roles/role-name.md     # role definition file (relative to playbook dir)
    skills: [skill-name]          # Claude Code skills to preload (optional)
    mcp: [server-name]            # MCP servers to enable (optional)

# ─── Phases ───
phases:
  - id: phase-name                # unique ID, kebab-case
    type: parallel                # see Phase Types below
    depends_on: [other-phase]     # phases that must complete first
    assignments:
      - role: role-name           # must match a role ID
        task: "Prompt for the agent. Supports $inputs.X variables."
        input: path/to/file.md    # file or variable ref: $phases.X.Y
        output: output-file.md    # relative to run's phase output dir

# ─── Output ───
output:
  type: artifact                  # see Output Types below
  file: main-output.md            # primary output file
  vault_capture: true             # save run summary to vault (default true)
  on_complete:
    notify: true                  # send notification
    next: another-playbook        # suggest next playbook
```

## 2. Phase Types

| Type | Behavior | Use When |
|------|----------|----------|
| `sequential` | Assignments run one after another | Steps depend on prior output |
| `parallel` | All assignments run concurrently | Independent perspectives on same data |
| `handoff` | Two roles alternate until convergence | Iterative refinement (architect + reviewer) |
| `gate` | Pauses for human approval before continuing | Quality checkpoints, risky deployments |
| `human` | Pauses for human input (text response) | Decisions only a human can make |
| `consensus` | Multiple agents must agree | High-stakes decisions |

### Phase-Specific Fields

**skip_if (any phase type):**
```yaml
- id: critic-review
  type: sequential
  depends_on: [edit]
  skip_if: "$inputs.enable_critic == false"   # skip when input toggle is off
```
Supports `==` and `!=` operators against `$inputs.X` values. When skipped, downstream phases that depend on it still run (the skipped phase's outputs just won't be available).

**handoff:**
```yaml
- id: refine
  type: handoff
  between: [architect, reviewer]    # two roles that alternate
  loop_until: "approved"            # condition to stop
  max_iterations: 3                 # safety limit (default 3, max 10)
```

**gate:**
```yaml
- id: approval
  type: gate
  depends_on: [design]
  assignments:
    - role: architect
      task: "Summarize for review"
      output: summary.md
```

**human:**
```yaml
- id: user-decision
  type: human
  prompt: "Which approach do you prefer?"
  timeout: "72h"
  on_timeout: skip                  # skip | cancel | use_default | notify_again
```

## 3. Role Definition Files

Each role has a markdown file at `roles/<role-id>.md` that defines the agent's persona and instructions.

```markdown
# Role Name

## Identity
You are a [role description]. Your expertise is in [domain].

## Approach
1. First, read the input files provided
2. Then, analyze for [specific concerns]
3. Finally, write your findings

## Output Format
Write a structured report with:
- Executive summary (3 sentences max)
- Findings table (severity, location, description)
- Detailed findings with code context
- Recommendations

## Rules
- Focus only on [your domain] — don't comment on other areas
- If you find nothing, say so clearly — don't invent issues
- Include file paths and line numbers for every finding
```

### Role Rules

1. **One file per role** — `roles/<role-id>.md`
2. **Self-contained** — don't reference external docs the agent can't access
3. **Structured output** — specify the exact format you want
4. **Constrained scope** — tell the agent what NOT to do
5. **0-findings guidance** — what to do when nothing is found (prevents unbounded search)

## 4. Hooks

Pre/post-run scripts that prepare data or clean up. Hooks run in the playbook directory.

### Hook Contract

- **Input**: `$inputs.X` variables are substituted in the `run` command
- **Output**: JSON to stdout + optional file specified by `output` field
- **Timeout**: Default 30s, max 300s
- **Exit code**: 0 = success, non-zero = hook failed (run continues unless critical)

### Hook stdout JSON Schema

```json
{
  "status": "completed",
  "findings_count": 18,
  "timeout_seconds": 1200,
  "scan_summary": {
    "files_scanned": 45,
    "total_lines": 12000
  }
}
```

The engine reads:
- `timeout_seconds` — used when `timeout_strategy: auto`
- `findings_count` — available to prompts via `$hooks.<id>.findings_count`

### Hook File Output

Reports saved to `hooks/output/<id>-report.md` are injected as agent context.

### Dynamic Timeout Formula

When `timeout_strategy: auto`, the scan-target hook should calculate:
```python
timeout = min(600 + files * 40 + total_lines / 1000 * 90, 1800)
# Minimum 600s (10min), max 1800s (30min)
```

## 5. Output Types

| Type | Where it goes | Example |
|------|--------------|---------|
| `artifact` | `playbooks/<name>/output/<runId>/` | Review reports, designs |
| `knowledge` | Vault zone (via vault_capture) | Decisions, learnings |
| `project` | `~/dev/<target>/` | Generated code |
| `media` | Vault media library | Images, diagrams |
| `composite` | Multiple targets | Mix of above |

### Composite Output

```yaml
output:
  type: composite
  vault_capture: true
  items:
    - type: artifact
      file: summary.md
    - type: knowledge
      file: architecture.md
      vault_zone: knowledge/decisions
```

## 6. Input Variable References

Variables resolve at runtime in `task`, `run`, and `input` fields:

| Reference | Resolves to |
|-----------|-------------|
| `$inputs.X` | User-provided input value |
| `$phases.X.Y` | Output file from phase X, assignment output Y |
| `$hooks.X.field` | JSON field from hook X output |

## 7. Folder Structure

```
playbooks/
  <playbook-name>/
    playbook.yaml          # REQUIRED — playbook specification
    roles/                 # REQUIRED — one .md per role
      role-name.md
    hooks/                 # optional — pre/post scripts
      scan-target.py
      hooks/output/        # hook report outputs (gitignored)
    output/                # run outputs (gitignored, per runId)
      <runId>/
        context/           # shared workspace
        outputs/           # phase outputs
          <phase>/
            output-file.md
```

## 8. Prerequisites

Declare external tools the playbook needs. The UI checks these before allowing a run.

```yaml
prerequisites:
  - name: claude
    check: "which claude"
    install: "Install Claude Code CLI"
    required: true          # blocks run if missing
  - name: eslint
    check: "which eslint"
    install: "npm i -g eslint"
    required: false         # optional — enhances but doesn't block
```

### Rules
- `check` must be a fast command (< 5s timeout)
- `required: true` (default) — run button disabled if missing
- `required: false` — shown as warning, run allowed

## 9. Provider Configuration

### Claude (default)
```yaml
roles:
  - id: reviewer
    provider: claude
    model: sonnet           # sonnet (default) | opus | haiku
    agent: roles/reviewer.md
    skills: [code-review]   # Claude Code skills
    mcp: [gitnexus]         # MCP servers (NOT recommended for headless — see note)
```

**Note on MCP**: Headless agents use `--strict-mcp-config` to isolate from user MCP servers. Only declare MCP servers that don't require interactive auth.

### Codex
```yaml
roles:
  - id: fixer
    provider: codex
    model: codex-mini
    agent: roles/fixer.md
    reasoning: medium       # low | medium | high | xhigh
    sandbox: networking     # codex sandbox type
```

## 10. Anti-Patterns

| Don't | Do Instead |
|-------|-----------|
| Write playbook.yaml from scratch | Copy from `_templates/<type>/playbook.yaml` |
| Write role .md from scratch | Copy from `_templates/<type>/roles/` |
| Put all logic in one sequential phase | Use parallel for independent work, sequential for dependencies |
| Give agents raw files without analysis | Add pre_run hooks that produce structured reports |
| Use `model: claude-sonnet-4` | Use aliases: `sonnet`, `opus`, `haiku` |
| Leave timeout_strategy as static | Use `auto` with a scan-target hook for variable workloads |
| Skip prerequisites | Declare all external tools (claude, python3, etc.) |
| Skip output declarations | Every playbook needs an `output:` section |
| Hardcode file paths in tasks | Use `$inputs.X` and `$phases.X.Y` references |
| Create roles without scope constraints | Tell agents what NOT to do — prevents scope creep |
| Skip 0-findings guidance in role .md | Agent will do 20min manual review if not constrained |
| Use MCP servers requiring auth | Headless agents can't do interactive auth |
| Skip `depends_on` between phases | Phases without deps may run in wrong order |
| Put output files outside `output/` | All outputs must be in the playbook's output directory |

## 11. Vault Integration

### Auto-Capture
Every completed run automatically saves a summary to the vault at `projects/<playbook>/outputs/`. The summary includes:
- Run metadata (ID, duration, status)
- Phase results table
- Role assignments
- Output landing results

### Manual Vault Zones
Use the `vault_zone` field in output items to route specific outputs. **Always use the full zone path** — bare names like `decisions` create top-level folders outside the vault structure.

| vault_zone | Note type (auto) | Purpose |
|-----------|-------------------|---------|
| `content` | `draft` | Published content, articles, posts |
| `knowledge/research` | `research` | Research briefs, analysis |
| `knowledge/decisions` | `decision` | Architecture decisions, design choices |
| `knowledge/learnings` | `learning` | Insights discovered during the run |
| `knowledge/debugging` | `debugging` | Bug investigation results |
| `knowledge/patterns` | `pattern` | Patterns and best practices |

**Valid top-level vault zones**: `inbox`, `projects`, `knowledge`, `content`, `operations`, `archive`. Never create new top-level zones — use subfolders under these.

## 12. Templates

Available in `playbooks/_templates/`:

| Template | Phases | Pattern |
|----------|--------|---------|
| `code-review` | parallel review + sequential consolidate | 3 parallel reviewers, consolidation |
| `solution-design` | parallel research + sequential design + gate | Research, design, human approval |
| `bug-investigation` | parallel investigate + sequential diagnose + gate | Multi-angle debugging |
| `architecture-review` | handoff (architect + reviewer) | Iterative refinement loop |
| `content-creation` | research + draft + handoff edit + gate | Content pipeline |

### Creating from Template
```bash
cp -r playbooks/_templates/code-review playbooks/my-review
# Edit playbook.yaml — change name, roles, tasks
# Edit roles/*.md — customize agent instructions
```

## 13. Playbook Chains

Chain multiple playbooks into a DAG. See `playbook-chain.yaml` schema:

```yaml
name: Full Review Pipeline
type: playbook-chain
description: Design → Review → Fix

inputs:
  - name: target
    type: text
    required: true

nodes:
  - id: design
    playbook: solution-design
    inputs:
      problem_statement: $inputs.target
  - id: review
    playbook: code-review
    inputs:
      target_files: $nodes.design.output
    depends_on: [design]
```
