---
name: action-generator
type: script
runtime: python
description: Generate daily/weekly action notes from pipeline outputs and inject into task board
author: jasem
version: 1.0.0

inputs:
  - name: pipeline_outputs
    type: file
    format: directory
    description: Pipeline output directory containing reports, drafts, and seeds

outputs:
  - name: action_file
    type: file
    format: markdown
    description: Generated action note with prioritized tasks
  - name: status
    type: json
    description: Summary of generated actions

config:
  - name: mode
    type: select
    options: [daily, weekly]
    default: daily
    label: Mode
    description: Generate daily actions or weekly review
  - name: date
    type: text
    default: ""
    label: Date override
    description: Override date (YYYY-MM-DD), defaults to today
  - name: no_inject
    type: toggle
    default: false
    label: Skip task board
    description: Skip injecting actions into the weekly task board

env: []

data:
  requires: [findings]
  produces: []
  database: signals.db
---

# Action Generator

Reads pipeline outputs (content menu, drafts, seeds, strategist brief) and produces prioritized action notes. Optionally injects into the weekly task board.

## How it works
1. Reads active platforms from content-forge config
2. Finds today's drafts, backlog, and seeds
3. Generates a prioritized action list (HOT > WARM > backlog)
4. Writes action markdown to output directory
5. Injects a section into the weekly task board (optional)

## Files
- `run.py` — main script
- `BLOCK.md` — this manifest
