# Soul Hub Builder Contracts

## 1. Input Contract

### Config Files
- Location: `config/*.json`
- Schema defined in `pipeline.yaml` under `shared_config[].columns`
- Column types: `text`, `select`, `number`
- Read at runtime via `BLOCK_CONFIG_*` env vars or `json_config.py` component

### Runtime Parameters (BLOCK_CONFIG_*)
- Each `config` field in BLOCK.md maps to `BLOCK_CONFIG_<UPPER_NAME>`
- Types: `text`, `number`, `select`, `multiselect`, `toggle`, `file`, `textarea`
- Set by runner before block execution

### Pipeline Inputs (PIPELINE_INPUT)
- Declared in `pipeline.yaml` under `inputs`
- Passed as env var `PIPELINE_INPUT` (file path or value)
- Types: `text`, `number`, `select`, `file`

### Secrets (env)
- Declared in BLOCK.md under `env:`
- Values from platform environment, never hardcoded
- `required: true` blocks execution if missing

## 2. Output Contract

### File Outputs
- Written to `PIPELINE_OUTPUT` env var path
- `format` field in BLOCK.md determines UI renderer

| Format | Renderer |
|--------|----------|
| `json` | JSON viewer |
| `markdown` | Markdown preview |
| `csv` | Table view |
| `image/png` | Image viewer |
| `image/jpg` | Image viewer |
| `image/svg` | SVG inline |
| `video/mp4` | Video player |
| `audio/mp3` | Audio player |
| `pdf` | PDF viewer |
| `html` | HTML iframe |
| `text` | Plain text |

### Action Outputs
- Non-file side effects declared in BLOCK.md `outputs` with `type: action`

| Action | Description |
|--------|-------------|
| `log` | Append to log file |
| `channel` | Post to channel/webhook |
| `db-write` | Write rows to SQLite |
| `api-push` | Push to external API |
| `webhook` | Fire outbound webhook |

### Output Declaration in BLOCK.md
```yaml
outputs:
  - name: report
    type: file
    format: markdown
    description: Weekly summary report
  - name: notify
    type: action
    action: channel
    description: Post summary to Slack
```

## 3. Storage Contract

### SQLite
- Path: `db/data.db`
- Schema: `db/schema.sql` (applied on first run via `db_init.py`)
- One DB per pipeline, blocks share it

### Config
- Path: `config/*.json`
- Must be JSON with columns defined in `pipeline.yaml`
- Editable via UI (SharedConfigEditor)

### Output
- Path: `output/`
- Each step writes to `output/<step-id>-result.<ext>`
- Created at runtime, not committed

### Temp
- Path: `/tmp/pipeline-runs/<run-id>/`
- Cleared after run completes

## 4. Manifest Contract (BLOCK.md)

### Required Fields
```yaml
name: string          # unique block identifier
type: script|agent    # execution type
description: string   # one-line summary
```

### Optional Fields
```yaml
runtime: python|node  # for script blocks
author: string
version: semver
model: sonnet|opus|haiku  # for agent blocks
```

### Config Field Types
| Type | Widget | Value |
|------|--------|-------|
| `text` | Text input | string |
| `number` | Number input | number (min/max) |
| `select` | Dropdown | string (from options) |
| `multiselect` | Multi-checkbox | string[] (from options) |
| `toggle` | Switch | boolean |
| `file` | File picker | path string |
| `textarea` | Text area | string |

### Output Format Declarations
Every block MUST declare its outputs in BLOCK.md:
```yaml
outputs:
  - name: output_name
    type: file|action|db-table
    format: json|markdown|csv|...  # for type: file
    action: log|channel|...        # for type: action
    table: table_name              # for type: db-table
    description: what this output is
```

### Env Declarations
```yaml
env:
  - name: ENV_VAR_NAME
    description: what it's for
    required: true|false
```

## 5. Pipeline YAML Contract

### Required Sections
```yaml
name: string
description: string
steps: [...]
```

### Optional Sections
```yaml
version: semver
env: [...]
inputs: [...]
shared_config: [...]
on_failure: { strategy: halt|continue|retry }
```

### shared_config with Columns
```yaml
shared_config:
  - name: Display Name
    file: config/data.json
    description: what this config controls
    columns:
      - name: field_name
        type: text|select|number
        label: Human Label
        placeholder: "hint"
        required: true
        options: [a, b]  # select only
```

### Step Types Whitelist
Only valid types: `script`, `agent`, `approval`, `prompt`, `channel`

### Conditional Execution
Steps support `when:` and `skip_if:` for conditional branching:

