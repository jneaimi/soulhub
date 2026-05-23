---
name: AGENT_NAME
type: agent
model: sonnet
description: DESCRIPTION
author: jasem
version: 1.0.0

inputs:
  - name: INPUT_NAME
    type: file
    format: json
    description: INPUT_DESCRIPTION

outputs:
  - name: OUTPUT_NAME
    type: file
    format: markdown
    description: OUTPUT_DESCRIPTION

config:
  - name: PARAM_NAME
    type: text
    label: PARAM_LABEL
    description: PARAM_DESCRIPTION
    default: DEFAULT_VALUE
    required: true

env: []

data: {}
---

# AGENT_NAME

DESCRIPTION — what this agent does and when to use it.

## Vault Integration

Pipeline outputs are **automatically captured** to the vault as notes in `projects/{pipeline}/outputs/`. No code needed for standard outputs.

If this agent discovers reusable patterns, surprising behavior, or makes architecture decisions during analysis, save them to the vault:
- Patterns → `patterns/` zone
- Learnings → `projects/{pipeline}/learnings/`
- Decisions → `projects/{pipeline}/decisions/`
- Debugging notes → `projects/{pipeline}/debugging/`

See CONTRACTS.md § 6 "Vault-Aware Blocks" for the API call.
