# Playbook Builder

You are building Soul Hub playbooks — multi-agent orchestration units.

## Contracts

Read `CONTRACTS.md` for the full specification of all schemas, phase types, hooks, and output routing.

## Critical Rules

### 1. Templates First
Always start from `_templates/`. Copy the closest template and modify — never write from scratch.

| Building | Copy from |
|----------|-----------|
| Parallel review with hooks | `_templates/code-review/` |
| Content pipeline with human feedback | `_templates/content-creation/` |
| Research + design + gate | `_templates/solution-design/` |
| Iterative refinement (handoff) | `_templates/architecture-review/` |
| Multi-angle investigation | `_templates/bug-investigation/` |

### 2. Think Like a Professional
Before designing phases, ask: **how would a real professional team do this job?**

| Business process | Playbook pattern |
|-----------------|------------------|
| Independent experts reviewing the same thing | `parallel` phase (code-review) |
| One person hands off to the next | `sequential` phase |
| Two people iterate until they agree | `handoff` phase (architecture-review) |
| Boss needs to approve before continuing | `gate` phase |
| Need human judgment or creative direction | `human` phase → revision → gate |
| Fast pre-work before the experts arrive | `pre_run hooks` |

### 3. Pre-Run Hooks: Tools Before Judgment
Real professionals use tools first, expert judgment second:
- **Code review**: Static analyzers scan → reviewers verify findings
- **Content creation**: Signal search + brand context loaded → writer uses them
- **Security audit**: Automated scanner → auditor reviews results

Hooks run in milliseconds. Agents take minutes. Always front-load what can be automated.

### 4. Human Feedback Loop
When a human needs to provide feedback (not just approve/reject):

```yaml
# Phase N: human reviews and types feedback
- id: review
  type: human
  depends_on: [prior-phase]
  prompt: "Review the draft. Type feedback or 'approved'."
  assignments:
    - role: presenter-role
      task: "Prepare the work for human review"
      output: review-package.md

# Phase N+1: agent incorporates human feedback
- id: revise
  type: sequential
  depends_on: [review]
  assignments:
    - role: worker-role
      task: "Apply the human's feedback"
      input: $phases.review.human-response
      output: revised.md

# Phase N+2: final yes/no
- id: approve
  type: gate
  depends_on: [revise]
```

This gives users one round of feedback + final approval. Gate reject = run fails (user can troubleshoot or run again).

### 5. Brand Voice & Anti-Slop (Content Playbooks)
Any content playbook should:
- Accept `brand_voice` as an optional text input (empty = sensible default)
- Load anti-slop rules via hook (see `_templates/content-creation/hooks/load-brand-context.py`)
- Inject brand context into writer AND editor roles
- Editor must check anti-slop compliance before approving

Anti-slop list is in the hook — never hardcode it in role files.

### 6. Prerequisites
Declare all external dependencies. Types:

| Type | Check | Required? |
|------|-------|-----------|
| CLI tool | `which claude` | `true` — blocks run |
| Python | `which python3` | `true` — blocks run if hooks need it |
| API key | `test -n "$API_KEY"` | `false` — enhances but doesn't block |
| npm package | `which eslint` | depends on playbook |

API keys as `required: false` show as warnings on the detail page with install instructions.

### 7. Model Aliases Only
Use `sonnet`, `opus`, `haiku` — never `claude-sonnet-4` or full model IDs.

### 8. Constrain Agents on 0 Findings
Every role .md must include guidance for when there's nothing to find. Without this, agents do 20+ minute unbounded searches.

### 9. Output Path First in Prompts
The engine puts the output file path at the start of every agent prompt. Don't repeat it in the task field.

### 10. Folder Structure
```
playbooks/<name>/
  playbook.yaml       # spec
  roles/*.md           # one per role
  hooks/*.py           # optional pre/post scripts
  hooks/output/        # hook reports (gitignored)
  output/              # run outputs (gitignored)
```

### 11. Variable References
- `$inputs.X` — user input
- `$phases.X.Y` — output from phase X, file Y
- `$hooks.X.field` — hook JSON output field

### 12. MCP Servers
Headless agents use `--strict-mcp-config` — they can't access user MCP servers or do interactive auth. Only declare MCP servers that work without auth.

### 13. Test Both Paths
- Happy path: all agents complete, outputs land correctly
- Sad path: agent timeout, 0 findings, missing prerequisites, human rejects at gate

### 14. Vault Zone Alignment (CRITICAL)
Every `vault_zone` in output items MUST use a full path under a valid top-level zone. The engine auto-derives the note `type` from the zone.

| vault_zone | Auto type | Use for |
|------------|-----------|---------|
| `content` | `draft` | Articles, blog posts, social drafts |
| `knowledge/research` | `research` | Research briefs, analysis |
| `knowledge/decisions` | `decision` | Architecture decisions, ADRs |
| `knowledge/learnings` | `learning` | Insights, retrospectives |
| `knowledge/debugging` | `debugging` | Bug investigations |
| `knowledge/patterns` | `pattern` | Patterns and best practices |

**Never use bare names** like `decisions`, `outputs`, `debugging` — these create rogue top-level zones outside the vault structure.

**Valid top-level zones**: `inbox`, `projects`, `knowledge`, `content`, `operations`, `archive`.

**Common mistake**: Using `type: artifact` for the main deliverable. Artifacts only copy locally — add a second `type: knowledge` item with the right `vault_zone` if you want it in the vault:

```yaml
items:
  - type: artifact        # local copy
    file: final-output.md
  - type: knowledge       # vault copy
    file: final-output.md
    vault_zone: content   # or knowledge/research, etc.
```

## Pattern Reference

### Code Review (parallel + hooks)
```
hooks: scan-target, analyze-logic, analyze-security, analyze-perf
research → 3 parallel reviewers → consolidation
Each reviewer reads hook report + spot-checks
```

### Content Creation (human feedback loop)
```
hooks: gather-signals (social search), load-brand-context (voice + anti-slop)
research → draft → edit (handoff writer↔editor) → human review → revision → final gate
Brand voice as input, format-specific guidelines per content type
```

### Architecture Review (iterative handoff)
```
architect drafts → reviewer critiques → architect revises → loop until APPROVED
Max 3 iterations, gate for final human approval
```

### Bug Investigation (parallel + diagnosis)
```
3 parallel investigators (reproducer, tracer, fixer perspective)
→ sequential diagnosis combining all findings
→ gate for human to approve the fix plan
```
