---
name: influencer-scanner
type: script
runtime: python
description: Fetch posts from tracked influencers across social platforms
author: jasem
version: 1.0.0

inputs:
  - name: roster_file
    type: file
    format: markdown-table
    description: Influencer roster with handle, platform, focus columns
    default: config/influencer-roster.md

outputs:
  - name: status
    type: json
    description: Summary of posts collected
  - name: posts
    type: db-table
    table: posts
    description: Ingested posts in SQLite

config:
  - name: lookback_days
    type: number
    default: 3
    min: 1
    max: 30
    label: Lookback days
    description: How many days back to fetch posts per influencer
  - name: platforms
    type: multiselect
    options: [tiktok, youtube, twitter, linkedin, reddit]
    default: [tiktok, youtube, twitter, linkedin]
    label: Platforms
    description: Which social platforms to fetch from
  - name: skip_comments
    type: toggle
    default: false
    label: Skip comments
    description: Skip fetching YouTube comments
  - name: skip_transcripts
    type: toggle
    default: false
    label: Skip transcripts
    description: Skip fetching YouTube transcripts

env:
  - name: APIDIRECT_API_KEY
    description: Social media API key
    required: true
  - name: YOUTUBE_API_KEY
    description: YouTube Data API key
    required: true

data:
  requires: [influencers]
  produces: [posts, comments]
  database: signals.db
---

# Influencer Scanner

Fetches daily posts from tracked influencers. Pure Python, no AI cost.

## How it works
1. Reads influencer roster (markdown table)
2. For each influencer, fetches posts via social_collector.py
3. Deduplicates and bulk-inserts into SQLite
4. Fetches YouTube transcripts (if available)
5. Fetches comments from supported platforms

## Files
- `run.py` — main script
- `BLOCK.md` — this manifest
