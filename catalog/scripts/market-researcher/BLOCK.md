---
name: market-researcher
type: script
runtime: python
description: Search market signals for trending topics across social platforms
author: jasem
version: 1.0.0

inputs:
  - name: miner_report
    type: file
    format: markdown
    description: Latest Miner report to extract trending topics from
  - name: config_file
    type: file
    format: markdown
    description: Prospector config with mode, platforms, pinned topic
    default: config/prospector-config.md

outputs:
  - name: status
    type: json
    description: Summary of searches and signals collected
  - name: signals
    type: db-table
    table: market_signals
    description: Market signals in SQLite

config:
  - name: max_topics
    type: number
    default: 2
    min: 1
    max: 10
    label: Max topics
    description: Maximum number of topics to research
  - name: platforms
    type: multiselect
    options: [twitter, reddit, youtube, linkedin, news, forums]
    default: [twitter, reddit, youtube, linkedin, news, forums]
    label: Platforms
    description: Which platforms to search for signals
  - name: pinned_topic
    type: text
    default: ""
    label: Pinned topic
    description: Always-included topic (added even if not in Miner report)
  - name: include_arabic_search
    type: toggle
    default: true
    label: Include Arabic search
    description: Generate Arabic search queries alongside English

env:
  - name: APIDIRECT_API_KEY
    description: Social media API key
    required: true
  - name: YOUTUBE_API_KEY
    description: YouTube Data API key
    required: true

data:
  requires: [findings]
  produces: [market_signals, market_searches]
  database: signals.db
---

# Market Researcher

Searches trending topics across social platforms. Pure Python, no AI cost.

## How it works
1. Reads topics from Miner report (or manual topic)
2. Generates EN + AR search queries per topic
3. Fetches results from each platform via social_collector.py
4. Deduplicates and stores market signals in SQLite

## Files
- `run.py` — main script
- `BLOCK.md` — this manifest
