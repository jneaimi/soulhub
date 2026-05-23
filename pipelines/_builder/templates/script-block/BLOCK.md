---
name: BLOCK_NAME
type: script
runtime: python
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
    format: json
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

# BLOCK_NAME

DESCRIPTION — what this block does, when to use it, and how it fits into a pipeline.

## Vault Integration

Pipeline outputs are **automatically captured** to the vault as notes in `projects/{pipeline}/outputs/`. No code needed for standard outputs.

If this block produces structured knowledge (findings, decisions, learnings) beyond its raw output, it can optionally write directly to the vault API — see CONTRACTS.md § 6 "Vault-Aware Blocks".
