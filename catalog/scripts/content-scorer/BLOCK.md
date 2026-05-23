---
name: content-scorer
type: script
runtime: python
description: Score and classify findings into HOT/WARM/SEED tiers for content generation
author: jasem
version: 1.0.0

inputs:
  - name: database
    type: file
    format: sqlite
    description: SQLite database with findings and market scores
  - name: brand_assets
    type: file
    format: markdown
    description: Brand assets file for CTA matching
    default: config/brand-assets.md

outputs:
  - name: status
    type: json
    description: Summary of scored findings
  - name: content_prep
    type: file
    description: Markdown prep file with scored and enriched findings

config:
  - name: hot_threshold
    type: number
    default: 20
    min: 10
    max: 30
    label: HOT threshold
    description: Minimum score for HOT tier classification
  - name: max_hot
    type: number
    default: 3
    min: 1
    max: 10
    label: Max HOT items
    description: Maximum number of HOT items to include
  - name: max_warm
    type: number
    default: 2
    min: 0
    max: 10
    label: Max WARM items
    description: Maximum number of WARM items to include
  - name: lookback_days
    type: number
    default: 1
    min: 1
    max: 14
    label: Lookback days
    description: How many days of findings to score

env: []

data:
  requires: [findings, market_scores, posts, comments, market_signals]
  produces: []
  database: signals.db
---

# Content Scorer

Scores and classifies findings into content tiers. Pure Python, no AI cost.

## How it works
1. Reads findings from DB (within lookback window)
2. Deduplicates by title similarity (60% word overlap)
3. Scores each finding: signal strength, GCC relevance, sources, pillar, opportunity
4. Classifies: HOT (>= threshold), WARM (>= 12), SEED (rest)
5. Enriches with audience comments, transcript quotes, market signals
6. Matches brand assets for CTA suggestions
7. Outputs structured content prep markdown

## Files
- `run.py` — main script
- `BLOCK.md` — this manifest
