---
name: report-parser
type: script
runtime: python
description: Parse Miner markdown reports and insert findings, scores, and opportunities into the DB
author: jasem
version: 1.0.0

inputs:
  - name: report
    type: file
    format: markdown
    description: Path to Miner report markdown file

outputs:
  - name: status
    type: json
    description: Summary of parsed findings, opportunities, and GCC relevance

config:
  - name: run_mode
    type: select
    options: [daily, weekly]
    default: daily
    label: Run mode
    description: Whether this is a daily or weekly analysis run

env: []

data:
  requires: [analysis_runs]
  produces: [findings, market_scores, opportunities]
  database: signals.db
---

# Report Parser

Parses Miner markdown reports and inserts structured findings into the intelligence DB. Bridges the gap between AI-generated markdown reports and structured data.

## How it works
1. Reads a Miner report markdown file
2. Extracts trending topics from ### headers
3. Extracts pain points from tables or ### sections
4. Extracts content opportunities
5. Evaluates GCC relevance
6. Inserts all findings, market scores, and opportunities into SQLite

## Files
- `run.py` — main script
- `BLOCK.md` — this manifest