```yaml
steps:
  - id: daily-scan
    type: script
    block: catalog/scanner
    when: $inputs.mode == "daily"       # only runs if mode is "daily"

  - id: weekly-report
    type: agent
    block: catalog/strategist
    when: $inputs.mode == "weekly"      # only runs if mode is "weekly"

  - id: notify
    type: script
    block: catalog/notifier
    skip_if: $steps.daily-scan.output contains "error"  # skip on error
    depends_on: [daily-scan]
```

**Operators:** `==`, `!=`, `contains`, `not_contains`
**References:** `$inputs.<name>`, `$steps.<id>.output`
**Behavior:** Skipped steps get status `skipped` with reason. Downstream steps referencing a skipped step's output receive an empty string.

### Output Paths
Each step should declare its output path:
```yaml
steps:
  - id: step-id
    block: block-name
    output: output/step-id-result.json
    timeout: 300
```

## 6. Vault Contract

### Automatic Capture (zero-config)
The pipeline runner automatically saves outputs to the vault — **no block code needed:**

| What | When | Default Zone | Tags |
|------|------|-------------|------|
| Step output | Each step completes | `projects/{pipelineName}/outputs` | `['pipeline', pipelineName, stepId]` |
| Run summary | Pipeline completes (success or failure) | `projects/{pipelineName}/outputs` | `['pipeline', 'run-summary', pipelineName]` |

**How it works:**
- Runner reads each step's output file from `output/`
- Wraps it in a markdown vault note with frontmatter
- JSON → ```json code block, Markdown → as-is, Binary → file reference, Other → ``` code block
- Failures are non-blocking — vault errors never break a pipeline

**Auto-applied metadata:**
```yaml
type: <derived from zone>   # See zone-to-type table below
created: YYYY-MM-DD
tags: [pipeline, <pipeline-name>, <step-id>]
project: <pipeline-name>
pipeline: <pipeline-name>
run_id: <full-run-id>
step: <step-id>
output_type: <file|media|action|response|webhook>
```

### Vault Zone Routing (optional)
Steps can declare `vault_zone` to route outputs to semantic vault zones instead of the default `projects/{name}/outputs`:

```yaml
steps:
  - id: research
    type: agent
    block: researcher
    output: output/research.md
    vault_zone: knowledge/research    # Lands as type: research

  - id: analysis
    type: agent
    block: analyst
    output: output/analysis.md
    vault_zone: knowledge/decisions   # Lands as type: decision
```

### Zone-to-Type Mapping
The note `type` is automatically derived from the vault zone:

| vault_zone | Note type | Purpose |
|-----------|-----------|---------|
| `content` | `draft` | Published content, articles, posts |
| `knowledge/research` | `research` | Research briefs, analysis |
| `knowledge/decisions` | `decision` | Architecture decisions, design choices |
| `knowledge/learnings` | `learning` | Insights and retrospectives |
| `knowledge/debugging` | `debugging` | Bug investigations |
| `knowledge/patterns` | `pattern` | Patterns and best practices |
| `projects/*/outputs` | `output` | Default — pipeline run outputs |

**Valid top-level vault zones**: `inbox`, `projects`, `knowledge`, `content`, `operations`, `archive`. Never create new top-level zones.

### Raw Output Files
Raw files stay in `output/` inside the pipeline directory — browsable through the vault's "Pipeline Outputs" tab. The vault note is a processed copy; both exist.

### Vault-Aware Blocks (optional)
Blocks can write directly to the vault API for richer knowledge capture:

```python
import json, urllib.request

def save_to_vault(zone, filename, meta, content):
    """Save a note to the vault. Best-effort — failures don't break the block."""
    try:
        data = json.dumps({"zone": zone, "filename": filename, "meta": meta, "content": content}).encode()
        req = urllib.request.Request(
            "http://localhost:2400/api/vault/notes",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass
```

**Use vault-aware blocks when:**
- Saving structured findings (not just raw output)
- Creating decision records or learnings from analysis
- Writing reports that need different tags than auto-capture provides

**Let auto-capture handle it when:**
- Standard step outputs (JSON, CSV, markdown)
- Run summaries
- Output just needs to be stored and browsable

### Project Scaffolding
When a project is registered, the vault auto-creates:
```
~/vault/projects/{name}/
├── CLAUDE.md          # Zone governance (allowed types, required fields)
├── index.md           # Project index note
├── decisions/         # Architecture decision records
├── learnings/         # Insights and gotchas
├── debugging/         # Bug investigations
└── outputs/           # Auto-captured pipeline outputs
```
